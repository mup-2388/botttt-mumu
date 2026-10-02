/**
 * updateStandings.js
 *
 * Updates live standings messages across all tournaments in a guild.
 *
 * FLOW:
 *   1. Fetch TournamentSettings + LiveMessage records
 *   2. Generate image via generateStandingsImage()
 *   3. Edit existing message with image attachment
 *   4. If edit fails → delete old message, send new, update DB
 *   5. If image generation fails → fallback to text-based standings
 *
 * Uses shared helpers from standingsHelpers.js.
 * Uses image engine from generateStandingsImage.js.
 */

const { AttachmentBuilder } = require('discord.js');

const { TournamentSettings, TournamentTeam } = require('../models/Tournament');
const LiveMessage = require('../models/LiveMessage');

let generateStandingsImage = null;
let imageRendererLoadError = null;

try {
    ({ generateStandingsImage } = require('./generateStandingsImage'));
} catch (error) {
    imageRendererLoadError = error;
    console.warn('[updateStandings] Image renderer unavailable; text fallback enabled:', error.message);
}
const { sortTeams, compactName, getQualificationZone } = require('./standingsHelpers');

/*
========================================
SINGLE LIVE STANDINGS UPDATE
========================================
*/

/**
 * Update one live standings message (image or text fallback).
 *
 * @param {Object} client - Discord.js client
 * @param {string} guildId
 * @param {string} tournamentKey
 * @param {string|null} groupKey
 * @returns {Promise<boolean>} success
 */
async function updateLiveStandings(
    client,
    guildId,
    tournamentKey,
    groupKey = null
) {
    try {
        const settings = await TournamentSettings.findOne({
            guildId,
            tournamentKey
        });

        if (!settings) return false;

        const liveData = await LiveMessage.findOne({
            guildId,
            type: 'standings',
            tournamentKey,
            groupKey: groupKey || null
        });

        if (!liveData) return false;

        const channel = await client.channels
            .fetch(liveData.channelId)
            .catch(() => null);

        if (!channel) return false;

        const message = await channel.messages
            .fetch(liveData.messageId)
            .catch(() => null);

        // ── GENERATE IMAGE ──
        let imageResult = null;

        try {
            if (!generateStandingsImage) {
                throw imageRendererLoadError || new Error('Standings image renderer is unavailable.');
            }

            imageResult = await generateStandingsImage({
                settings,
                guildId,
                groupKey
            });
        } catch (imgError) {
            console.error(
                '[updateLiveStandings] Image generation failed, using text fallback:',
                imgError.message
            );
        }

        if (imageResult) {
            return await sendImageStandings({
                channel,
                message,
                liveData,
                imageResult,
                settings,
                groupKey
            });
        }

        // ── TEXT FALLBACK ──
        return await sendTextStandings({
            channel,
            message,
            liveData,
            settings,
            guildId,
            groupKey
        });
    } catch (error) {
        console.error('[updateLiveStandings] Error:', error);
        return false;
    }
}

/*
========================================
IMAGE STANDINGS
========================================
*/

/**
 * Send or edit a live standings message with an image.
 *
 * Strategy: edit preferred, fallback to delete + send.
 *
 * @returns {Promise<boolean>} success
 */
async function sendImageStandings({
    channel,
    message,
    liveData,
    imageResult,
    settings,
    groupKey
}) {
    const attachment = new AttachmentBuilder(imageResult.buffer, {
        name: imageResult.fileName
    });

    const content = buildImageCaption({ settings, groupKey });

    // ── TRY EDIT FIRST ──
    if (message) {
        try {
            await message.edit({
                content,
                files: [attachment],
                attachments: [],
                embeds: [],
                components: []
            });

            return true;
        } catch (editError) {
            console.warn(
                '[updateLiveStandings] Edit failed, trying delete+send:',
                editError.message
            );

            // Message might be deleted, cached image issue, etc.
            // Fall through to delete + send.
        }
    }

    // ── FALLBACK: DELETE OLD + SEND NEW ──
    if (message) {
        try {
            await message.delete();
        } catch (delError) {
            // Already deleted, not critical
        }
    }

    try {
        const newMessage = await channel.send({
            content,
            files: [attachment]
        });

        // Update the LiveMessage record with new messageId
        await LiveMessage.updateOne(
            { _id: liveData._id },
            { $set: { messageId: newMessage.id } }
        );

        return true;
    } catch (sendError) {
        console.error(
            '[updateLiveStandings] Send failed:',
            sendError.message
        );
        return false;
    }
}

/**
 * Build the text caption that appears above/below the standings image.
 */
function buildImageCaption({ settings, groupKey }) {
    const emoji = settings.emoji || '🏆';
    const name = settings.name || 'Tournament';
    const groupLabel = groupKey ? ` — Group ${groupKey}` : '';

    return (
        `${emoji} **${name.toUpperCase()}${groupLabel} LIVE STANDINGS**\n` +
        `Key: \`${settings.tournamentKey}\` • ` +
        `Updated: <t:${Math.floor(Date.now() / 1000)}:R>`
    );
}

