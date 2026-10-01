/**
 * utils/ai/emojiSlots.js
 *
 * The bot's own output should use the server's custom emojis — not just the AI's
 * prose. This maps *slots* (goals, assists, saves, calendar, vs, …) to the best
 * custom emoji the bot can actually see, falling back to plain unicode.
 *
 * Resolution order for a slot:
 *   1. a custom emoji from the guild being posted in whose NAME matches the slot
 *      (a server's own `:goal:` beats someone else's)
 *   2. a matching custom emoji from any other guild the bot is in
 *   3. the unicode fallback
 *
 * The "vs" slot is special: it prefers a server emoji named vs/vsvs, otherwise it
 * uses the league's configured VS emoji (:vsvs:1555297535361286225).
 *
 *   slotEmoji('goals', guildId)          → '<:goal:123>' | '⚽'
 *   vsLine('Devils', 'Falcons', guildId) → 'Devils <:vsvs:…> Falcons'
 *   slotHint(guildId, ['goals', ...])    → prompt-ready list for the AI
 */

const { emojisFor } = require('./emojiCatalog');

/* The league's VS emoji. Used between two teams whenever nothing better exists. */
const VS_EMOJI_ID = '1555297535361286225';
const VS_REF = `<:vsvs:${VS_EMOJI_ID}>`;

const SLOTS = {
    goals: { patterns: [/\bgoals?\b/i, /goal(s)?_?hype/i, /striker/i, /football/i, /\bball\b/i], fallback: '⚽' },
    assists: { patterns: [/assist/i, /\bpass(es|ing)?\b/i, /creator/i, /playmaker/i], fallback: '🎯' },
    saves: { patterns: [/saves?\b/i, /glove/i, /\bgk\b/i, /goalkeeper/i, /keeper/i], fallback: '🧤' },
    calendar: { patterns: [/calendar/i, /schedule/i, /\bdate\b/i, /clock/i, /fixture/i], fallback: '📅' },
    vs: { patterns: [/^vs$/i, /^vsvs$/i, /versus/i], fallback: VS_REF, alwaysRef: true },
    trophy: { patterns: [/trophy/i, /champion/i, /winner/i, /\bcup\b/i], fallback: '🏆' },
    fire: { patterns: [/fire/i, /\bhot\b/i, /flame/i], fallback: '🔥' },
    report: { patterns: [/report/i, /clipboard/i, /\bnotes?\b/i, /analytics/i], fallback: '📋' },
    reserve: { patterns: [/reserve/i, /shield/i, /postpone/i, /locked/i], fallback: '🛡️' },
    captain: { patterns: [/captain/i, /armband/i, /crown/i], fallback: '👑' },
    warning: { patterns: [/warning/i, /alert/i, /referee/i, /whistle/i], fallback: '⚠️' }
};

let warnOnce = false;

function matchesSlot(emoji, slot) {
    const def = SLOTS[slot];
    if (!def) return false;

    const name = String(emoji?.name || '');
    const readable = name.replace(/[_-]+/g, ' ');

    return def.patterns.some(re => re.test(name) || re.test(readable));
}

/**
 * Best emoji for a slot in this guild, or the unicode fallback.
 * Always returns something usable — never null.
 */
function slotEmoji(slot, guildId = null) {
    const def = SLOTS[slot];
    if (!def) return '';

    /* The user-specified VS emoji is canonical — never substitute another one. */
    if (slot === 'vs') return VS_REF;

    try {
        const all = emojisFor(guildId);
        const hit = all.find(e => matchesSlot(e, slot));

        if (hit) return hit.ref;
    } catch {
        /* catalogue not initialised yet — fall through */
    }

    /* The VS emoji is league-wide, so use it even before the catalogue warms up. */
    if (def.alwaysRef) return def.fallback;

    if (!warnOnce) {
        warnOnce = true;
        console.log('[emojiSlots] falling back to unicode for some slots (catalogue empty?)');
    }

    return def.fallback;
}

/** "Devils <:vsvs:…> Falcons" — never a bare "vs" when the custom one exists. */
function vsLine(homeTeam, awayTeam, guildId = null) {
    return `${homeTeam} ${slotEmoji('vs', guildId)} ${awayTeam}`;
}

/** Prompt-ready "slot: emoji" list so the AI uses the server's own emojis. */
function slotHint(guildId, slots = ['goals', 'assists', 'saves', 'calendar', 'vs']) {
    const lines = [];

    for (const slot of slots) {
        const emoji = slotEmoji(slot, guildId);

        /* Only worth telling the model about custom ones — it already knows ⚽. */
        if (emoji && emoji.startsWith('<')) {
            const rule = slot === 'vs' ? `${slot}: ${emoji} (always put this between the two team names)` : `${slot}: ${emoji}`;
            lines.push(rule);
        }
    }

    return lines.length ? `Custom emojis for specific things — use these where they fit: ${lines.join(' ')}` : '';
}

function allSlots(guildId = null) {
    const out = {};

    for (const slot of Object.keys(SLOTS)) out[slot] = slotEmoji(slot, guildId);

    return out;
}

module.exports = {
    VS_EMOJI_ID,
    SLOTS,
    slotEmoji,
    vsLine,
    slotHint,
    allSlots
};
