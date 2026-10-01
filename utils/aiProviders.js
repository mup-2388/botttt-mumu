/**
 * aiProviders.js
 *
 * One place that talks to every AI provider, with:
 *   • Groq as the default, then Cerebras, OpenRouter (free ladder), Gemini, Mistral
 *   • multiple keys per provider  (GROQ_API_KEY_1, GROQ_API_KEY_2, ...)
 *   • per key+model health, cooldowns with exponential backoff
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

function markFail(provider, model, error) {
    const k = hkey(provider, model);
    const h = health.get(k) || { failures: 0, stats: { ok: 0, fail: 0, totalMs: 0 } };
    h.failures = (h.failures || 0) + 1;
    h.lastError = String(error?.response?.status || error?.code || error?.message || error).slice(0, 160);
    h.lastAt = Date.now();
    h.stats = h.stats || { ok: 0, fail: 0, totalMs: 0 };
    h.stats.fail += 1;

    // 429 / 5xx / network → back off, exponentially for repeat offenders
    const status = error?.response?.status;
    const isRate = status === 429 || status === 402 || status === 403;
    const isServer = status >= 500 || error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || error?.code === 'ENOTFOUND';

    if (isRate || isServer || !status) {
        const base = isRate ? 60_000 : 30_000;
        const factor = Math.min(6, Math.max(1, h.failures));
        h.cooldownUntil = Date.now() + Math.min(base * factor, 30 * 60_000);
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
    const body = {
        model,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens || 900
    };

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

    const text = res.data?.choices?.[0]?.message?.content;

    if (!text) throw new Error('empty completion');

    markOk(provider, model, Date.now() - started);

    return String(text).trim();
}

/* ── Gemini ── */

async function callGemini({ key, model = 'gemini-2.5-flash', systemPrompt, messages, imageData, temperature, maxTokens }) {
    const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
        }));

    if (imageData && contents.length) {
        contents[contents.length - 1].parts.push({
            inline_data: { mime_type: imageData.mimeType || 'image/png', data: imageData.data }
        });
    }

    const body = {
        contents,
        generationConfig: { temperature: temperature ?? 0.7, maxOutputTokens: maxTokens || 900 }
    };

    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

    const started = Date.now();

    const res = await withRetry(() =>
        post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, body)
    );

    const text = res.data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('');

    if (!text) throw new Error('empty completion');

    markOk('gemini', model, Date.now() - started);

    return String(text).trim();
}

/* ── Provider table (order = priority) ── */

const CHAT_MODELS = {
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    cerebras: ['llama-4-scout', 'llama3.1-8b'],
    mistral: ['mistral-small-latest'],
    openrouter: [
        'deepseek/deepseek-chat-v3-0324:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'qwen/qwen3-30b-a3b:free',
        'google/gemma-3-27b-it:free',
        'mistralai/mistral-small-3.1-24b-instruct:free'
    ]
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

        /* Vision only works on Gemini (and some OpenRouter models) */
        if (imageData && !['gemini', 'openrouter'].includes(provider.name)) continue;

        const models = CHAT_MODELS[provider.name] || [];

        for (const model of models) {
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
                    if (status === 401 || status === 403) break;   // bad key → next key

                    if (isCooling(provider.name, model)) break;    // rate limited → next model
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
