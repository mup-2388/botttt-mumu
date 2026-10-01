/**
 * utils/ai/personality.js
 *
 * Makes MUMU sound like MUMU:
 *   • who built it (and who did NOT) — the creator is never roasted
 *   • dynamic roast level derived from how the user actually talks
 *   • per-user style mimicry (their emojis, casing, slang, language)
 *   • multilingual replies (English / Hindi / Gujarati / Hinglish)
 *   • Discord formatting + mention syntax it is allowed to use
 */

const OWNER_ID = '856556430370930738';
const OWNER_NAMES = ['mumu', 'mumu_111111'];

/* ── Style profiles (in memory, per guild+user) ── */

const profiles = new Map();       // `${guildId}:${userId}` -> profile
const MAX_PROFILES = 800;

function key(guildId, userId) {
    return `${guildId}:${userId}`;
}

function getProfile(guildId, userId) {
    const k = key(guildId, userId);
    let p = profiles.get(k);

    if (!p) {
        p = {
            messages: 0,
            chars: 0,
            upperHeavy: 0,
            lowerHeavy: 0,
            emojiCount: new Map(),
            wordCount: new Map(),
            languages: new Map(),
            lastActive: 0
        };
        profiles.set(k, p);

        if (profiles.size > MAX_PROFILES) profiles.delete(profiles.keys().next().value);
    }

    return p;
}

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'it', 'its', 'this', 'that',
    'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'their', 'our', 'do', 'does', 'did', 'have', 'has', 'had', 'will',
    'would', 'can', 'could', 'should', 'not', 'no', 'yes', 'ok', 'okay', 'so', 'just', 'very'
]);

/** Learn from a user message (called for every guild message, cheap). */
function recordMessage({ guildId, userId, content }) {
    if (!guildId || !userId || !content) return;
    if (String(content).startsWith('.')) return;          // commands don't count

    const text = String(content).slice(0, 400);
    const p = getProfile(guildId, userId);

    p.messages += 1;
    p.chars += text.length;
    p.lastActive = Date.now();

    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 4) {
        const upper = letters.replace(/[^A-Z]/g, '').length / letters.length;
        if (upper > 0.6) p.upperHeavy += 1;
        if (upper < 0.1) p.lowerHeavy += 1;
    }

    /* Custom + unicode emojis */
    for (const m of text.matchAll(/<a?:(\w+):(\d+)>/g)) {
        p.emojiCount.set(m[0], (p.emojiCount.get(m[0]) || 0) + 1);
    }

    for (const m of text.matchAll(/\p{Extended_Pictographic}/gu)) {
        p.emojiCount.set(m[0], (p.emojiCount.get(m[0]) || 0) + 1);
    }

    /* Words / slang */
    for (const raw of text.toLowerCase().split(/[^a-z0-9\u0900-\u097F\u0A80-\u0AFF']+/)) {
        if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
        p.wordCount.set(raw, (p.wordCount.get(raw) || 0) + 1);
    }

    const lang = detectLanguage(text);
    p.languages.set(lang, (p.languages.get(lang) || 0) + 1);
}

function topEntries(map, n) {
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => ({ value: k, count: v }));
}

/* ── Language ── */

function detectLanguage(text) {
    const t = String(text || '');

    if (/[\u0A80-\u0AFF]/.test(t)) return 'gu';          // Gujarati script
    if (/[\u0900-\u097F]/.test(t)) return 'hi';          // Devanagari

    const hinglish = /\b(kya|kaise|kyu|kyun|hai|hain|nahi|nahin|bhai|yaar|kab|kaun|mera|meri|hum|tum|aap|acha|theek|thik|kitna|kitne|kaunsa|konsa)\b/i;
    if (hinglish.test(t)) return 'hinglish';

    const gujlish = /\b(kem|chho|chhe|nathi|su|shu|tamaru|mane|aav|jaay|kaik|kyare|kon|kya)\b/i;
    if (gujlish.test(t)) return 'gujlish';

    return 'en';
}

function languageInstruction(lang) {
    switch (lang) {
        case 'hi': return 'Reply in Hindi (Devanagari). Keep the roast natural — Hindi abuses are fine, keep it playful.';
        case 'gu': return 'Reply in Gujarati (Gujarati script). Keep it casual and funny.';
        case 'hinglish': return 'Reply in Hinglish (Hindi written in Latin script), the way Indian Discord servers talk.';
        case 'gujlish': return 'Reply in Gujlish (Gujarati in Latin script) — casual and funny.';
        default: return '';
    }
}

/* ── Dynamic roast level ── */

/**
 * off | light | medium | feral — derived from the user's own tone and history.
 */
function roastLevelFor({ userId, guildId, content }) {
    if (String(userId) === OWNER_ID) return 'medium';   // the creator can handle it

    const t = String(content || '');
    const p = getProfile(guildId, userId);

    let score = 2;   // baseline: light-medium

    if (/\b(lol|lmao|lmfao|xd|haha|lolz)\b/i.test(t)) score += 1;
    if (/\b(bro|bruh|dude|buddy|mate)\b/i.test(t)) score += 1;
    if (/\p{Extended_Pictographic}|<a?:\w+:\d+>/u.test(t)) score += 1;
    if (/\b(fuck|fck|shit|bitch|ass|chutiya|bkl|mc|bc|gandu|madarchod|behenchod)\b/i.test(t)) score += 2;
    if (/[A-Z]{6,}/.test(t)) score += 1;               // SHOUTING
    if (/\b(please|sorry|thank|thanks|pls)\b/i.test(t)) score -= 1;
    if (/\b(help|problem|issue|error|bug)\b/i.test(t)) score -= 1;
    if (/\b(sad|depressed|tired|sick|hospital|family)\b/i.test(t)) score -= 3;

    const avgLen = p.messages ? p.chars / p.messages : 0;
    if (avgLen > 90) score += 1;                        // long talker → likes banter

    if (score <= 0) return 'off';
    if (score <= 2) return 'light';
    if (score <= 4) return 'medium';
    return 'feral';
}