/*
========================================
TEXT FALLBACK
========================================
*/

/**
 * Send or edit a live standings message with text.
 * Used when image generation fails.
 *
 * Strategy: edit preferred, fallback to delete + send.
 *
 * @returns {Promise<boolean>} success
 */
async function sendTextStandings({
    channel,
    message,
    liveData,
    settings,
    guildId,
    groupKey
}) {
    const query = {
        guildId,
        tournamentId: settings._id,
        isActive: true
    };
    if (groupKey) query.groupKey = groupKey;

    const teams = await TournamentTeam.find(query)
        .populate('teamId')
        .lean();
    const content = buildStandingsText({ settings, groupKey, teams });

    // ── TRY EDIT FIRST ──
    if (message) {
        try {
            await message.edit({ content, attachments: [], embeds: [], components: [] });
            return true;
        } catch (editError) {
            console.warn(
                '[updateLiveStandings] Text edit failed, trying delete+send:',
                editError.message
            );
        }
    }

    // ── FALLBACK: DELETE OLD + SEND NEW ──
    if (message) {
        try {
            await message.delete();
        } catch (delError) {
            // Not critical
        }
    }

    try {
        const newMessage = await channel.send({ content });

        await LiveMessage.updateOne(
            { _id: liveData._id },
            { $set: { messageId: newMessage.id } }
        );

        return true;
    } catch (sendError) {
        console.error(
            '[updateLiveStandings] Text send failed:',
            sendError.message
        );
        return false;
    }
}

/**
 * Build text-based standings (fallback when image fails).
 *
 * Uses shared helpers. No duplicated sort/zone logic.
 */
function buildStandingsText({ settings, groupKey, teams = [] }) {
    const emoji = settings.emoji || '🏆';
    const name = settings.name || 'Tournament';
    const groupLabel = groupKey ? ` — Group ${groupKey}` : '';
    const sorted = sortTeams(teams);
    const updated = `Updated: <t:${Math.floor(Date.now() / 1000)}:R>`;
    const header = [
        `${emoji} **${name.toUpperCase()}${groupLabel} LIVE STANDINGS**`,
        `Key: \`${settings.tournamentKey}\``
    ];

    if (!sorted.length) {
        return [...header, '', 'No active teams yet.', updated].join('\n');
    }

    if (sorted.every(entry => !(entry.stats?.played || 0))) {
        header.push('_Positions are provisional until a match is reported._');
    }

    const lines = [
        ...header,
        '',
        '```text',
        'Pos  Team              P  W  D  L  GF GA  GD Pts',
        '---  ---------------- -- -- -- -- --- -- --- ---'
    ];
    let shown = 0;

    for (let index = 0; index < sorted.length; index++) {
        const entry = sorted[index];
        const stats = entry.stats || {};
        const teamName = compactName(entry.teamNameSnapshot || entry.teamId?.name || 'Unknown', 16);
        const played = Number(stats.played) || 0;
        const wins = Number(stats.wins) || 0;
        const draws = Number(stats.draws) || 0;
        const losses = Number(stats.losses) || 0;
        const goalsFor = Number(stats.gf) || 0;
        const goalsAgainst = Number(stats.ga) || 0;
        const goalDifference = goalsFor - goalsAgainst;
        const points = Number(stats.points) || 0;
        const zone = getQualificationZone({ position: index + 1, settings, groupKey });
        const zoneMark = zone === 'ucl' ? '★' : zone === 'qualification' ? '↑' : '';
        const row = [
            `${String(index + 1).padStart(2)}.`,
            teamName.padEnd(16),
            String(played).padStart(2),
            String(wins).padStart(2),
            String(draws).padStart(2),
            String(losses).padStart(2),
            String(goalsFor).padStart(3),
            String(goalsAgainst).padStart(2),
            String(goalDifference >= 0 ? `+${goalDifference}` : goalDifference).padStart(3),
            `${String(points).padStart(3)}${zoneMark ? ` ${zoneMark}` : ''}`
        ].join(' ');

        if ([...lines, row, '```', updated].join('\n').length > 1850) break;
        lines.push(row);
        shown++;
    }

    if (shown < sorted.length) lines.push(`…and ${sorted.length - shown} more team(s)`);
    lines.push('```', updated);
    return lines.join('\n');
}

/*
========================================
UPDATE ALL LIVE STANDINGS
========================================
*/

/**
 * Update every live standings message for a guild.
 * Called after every .report submission.
 *
 * @param {Object} client - Discord.js client
 * @param {string} guildId
 */
async function updateAllLiveStandings(client, guildId) {
    try {
        const liveMessages = await LiveMessage.find({
            guildId,
            type: 'standings'
        });

        for (const live of liveMessages) {
            await updateLiveStandings(
                client,
                guildId,
                live.tournamentKey,
                live.groupKey || null
            );
        }
    } catch (error) {
        console.error('[updateAllLiveStandings] Error:', error);
    }
}

module.exports = {
    updateLiveStandings,
    updateAllLiveStandings
};
