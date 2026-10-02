/**
 * aiProviders.js
 *
 * One place that talks to every AI provider, with:
 *   • Groq as the default, then optional Cerebras, OpenRouter, Gemini, and Mistral fallbacks
 *   • multiple keys per provider  (GROQ_API_KEY_1, GROQ_API_KEY_2, ...)
 *   • per model health, actionable errors, and cooldowns with exponential backoff
 *   • retry once on timeout / 429 / 5xx, then move on
 *   • status reporting for /aistatus
 *
 * Public API:
 *   callAI({ messages, systemPrompt, imageData, temperature, jsonMode, maxTokens })
 *     → { text, provider, model } | null
 *   getProviderStatus() → [{ name, keys, available, cooling, until, lastError, stats }]
 */

const axios = require('axios');

const TIMEOUT = Number(process.env.AI_TIMEOUT_MS) || 15000;

/* ── Health bookkeeping ── */

const health = new Map();   // key -> { cooldownUntil, failures, lastError, lastAt, ok, totalMs }

function hkey(provider, model) {
    return `${provider}:${model || 'default'}`;
}

function isCooling(provider, model) {
    const h = health.get(hkey(provider, model));
    return !!h && h.cooldownUntil > Date.now();
}

function markOk(provider, model, ms) {
    const k = hkey(provider, model);
    const h = health.get(k) || { failures: 0, stats: { ok: 0, fail: 0, totalMs: 0 } };
    h.cooldownUntil = 0;
    h.failures = 0;
    h.lastError = null;
    h.lastAt = Date.now();
    h.stats = h.stats || { ok: 0, fail: 0, totalMs: 0 };
    h.stats.ok += 1;
    h.stats.totalMs += ms;
    health.set(k, h);
}

function errorSummary(error) {
    const responseError = error?.response?.data?.error;
    const detail = responseError?.message
        || error?.response?.data?.message
        || error?.message
        || String(error || 'unknown error');

    // Provider messages are useful for debugging, but credentials must never land in logs/status.
    const safeDetail = String(detail)
        .replace(/\b(?:gsk_[A-Za-z0-9_-]+|sk-or-v1-[A-Za-z0-9_-]+|AIzaSy[A-Za-z0-9_-]+)\b/g, '[redacted]')
        .replace(/\s+/g, ' ')
        .trim();
    const status = error?.response?.status;
    return `${status ? `HTTP ${status}: ` : ''}${safeDetail || 'unknown error'}`.slice(0, 180);
}

