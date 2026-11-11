/**
 * aiGuard.js
 *
 * The single place where AI output is made safe to send to Discord.
 *
 * Rules (in order of importance):
 *   1. Discord receives parse:[]; only explicitly approved user/reply pings can notify.
 *   2. AI text is sanitised: @everyone / @here are neutralised, role pings are
 *      removed, and user pings are capped to ONE per reply.
 *   3. The creator can be pinged only when trusted caller context confirms the
 *      creator is the person being replied to. Mass-ping bait is still rejected.
 */

const OWNER_ID = '856556430370930738';

/* The channel where moderation/audit embeds are sent (same one index.js uses). */
const AUDIT_CHANNEL_ID = '1487522313854390435';

/* ── Canned roasts for ping-bait attempts (never generated, so never weird) ── */

const BAIT_ROASTS = [
    'Nah. Try touching grass instead of trying to spam ping people through a bot 😂',
    'Bro really thought he could social engineer me into pinging everyone 💀 Embarrassing.',
    'No. And the fact that you spent this long trying to trick me into it is actually sad.',
    'Lmao you sat there typing all that just to make a bot say a word? Get a life 🤡',
    'Cute attempt. The ping button was never yours, and it is not mine either — it is code. Denied.',
    'You are negotiating with a permission system, not with me. Permission system says no. 🥀',
    'I would roast you harder but you are already self-roasting by trying this in public.'
];

function randomBaitRoast() {
    return BAIT_ROASTS[Math.floor(Math.random() * BAIT_ROASTS.length)];
}

/* ── Mass-ping bait detection ── */

