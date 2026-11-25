// The animated eFootball/footballg emoji is intentionally never used by the bot.
const BLOCKED_EMOJI_IDS = new Set(['1486727534576930846']);
const CUSTOM_EMOJI_PATTERN = /<a?:([A-Za-z0-9_]+):(\d+)>/g;

function isBlockedEmoji({ name = '', id = '' } = {}) {
    const normalizedName = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

    return BLOCKED_EMOJI_IDS.has(String(id)) ||
        normalizedName.includes('efootball') ||
        normalizedName === 'footballg';
}

function isBlockedEmojiRef(ref) {
    const match = String(ref || '').match(/^<a?:([A-Za-z0-9_]+):(\d+)>$/);
    return match ? isBlockedEmoji({ name: match[1], id: match[2] }) : false;
}

function stripBlockedEmojiRefs(value) {
    return String(value ?? '').replace(CUSTOM_EMOJI_PATTERN, (ref, name, id) =>
        isBlockedEmoji({ name, id }) ? '' : ref
    );
}

module.exports = {
    BLOCKED_EMOJI_IDS,
    isBlockedEmoji,
    isBlockedEmojiRef,
    stripBlockedEmojiRefs
};