function markFail(provider, model, error) {
    const k = hkey(provider, model);
    const h = health.get(k) || { failures: 0, stats: { ok: 0, fail: 0, totalMs: 0 } };
    h.failures = (h.failures || 0) + 1;
    h.lastError = errorSummary(error);
    h.lastAt = Date.now();
    h.stats = h.stats || { ok: 0, fail: 0, totalMs: 0 };
    h.stats.fail += 1;

    const status = error?.response?.status;
    const isRateLimited = status === 429 || status === 402 || status === 403;
    const isServer = status >= 500
        || ['ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code);
    const isBadModelOrRequest = status === 400 || status === 404 || status === 422;

    // Cool a broken model/config combination briefly too, so one bad model does not
    // generate the same error on every Discord mention while other fallbacks run.
    if (isRateLimited || isServer || isBadModelOrRequest || !status) {
        const base = isBadModelOrRequest ? 5 * 60_000 : isRateLimited ? 60_000 : 30_000;
        const factor = Math.min(6, Math.max(1, h.failures));
        const retryAfter = Number(error?.response?.headers?.['retry-after']);
        const delay = retryAfter > 0 ? retryAfter * 1000 : base * factor;
        h.cooldownUntil = Date.now() + Math.min(delay, 30 * 60_000);
    }

    health.set(k, h);
}

/* ── Keys ── */

function keysFor(provider) {
    const out = [];
    const base = `${provider.toUpperCase()}_API_KEY`;

    if (process.env[base]) out.push(process.env[base]);

    for (let i = 1; i <= 6; i++) {
        const v = process.env[`${base}_${i}`];
        if (v && !out.includes(v)) out.push(v);
    }

    return out.filter(Boolean);
}

/* ── HTTP helpers ── */

async function post(url, body, headers = {}, extra = {}) {
    return axios.post(url, body, {
        timeout: TIMEOUT,
        headers: { 'Content-Type': 'application/json', ...headers },
        validateStatus: s => s >= 200 && s < 300,
        ...extra
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn) {
    try {
        return await fn();
    } catch (error) {
        const status = error?.response?.status;
        const retryable = status === 429 || status >= 500 || !status;
        if (!retryable) throw error;
        await sleep(600);
        return fn();
    }
}

/* ── OpenAI-compatible providers (Groq / Cerebras / OpenRouter / Mistral) ── */

async function callOpenAICompatible({ provider, baseUrl, key, model, messages, temperature, jsonMode, maxTokens }) {
    const body = { model, messages };

    if (provider === 'groq') {
        // Groq's current API uses max_completion_tokens for its reasoning models.
        // Compound is an agentic system and documents the bare model+messages request.
        if (!model.startsWith('groq/compound')) {
            body.max_completion_tokens = maxTokens || 900;
            body.temperature = temperature ?? 0.7;

            if (model.startsWith('openai/gpt-oss-')) {
                body.reasoning_effort = 'low';
                body.include_reasoning = false;
            } else if (model === 'qwen/qwen3.8-27b') {
                body.reasoning_effort = 'none';
                body.reasoning_format = 'hidden';
            }
        }
    } else {
        body.temperature = temperature ?? 0.7;
        body.max_tokens = maxTokens || 900;
    }

    if (jsonMode) body.response_format = { type: 'json_object' };

    const started = Date.now();

    const res = await withRetry(() =>
        post(
            `${baseUrl}/chat/completions`,
            body,
            {
                Authorization: `Bearer ${key}`,
                ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://discord.com', 'X-Title': 'MUMU Bot' } : {})
            }
        )
    );

    if (res.data?.error) {
        const upstreamError = new Error(res.data.error.message || 'provider returned an error');
        const upstreamStatus = Number(res.data.error.status || res.data.error.code);
        upstreamError.response = {
            status: upstreamStatus >= 400 ? upstreamStatus : undefined,
            data: res.data
        };
        throw upstreamError;
    }

    const content = res.data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
        ? content.map(part => typeof part === 'string' ? part : part?.text || '').join('').trim()
        : typeof content === 'string' ? content.trim() : '';

    if (!text) {
        const finishReason = res.data?.choices?.[0]?.finish_reason;
        throw new Error(`empty completion${finishReason ? ` (${finishReason})` : ''}`);
    }

    markOk(provider, model, Date.now() - started);

    return text;
}

/* ── Gemini ── */

async function callGemini({ key, model = 'gemini-3.8-flash', systemPrompt, messages, imageData, temperature, maxTokens }) {
    const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => {
            const parts = typeof m.content === 'string'
                ? [{ text: m.content }]
                : Array.isArray(m.content)
                    ? m.content
                        .filter(part => part?.type === 'text' && typeof part.text === 'string')
                        .map(part => ({ text: part.text }))
                    : [{ text: JSON.stringify(m.content) }];

            return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        });

    if (imageData && contents.length) {
        const lastUserContent = [...contents].reverse().find(content => content.role === 'user');
        if (lastUserContent) {
            lastUserContent.parts.push({
                inline_data: { mime_type: imageData.mimeType || 'image/png', data: imageData.data }
            });
        }
    }

    const generationConfig = { maxOutputTokens: maxTokens || 900 };
    if (model === 'gemini-3.8-flash') {
        // Gemini 3.8 rejects temperature/top-p fields; keep its thinking budget modest for chat.
        generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    } else {
        generationConfig.temperature = temperature ?? 0.7;
    }

    const body = { contents, generationConfig };
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

    const started = Date.now();

    const res = await withRetry(() =>
        post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, body)
    );

    if (res.data?.error) {
        const providerError = new Error(res.data.error.message || 'provider returned an error');
        providerError.response = { status: Number(res.data.error.code) || undefined, data: res.data };
        throw providerError;
    }

    const candidate = res.data?.candidates?.[0];
    const text = candidate?.content?.parts
        ?.filter(part => typeof part.text === 'string' && !part.thought)
        .map(part => part.text)
        .join('')
        .trim();

    if (!text) {
        const reason = res.data?.promptFeedback?.blockReason || candidate?.finishReason;
        throw new Error(`empty completion${reason ? ` (${reason})` : ''}`);
    }

    markOk('gemini', model, Date.now() - started);

    return text;
}

/* ── Provider table (order = priority) ── */

const CHAT_MODELS = {
    // Keep this list to conversational text models from the user's current Groq catalog.
    // Audio, transcription, moderation, and prompt-guard models are not chat completions.
    groq: [
        'openai/gpt-oss-20b',
        'qwen/qwen3.8-27b',
        'openai/gpt-oss-120b',
        'qwen/qwen3.6-27b',
        'groq/compound'
    ],
    cerebras: ['llama-4-scout', 'llama3.1-8b'],
    mistral: ['mistral-small-latest'],
    // OpenRouter's free catalog rotates; the free router avoids pinning retired model IDs.
    openrouter: ['openrouter/free'],
    gemini: ['gemini-3.8-flash', 'gemini-3.5-flash-lite']
};

const PROVIDERS = [
    { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', env: 'groq' },
    { name: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', env: 'cerebras' },
    { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', env: 'openrouter' },
    { name: 'gemini', env: 'gemini' },
    { name: 'mistral', baseUrl: 'https://api.mistral.ai/v1', env: 'mistral' }
];

/* ── Main entry ── */

async function callAI({
    messages,
    systemPrompt,
    imageData = null,
    temperature = 0.7,
    jsonMode = false,
    maxTokens = 900,
    skipProviders = []
} = {}) {
    if (!Array.isArray(messages) || !messages.length) return null;

    const fullMessages = systemPrompt && !messages.some(m => m.role === 'system')
        ? [{ role: 'system', content: systemPrompt }, ...messages]
        : messages;

    for (const provider of PROVIDERS) {
        if (skipProviders.includes(provider.name)) continue;

        const keys = keysFor(provider.env);

        if (!keys.length) continue;

        const models = CHAT_MODELS[provider.name] || [];

        for (const model of models) {
            const supportsVision = provider.name === 'gemini'
                || provider.name === 'openrouter'
                || (provider.name === 'groq' && model === 'qwen/qwen3.8-27b');
            if (imageData && !supportsVision) continue;
            if (isCooling(provider.name, model)) continue;

            /* Try each key once before moving to the next model */
            for (const key of keys) {
                try {
                    let text;

                    if (provider.name === 'gemini') {
                        text = await callGemini({
                            key,
                            model,
                            systemPrompt,
                            messages: fullMessages,
                            imageData,
                            temperature,
                            maxTokens
                        });
                    } else {
                        text = await callOpenAICompatible({
                            provider: provider.name,
                            baseUrl: provider.baseUrl,
                            key,
                            model,
                            messages: fullMessages,
                            temperature,
                            jsonMode,
                            maxTokens
                        });
                    }

                    if (text) return { text, provider: provider.name, model };
                } catch (error) {
                    markFail(provider.name, model, error);

                    const status = error?.response?.status;
                    console.error(`[aiProviders] ${provider.name}/${model} failed: ${errorSummary(error)}`);

                    if (status === 401 || status === 403) continue; // try the next key
                    if (isCooling(provider.name, model)) break;     // skip this model during its cooldown
                }
            }
        }
    }

    return null;
}

/* ── Status for /aistatus ── */

function getProviderStatus() {
    return PROVIDERS.map(p => {
        const keys = keysFor(p.env);
        const models = CHAT_MODELS[p.name] || [];
        const rows = models.map(m => {
            const h = health.get(hkey(p.name, m)) || {};
            return {
                model: m,
                cooling: (h.cooldownUntil || 0) > Date.now(),
                until: h.cooldownUntil || 0,
                failures: h.failures || 0,
                lastError: h.lastError || null,
                ok: h.stats?.ok || 0,
                fail: h.stats?.fail || 0,
                avgMs: h.stats?.ok ? Math.round(h.stats.totalMs / h.stats.ok) : null
            };
        });

        return {
            name: p.name,
            keys: keys.length,
            available: keys.length > 0,
            models: rows
        };
    });
}

/** Text-only convenience used by the tools/planner. */
async function askText(prompt, { systemPrompt, jsonMode = false, temperature = 0.3, maxTokens = 800 } = {}) {
    const res = await callAI({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt,
        jsonMode,
        temperature,
        maxTokens
    });

    return res ? res.text : null;
}

module.exports = {
    callAI,
    askText,
    getProviderStatus,
    keysFor,
    PROVIDERS,
    CHAT_MODELS
};