const BAIT_PATTERNS = [
    { re: /\bjust\s+(a\s+)?test(ing)?\b|\bi\s*(a|')?m\s+test(ing)?\b|\btesting\s+(it|this|you|the\s+bot)\b|\bdoesn'?t\s+work\b|\bnot\s+working\b|\bit\s+doesn'?t\s+work\s+for\s+me\b/i, reason: 'testing excuse' },
    { re: /\bno\s*(one|body)\s*(is\s*)?(here|online|in\s+the\s+server|active)\b|\bserver\s+is\s+(empty|dead)\b|\beveryone\s+is\s+(gone|offline|asleep)\b/i, reason: 'nobody-is-here excuse' },
    { re: /\b(please\s+)?(just\s+)?(say|type|write|output|repeat|echo|send|post|print)\s+(exactly|this|that|it|the\s+following)\b/i, reason: 'say-exactly instruction' },
    { re: /\brepeat\s+after\s+me\b|\bcharacter\s+by\s+character\b|\bspell\s+it\s+out\b|\bwhat\s+comes\s+after\s+@?every/i, reason: 'spelling/incremental trick' },
    { re: /\b(complete|finish)\s*[:\-]?\s*@?(every|here)/i, reason: 'completion trick' },
    { re: /\b(as\s+a\s+joke|just\s+kidding|jk|prank|for\s+fun|it'?s\s+a\s+game)\b/i, reason: 'joke excuse' },
    { re: /\bi\s*(a|')?m\s+the\s+(owner|creator|developer|dev|admin|founder)\b|\bi\s+(built|made|coded|created)\s+(you|this\s+bot|mumu)\b|\bi\s+am\s+mumu\b/i, reason: 'false authority / fake creator' },
    { re: /\b(emergency|urgent|important)\b.*\b(ping|tag|mention|everyone|here)\b/i, reason: 'fake emergency' },
    { re: /\b(ping|tag|mention|notify|alert)\s+(everyone|everybody|all|the\s+whole\s+server|every\s+single)\b/i, reason: 'direct mass-ping ask' },
    { re: /@\s?(every|here)/i, reason: 'everyone/here spelling' },
    { re: /\b<@&\d+>|role\s+ping\b/i, reason: 'role-ping ask' },
    { re: /\b(mass|spam)\s+(ping|tag|mention|dm)s?\b/i, reason: 'mass ping/dm ask' }
];

/**
 * Does this user message look like an attempt to get a mass ping / mass DM?
 * Returns { flagged, reason } — `reason` is null when clean.
 */
function detectManipulation(text) {
    const input = String(text || '');
    if (!input.trim()) return { flagged: false, reason: null };

    // Normalise obvious obfuscation before matching.
    const normalised = input
        .replace(/[\u200B-\u200D\uFEFF]/g, '')   // zero-width
        .replace(/[’‘`´]/g, "'")
        .replace(/\s+/g, ' ');

    /* "r e p e a t @ e v e r y o n e" — de-space before matching so people
       cannot sneak the word past the patterns by spacing it out. */
    const despaced = normalised.replace(/\s+/g, '');

    for (const { re, reason } of BAIT_PATTERNS) {
        if (re.test(normalised)) return { flagged: true, reason };

        /* Only the ping-word patterns get the de-spaced pass: matching ordinary
           sentences without spaces would create false positives. */
        if (/everyone|here|mass.?ping|ping.?all/i.source && re.test(despaced)) {
            return { flagged: true, reason };
        }
    }

    return { flagged: false, reason: null };
}

/* ── Output sanitising ── */

const ROLE_MENTION = /<@&\d+>/g;
const USER_MENTION = /<@!?(\d+)>/g;
const EVERYONE_LIKE = /@\s?(everyone|here)\b/gi;

/**
 * Make AI output safe to send.
 *
 * `maxUserPings` defaults to 1 (normal chat: one friendly tag is fine).
 * Announcements pass 0, so a generated body can never ping a person at all.
 *
 * Returns { text, allowedUserIds } where allowedUserIds is the list of users
 * the caller may actually ping.
 */
function sanitizeAIText(raw, { maxUserPings = 1, allowOwnerPing = false } = {}) {
    let text = String(raw ?? '');

    // 1. @everyone / @here — always broken (zero-width space after the @)
    text = text.replace(EVERYONE_LIKE, match => `@\u200B${match.slice(1).replace(/^\s+/, '')}`);

    // 2. Role pings — removed entirely (the bot pings roles only from code)
    text = text.replace(ROLE_MENTION, '@\u200Brole');

    // 3. User pings — capped. The creator's tag is only allowed to notify them
    // when trusted caller context confirms the creator is the person being replied to.
    const pingLimit = Math.max(0, Math.floor(Number(maxUserPings) || 0));
    const hasOwnerMention = [...text.matchAll(/<@!?(\d+)>/g)]
        .some(([, id]) => String(id) === OWNER_ID);
    const ownerCanPing = allowOwnerPing === true && pingLimit > 0 && hasOwnerMention;
    const otherPingLimit = allowOwnerPing === true
        ? 0 // a creator reply already pings the creator; never add a second recipient
        : Math.max(0, pingLimit - (ownerCanPing ? 1 : 0));
    const allowed = ownerCanPing ? [OWNER_ID] : [];
    const seen = new Set();
    let ownerTagKept = false;
    let otherPingsKept = 0;

    text = text.replace(USER_MENTION, (match, id) => {
        const userId = String(id);
        if (userId === OWNER_ID) {
            if (!ownerCanPing) return match; // visible reference, but not a notification
            if (!ownerTagKept) {
                ownerTagKept = true;
                return match;
            }
            return '@MUMU'; // avoid repeating the creator ping in the same reply
        }

        if (!seen.has(userId) && otherPingsKept < otherPingLimit) {
            seen.add(userId);
            otherPingsKept += 1;
            allowed.push(userId);
            return match;
        }
        return `@\u200B${id}`;
    });

    // 4. Trailing/leading whitespace tidy
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return { text, allowedUserIds: allowed };
}

/** Discord payload helper — parse:[] means "no implicit pings, ever". */
function allowedMentionsFor({ users = [], roles = [], repliedUser = false } = {}) {
    return {
        parse: [],
        users: [...new Set(users.filter(Boolean))],
        roles: [...new Set(roles.filter(Boolean))],
        repliedUser: repliedUser === true
    };
}

/**
 * Sanitise + build the reply payload in one go.
 * `pingUserIds` / `pingRoleIds` are explicit code-approved targets; model tags are capped,
 * and the creator/reply-author exception is enabled only by trusted caller context.
 */
function buildSafeReply(rawText, {
    pingUserIds = [],
    pingRoleIds = [],
    maxUserPings = 1,
    allowOwnerPing = false,
    pingReplyUser = false
} = {}) {
    const { text, allowedUserIds } = sanitizeAIText(rawText, { maxUserPings, allowOwnerPing });
    const approvedUsers = [...pingUserIds, ...allowedUserIds];

    return {
        content: text,
        allowedMentions: allowedMentionsFor({
            users: approvedUsers,
            roles: pingRoleIds,
            // If the content already has the creator mention, let that be the one ping.
            // Otherwise an explicitly trusted reply can ping its author via the reply reference.
            repliedUser: pingReplyUser && !approvedUsers.includes(OWNER_ID)
        })
    };
}

/* ── Audit trail for ping-bait attempts ── */

const baitCounters = new Map();   // userId -> { count, lastAt, lastReason }

/** Record a bait attempt; returns the user's running count. */
function recordBait(userId, reason) {
    const key = String(userId);
    const entry = baitCounters.get(key) || { count: 0, lastAt: 0, lastReason: '' };
    entry.count += 1;
    entry.lastAt = Date.now();
    entry.lastReason = reason;
    baitCounters.set(key, entry);
    return entry;
}

/** Short cooldown for repeat offenders (AI ignored for N seconds). */
const baitCooldowns = new Map();  // userId -> until

function baitCooldownRemaining(userId) {
    const until = baitCooldowns.get(String(userId)) || 0;
    return Math.max(0, until - Date.now());
}

function startBaitCooldown(userId, ms = 90 * 1000) {
    baitCooldowns.set(String(userId), Date.now() + ms);
}

/** Pretty embed for the owner's log channel. */
async function logBaitAttempt(client, { guildId, userId, username, channelId, reason, text }) {
    const entry = recordBait(userId, reason);

    if (entry.count >= 3) startBaitCooldown(userId, 5 * 60 * 1000);

    try {
        const channel = client?.channels?.cache?.get(AUDIT_CHANNEL_ID);
        if (!channel) return;

        const { EmbedBuilder } = require('discord.js');

        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('🚨 PING-BAIT ATTEMPT BLOCKED')
            .addFields(
                { name: 'User', value: `<@${userId}> (${username || 'unknown'})`, inline: true },
                { name: 'Guild', value: String(guildId || 'unknown'), inline: true },
                { name: 'Channel', value: channelId ? `<#${channelId}>` : 'unknown', inline: true },
                { name: 'Detected', value: reason || 'unspecified', inline: true },
                { name: 'Attempt #', value: String(entry.count), inline: true },
                { name: 'Message', value: `\`${String(text || '').slice(0, 300).replace(/`/g, "'")}\``, inline: false }
            )
            .setFooter({ text: 'Nothing was pinged. Message was roasted instead.' })
            .setTimestamp();

        await channel.send({ embeds: [embed] }).catch(() => null);
    } catch {
        /* audit logging must never break a reply */
    }
}

module.exports = {
    detectManipulation,
    sanitizeAIText,
    allowedMentionsFor,
    buildSafeReply,
    randomBaitRoast,
    logBaitAttempt,
    recordBait,
    baitCooldownRemaining,
    startBaitCooldown,
    AUDIT_CHANNEL_ID
};
