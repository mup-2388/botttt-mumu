const LIVE_BRACKET_IMAGE_PREFIX = 'live_bracket_image:';
const LIVE_BRACKET_IMAGE_SOURCE = 'bracketimage';

function getLiveBracketImageKey(guildId, tournamentKey) {
    return `${LIVE_BRACKET_IMAGE_PREFIX}${guildId}:${String(tournamentKey || '').toLowerCase()}`;
}

function isLiveBracketImageReference(reference) {
    return reference?.source === LIVE_BRACKET_IMAGE_SOURCE &&
        Boolean(reference.channelId && reference.messageId);
}

/** Persist the one dedicated bracketimage message for this guild/tournament. */
function saveLiveBracketImageReference({ client, guildId, tournamentKey, channel, message }) {
    const settings = client?.liveSettings;
    const channelId = channel?.id || message?.channel?.id;
    const messageId = message?.id;
    if (!settings?.set || !guildId || !tournamentKey || !channelId || !messageId) return false;

    settings.set(getLiveBracketImageKey(guildId, tournamentKey), {
        channelId: String(channelId),
        messageId: String(messageId),
        tournamentKey: String(tournamentKey).toLowerCase(),
        source: LIVE_BRACKET_IMAGE_SOURCE
    });
    return true;
}

module.exports = {
    LIVE_BRACKET_IMAGE_PREFIX,
    LIVE_BRACKET_IMAGE_SOURCE,
    getLiveBracketImageKey,
    isLiveBracketImageReference,
    saveLiveBracketImageReference
};
