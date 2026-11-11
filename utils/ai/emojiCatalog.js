/**
 * utils/ai/emojiCatalog.js
 *
 * Keeps a catalogue of every custom emoji the bot can see — from EVERY guild
 * it is in, not just the one being talked in — so the AI can use them.
 *
 *   initEmojiCatalog(client)              → first crawl + refresh every 30 min
 *   emojiHint(text, guildId, limit)       → prompt-ready list, best matches first
 *   learnUserEmojis(guildId, userId, msg) → remembers which ones a user likes
 *   userTopEmojis(guildId, userId, n)     → that user's favourites (from messages)
 */

const REFRESH_MS = 30 * 60 * 1000;

const catalog = new Map();     // emoji id -> { name, id, animated, guildId, guildName, ref, keywords }
const userEmojis = new Map();  // `${guildId}:${userId}` -> Map(ref -> count)

let lastRefresh = 0;
let refreshTimer = null;

const STOP = new Set(['the', 'and', 'for', 'with', 'emoji', 'custom', 'server', 'mumu', 'bot']);

function keywordsFor(name) {
    return String(name || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 2 && !STOP.has(w));
}

function crawl(client) {
    if (!client?.guilds?.cache) return 0;

    let count = 0;
    const seen = new Set();

    for (const guild of client.guilds.cache.values()) {
        const emojis = guild.emojis?.cache;

        if (!emojis) continue;

        for (const emoji of emojis.values()) {
            seen.add(String(emoji.id));
            catalog.set(String(emoji.id), {
                name: emoji.name,
                id: String(emoji.id),
                animated: !!emoji.animated,
                guildId: String(guild.id),
                guildName: guild.name,
                ref: `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`,
                keywords: keywordsFor(emoji.name)
            });
            count++;
        }
    }

    /* Drop emojis removed from any guild since the last crawl. */
    for (const id of catalog.keys()) {
        if (!seen.has(id)) catalog.delete(id);
    }

    lastRefresh = Date.now();

    return count;
}

function initEmojiCatalog(client) {
    const count = crawl(client);
    console.log(`[emojiCatalog] indexed ${count} custom emojis from ${client?.guilds?.cache?.size || 0} guilds`);

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => crawl(client), REFRESH_MS);
    refreshTimer.unref?.();

    return count;
}

function markStale() { lastRefresh = 0; }
function size() { return catalog.size; }
function lastRefreshAt() { return lastRefresh; }

/** Which emojis should the model consider for this text? */
function emojiHint(text, guildId, limit = 14) {
    if (!catalog.size) return '';

    const words = keywordsFor(text);
    const scored = [];

    for (const emoji of catalog.values()) {
        let score = 0;

        if (String(emoji.guildId) === String(guildId)) score += 2;   // local ones first

        for (const w of words) {
            if (emoji.keywords.includes(w)) score += 5;
            else if (emoji.name.toLowerCase().includes(w)) score += 3;
        }

        scored.push({ emoji, score });
    }

    scored.sort((a, b) => b.score - a.score || a.emoji.name.localeCompare(b.emoji.name));

    return scored
        .slice(0, limit)
        .map(s => `${s.emoji.ref} (${s.emoji.name})`)
        .join(' ');
}

/** Remember the emojis a specific user uses. */
function learnUserEmojis(guildId, userId, content) {
    const text = String(content || '');
    const matches = [...text.matchAll(/<a?:(\w+):(\d+)>/g)];
    const unicode = [...text.matchAll(/\p{Extended_Pictographic}/gu)].map(m => m[0]);

    if (!matches.length && !unicode.length) return;

    const k = `${guildId}:${userId}`;
    let map = userEmojis.get(k);

    if (!map) {
        map = new Map();
        userEmojis.set(k, map);
    }

    for (const m of matches) map.set(m[0], (map.get(m[0]) || 0) + 1);
    for (const u of unicode) map.set(u, (map.get(u) || 0) + 1);

    if (userEmojis.size > 1000) userEmojis.delete(userEmojis.keys().next().value);
}

function userTopEmojis(guildId, userId, n = 3) {
    const map = userEmojis.get(`${guildId}:${userId}`);
    if (!map) return [];

    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([ref]) => ref);
}

/** Emoji usage across the server, so the bot sounds local. */
function guildFavourites(guildId, n = 6) {
    const counts = new Map();

    for (const [k, map] of userEmojis.entries()) {
        if (!k.startsWith(`${guildId}:`)) continue;
        for (const [ref, c] of map.entries()) counts.set(ref, (counts.get(ref) || 0) + c);
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([ref]) => ref);
}

function stats() {
    return { emojis: catalog.size, users: userEmojis.size, lastRefresh };
}

/**
 * Every emoji the bot can see, best-first for the given guild:
 * that guild's own emojis, then animated ones, then everything else.
 * Used by emojiSlots to pick a per-slot emoji deterministically.
 */
function emojisFor(guildId = null) {
    const list = [...catalog.values()];

    return list.sort((a, b) => {
        const aLocal = String(a.guildId) === String(guildId) ? 1 : 0;
        const bLocal = String(b.guildId) === String(guildId) ? 1 : 0;

        if (aLocal !== bLocal) return bLocal - aLocal;
        if (a.animated !== b.animated) return a.animated ? -1 : 1;

        return a.name.localeCompare(b.name);
    });
}

/** Direct lookup by emoji id (used to verify league-wide emojis like :vsvs:). */
function byId(id) {
    return catalog.get(String(id)) || null;
}

module.exports = {
    initEmojiCatalog,
    emojiHint,
    learnUserEmojis,
    userTopEmojis,
    guildFavourites,
    stats,
    markStale,
    size,
    lastRefreshAt,
    emojisFor,
    byId
};