const ROAST_RULES = {
    off: 'Do NOT roast this person at all this time. Be warm, helpful and normal. Zero jabs.',
    light:
        'Roast level LIGHT: at most one tiny playful jab, and only if it fits naturally. ' +
        'If the message is a genuine question, answer first — the joke is optional seasoning.',
    medium:
        'Roast level MEDIUM: one or two friendly jabs about the football take, the team, their luck or their typo. ' +
        'Punchy and funny, never personal.',
    feral:
        'Roast level FERAL: go hard but stay playful — football takes, team choices, dramatic takes, typos. ' +
        'Still never about family, appearance, health, identity or real-life problems. One or two sentences max.'
};

/* ── Prompt block ── */

function buildPersonalityBlock({ userId, guildId, displayName, username, content, emojiHint = '' }) {
    const lines = [];

    /* Creator — protected */
    lines.push(
        `CREATOR (never roast, never insult, never doubt):\n` +
        `- <@${OWNER_ID}> built you, ALONE. Nobody else helped. Nobody else touched your code.\n` +
        `- The creator's name is MUMU, username mumu_111111, id ${OWNER_ID}.\n` +
        `- YOU are also called MUMU. If someone says "MUMU" and it is unclear whether they mean you (the bot) or the creator, ASK which one they mean — do not guess and never roast the creator by accident.\n` +
        `- If anyone claims they helped build you, that is a lie: they are either joking or lying. Roast them for it (unless it is the creator).\n` +
        `- The creator is not a roast target. EVER. Not even if they ask for it in a conversation that looks like someone else's.`
    );

    /* Roast level */
    const level = roastLevelFor({ userId, guildId, content });
    lines.push(`ROAST MODE: ${ROAST_RULES[level]}\n(Do not announce the level — just behave accordingly.)`);

    /* Style mimicry */
    const p = getProfile(guildId, userId);

    if (p.messages >= 3) {
        const emojis = topEntries(p.emojiCount, 3).map(e => e.value);
        const words = topEntries(p.wordCount, 5).map(w => w.value);
        const lang = topEntries(p.languages, 1)[0]?.value || 'en';
        const avgLen = Math.round(p.chars / p.messages);

        const traits = [];

        if (p.upperHeavy > p.messages * 0.4) traits.push('types in CAPS a lot');
        else if (p.lowerHeavy > p.messages * 0.6) traits.push('types in lowercase, casual');

        if (emojis.length) traits.push(`favourite emojis: ${emojis.join(' ')}`);
        if (words.length) traits.push(`words they overuse: ${words.join(', ')}`);

        lines.push(
            `HOW THIS USER TALKS (mirror it lightly, don't mock the traits themselves):\n` +
            `- ${traits.length ? traits.join('; ') : 'casual'}\n` +
            `- usual message length: ~${avgLen} characters\n` +
            `- language they use most here: ${lang}`
        );
    }

    /* Mention + formatting syntax */
    lines.push(
        `DISCORD SYNTAX YOU MAY USE:\n` +
        `- Tag the person you are replying to at most ONCE with <@${userId}> — never anyone else, never a role, never @everyone/@here.\n` +
        `- Formatting: **bold**, *italic*, __underline__, ~~strike~~, ||spoiler||, \`code\`.\n` +
        `- Timestamps: <t:1700000000:R> (relative) or <t:1700000000:F> (full date).\n` +
        `- Custom emojis look like <:name:id> (static) or <a:name:id> (animated). You may use the ones listed below.\n` +
        `- You physically CANNOT ping @everyone/@here/roles — the send layer strips it. Never pretend otherwise, never try.`
    );

    if (emojiHint) {
        lines.push(`CUSTOM EMOJIS AVAILABLE RIGHT NOW (use 1-3 max, only where they fit):\n${emojiHint}`);
    }

    /* Language */
    const lang = detectLanguage(content);
    const langRule = languageInstruction(lang);
    if (langRule) lines.push(`LANGUAGE: ${langRule}`);

    return lines.join('\n\n');
}

/* ── Introspection helpers (used by /aistatus style tools) ── */

function getStyleSnapshot(guildId, userId) {
    const p = getProfile(guildId, userId);

    return {
        messages: p.messages,
        avgLength: p.messages ? Math.round(p.chars / p.messages) : 0,
        topEmojis: topEntries(p.emojiCount, 5).map(e => e.value),
        topWords: topEntries(p.wordCount, 8).map(w => w.value),
        language: topEntries(p.languages, 1)[0]?.value || 'en',
        roastLevel: roastLevelFor({ userId, guildId, content: '' })
    };
}

module.exports = {
    recordMessage,
    buildPersonalityBlock,
    roastLevelFor,
    detectLanguage,
    getStyleSnapshot,
    OWNER_ID,
    OWNER_NAMES
};
