const {
    EmbedBuilder
} = require('discord.js');

const {
    TournamentPlayer,
    TournamentSettings
} = require('../models/Tournament');

const LiveMessage = require('../models/LiveMessage');

const CATEGORIES = [
    { key: 'goals', label: 'Goals', emoji: '<:Goal:1488855482142556180>' },
    { key: 'assists', label: 'Assists', emoji: '<:Assist:1488530563500605532>' },
    { key: 'saves', label: 'Saves', emoji: '<:saves:1488530642127028358>' },
    { key: 'tackles', label: 'Tackles', emoji: '<:tackles:1488530871668703255>' },
    { key: 'interceptions', label: 'Interceptions', emoji: '🧠' },
    { key: 'mvps', label: 'MVPs', emoji: '<:mvp:1488530468184920195>' },
    // Keep this last and full-width so the existing six-stat, three-column grid stays balanced.
    { key: 'ga', label: 'G+A', emoji: '🔥', inline: false }
];

async function updateLiveTopStats(client, guildId) {
    try {
        const liveMessages = await LiveMessage.find({
            guildId,
            type: 'topstats'
        });

        for (const live of liveMessages) {
            await updateSingleTopStats(client, guildId, live);
        }

        return true;
    } catch (error) {
        console.error('updateLiveTopStats error:', error);
        return false;
    }
}

async function updateSingleTopStats(client, guildId, live) {
    const settings = await TournamentSettings.findOne({
        guildId,
        tournamentKey: live.tournamentKey
    });

    if (!settings) return false;

    const channel = await client.channels.fetch(live.channelId).catch(() => null);
    if (!channel) return false;

    const message = await channel.messages.fetch(live.messageId).catch(() => null);
    if (!message) return false;

    const players = await TournamentPlayer.find({
        guildId,
        tournamentId: settings._id,
        isActive: true
    }).populate('playerId').lean();

    const embed = new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle('🏆 LIVE TOP STATS')
        .setDescription(
            `**${settings.name.toUpperCase()}**\n` +
            `Key: \`${settings.tournamentKey}\`\n\n` +
            `Updated automatically after stats are added.`
        )
        .setFooter({ text: 'Last Updated' })
        .setTimestamp();

    for (const category of CATEGORIES) {
        const top = players
            .filter(player => getStatValue(player, category.key) > 0)
            .sort((a, b) => {
                const difference = getStatValue(b, category.key) - getStatValue(a, category.key);
                if (difference !== 0) return difference;

                return (Number(a.stats?.played) || 0) - (Number(b.stats?.played) || 0);
            })
            .slice(0, 5);

        const value = top.length
            ? top.map((player, index) => {
                const stat = getStatValue(player, category.key);
                const playerName = player.playerNameSnapshot || player.playerId?.name || 'Unknown';

                return `**${index + 1}.** ${playerName} — **${stat}**`;
            }).join('\n')
            : 'No records yet.';

        embed.addFields({
            name: `${category.emoji} ${category.label}`,
            value,
            inline: category.inline !== false
        });
    }

    await message.edit({
        content: null,
        embeds: [embed]
    });

    return true;
}

function getStatValue(player, categoryKey) {
    if (categoryKey === 'ga') {
        return (Number(player.stats?.goals) || 0) + (Number(player.stats?.assists) || 0);
    }

    return Number(player.stats?.[categoryKey]) || 0;
}

module.exports = {
    updateLiveTopStats
};
