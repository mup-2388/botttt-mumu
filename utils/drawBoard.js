/**
 * drawBoard.js
 *
 * Shared draw board UI builders for tournament draws.
 * Used by startdraw.js and finishdraw.js.
 *
 * Exports: getDrawKey, getValidGroupKeys, buildPublicDrawEmbed,
 *          buildPublicDrawComponents, updatePublicDrawBoard, sortTeams
 */

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const { prettyPhase } = require('./displayHelpers');
const { vsLine } = require('./ai/emojiSlots');

const DRAW_EMOJI = '🎴';

function getDrawKey(guildId) {
    return `draw:${guildId}`;
}

function getValidGroupKeys(groupCount) {
    return Array.from({ length: groupCount }, (_, i) => String.fromCharCode(65 + i));
}

function buildPublicDrawEmbed(session) {
    const embed = new EmbedBuilder().setTimestamp();

    if (session.stage === 'groups') {
        embed
            .setColor(0x3498DB)
            .setTitle('🎲 LIVE GROUP DRAW')
            .setDescription(
                `**Teams left in pool:** ${session.pool.length}\n` +
                `**Current Reveal:** ${session.currentPick ? `🎟️ **${session.currentPick.name}**` : 'Waiting for next draw...'}\n` +
                `**Draw Status:** ${session.status.toUpperCase()}`
            )
            .addFields(
                ...Object.entries(session.groups).map(([groupKey, teams]) => ({
                    name: `Group ${groupKey}`,
                    value: teams.length
                        ? teams.map((t, i) => `${i + 1}. **${t.name}**`).join('\n')
                        : '—',
                    inline: true
                })),
                {
                    name: 'Remaining Pool',
                    value: session.pool.length
                        ? session.pool.slice(0, 20).map(t => `• ${t.name}`).join('\n') +
                          (session.pool.length > 20 ? `\n…and **${session.pool.length - 20}** more.` : '')
                        : 'Pool empty',
                    inline: false
                }
            );

        return embed;
    }

    embed
        .setColor(0xFEBE10)
        .setTitle(`🏆 LIVE ${prettyPhase(session.round).toUpperCase()} DRAW`)
        .setDescription(
            `**Teams left in pool:** ${session.pool.length}\n` +
            `**Current Reveal:** ${session.currentPick ? `🎟️ **${session.currentPick.name}**` : 'Waiting for next draw...'}\n` +
            `**Completed Ties:** ${session.ties.length}/${session.requiredPairs}\n` +
            `**Draw Status:** ${session.status.toUpperCase()}`
        )
        .addFields(
            {
                name: 'Completed Ties',
                value: session.ties.length
                    ? session.ties.map(t => `**Tie ${t.tieNumber}:** ${vsLine(t.team1.name, t.team2.name, session.guildId)}`).join('\n')
                    : '—',
                inline: false
            },
            {
                name: 'Current Open Tie',
                value: session.currentPick
                    ? `• **${session.currentPick.name}**`
                    : 'No team waiting',
                inline: false
            },
            {
                name: 'Remaining Pool',
                value: session.pool.length
                    ? session.pool.slice(0, 20).map(t => `• ${t.name}`).join('\n') +
                      (session.pool.length > 20 ? `\n…and **${session.pool.length - 20}** more.` : '')
                    : 'Pool empty',
                inline: false
            }
        );

    return embed;
}

function buildPublicDrawComponents(session) {
    if (session.status !== 'active') return [];

    if (session.stage === 'groups') {
        if (session.currentPick) {
            return buildGroupPlacementButtons(session);
        }
        return buildMysteryButtons(session);
    }

    // knockout
    return buildMysteryButtons(session);
}

function buildMysteryButtons(session) {
    const count = Math.min(session.pool.length, 5);
    if (count <= 0) return [];

    const row = new ActionRowBuilder();

    for (let i = 0; i < count; i++) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`draw_pick_${i + 1}`)
                .setLabel('Draw')
                .setEmoji(DRAW_EMOJI)
                .setStyle(ButtonStyle.Primary)
        );
    }

    return [row];
}

function buildGroupPlacementButtons(session) {
    const groupKeys = Object.keys(session.groups || {});
    const rows = [];
    let currentRow = new ActionRowBuilder();
    let currentCount = 0;

    for (const groupKey of groupKeys) {
        currentRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`draw_place_${groupKey}`)
                .setLabel(`Group ${groupKey}`)
                .setStyle(ButtonStyle.Success)
        );
        currentCount++;

        if (currentCount === 5) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder();
            currentCount = 0;
        }
    }

    if (currentCount > 0) {
        rows.push(currentRow);
    }

    return rows;
}

async function updatePublicDrawBoard(client, session) {
    if (!session.boardChannelId || !session.boardMessageId) return;

    try {
        const channel = await client.channels.fetch(session.boardChannelId);
        if (!channel) return;

        const msg = await channel.messages.fetch(session.boardMessageId);
        if (!msg) return;

        await msg.edit({
            embeds: [buildPublicDrawEmbed(session)],
            components: buildPublicDrawComponents(session)
        });
    } catch (error) {
        console.error('[drawBoard] updatePublicDrawBoard error:', error);
    }
}

function sortTeams(teams) {
    return [...teams].sort((a, b) => {
        const aStats = a.stats || {};
        const bStats = b.stats || {};

        const aPoints = aStats.points || 0;
        const bPoints = bStats.points || 0;
        if (bPoints !== aPoints) return bPoints - aPoints;

        const aGD = (aStats.gf || 0) - (aStats.ga || 0);
        const bGD = (bStats.gf || 0) - (bStats.ga || 0);
        if (bGD !== aGD) return bGD - aGD;

        const aGF = aStats.gf || 0;
        const bGF = bStats.gf || 0;
        if (bGF !== aGF) return bGF - aGF;

        return a.name.localeCompare(b.name);
    });
}

module.exports = {
    DRAW_EMOJI,
    getDrawKey,
    getValidGroupKeys,
    buildPublicDrawEmbed,
    buildPublicDrawComponents,
    updatePublicDrawBoard,
    sortTeams
};
