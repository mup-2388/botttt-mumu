const LIVE_BRACKET_IMAGE_PREFIX = 'live_bracket_image:';

function getLiveBracketImageKey(guildId, tournamentKey) {
    return `${LIVE_BRACKET_IMAGE_PREFIX}${guildId}:${String(tournamentKey || '').toLowerCase()}`;
}

/**
 * Link a standings message only while it is displaying a rendered knockout
 * bracket. A standings message can switch tournaments, so first remove any
 * bracket references that point at this same message.
 */
function syncLiveBracketImageReference({
    client,
    guildId,
    tournamentKey,
    message,
    isBracketImage
}) {
    const settings = client?.liveSettings;
    const channelId = message?.channel?.id;
    const messageId = message?.id;
    if (!settings?.set || !guildId || !tournamentKey || !channelId || !messageId) return false;

    if (typeof settings.keys === 'function' && typeof settings.get === 'function' && typeof settings.delete === 'function') {
        for (const key of settings.keys()) {
            if (!String(key).startsWith(LIVE_BRACKET_IMAGE_PREFIX)) continue;
            const saved = settings.get(key);
            if (String(saved?.channelId) === String(channelId) && String(saved?.messageId) === String(messageId)) {
                settings.delete(key);
            }
        }
    }

    if (!isBracketImage) return false;

    settings.set(getLiveBracketImageKey(guildId, tournamentKey), {
        channelId: String(channelId),
        messageId: String(messageId),
        tournamentKey: String(tournamentKey).toLowerCase()
    });
    return true;
}

module.exports = {
    LIVE_BRACKET_IMAGE_PREFIX,
    getLiveBracketImageKey,
    syncLiveBracketImageReference
};
