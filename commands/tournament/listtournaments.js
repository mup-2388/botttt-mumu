/**
 * listtournaments.js
 *
 * View all tournaments in this server with team and player counts.
 * Bulk-loads counts to avoid N+1 queries.
 *
 * Usage:  .listtournaments
 * Slash:  /listtournaments
 *
 * Aliases: tournaments, alltournaments, tourlist
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const {
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer
} = require('../../models/Tournament');

module.exports = {
    name: 'listtournaments',
    description: 'View all tournaments in this server.',
    usage: '.listtournaments',
    aliases: ['tournaments', 'alltournaments', 'tourlist'],
    hidden: false,
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('listtournaments')
        .setDescription('View all tournaments'),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message) {
        try {
            if (!message.guild) return;

            return await runList({
                guild: message.guild,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[listtournaments] prefix error:', error);
            return message.reply('❌ Failed to load tournaments.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return await runList({
                guild: interaction.guild,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[listtournaments] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to load tournaments.');
            }

            return interaction.reply({ content: '❌ Failed to load tournaments.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * List all tournaments with team/player counts.
 * Uses bulk aggregation to avoid N+1 queries.
 */
async function runList({ guild, reply }) {
    const tournaments = await TournamentSettings.find({
        guildId: guild.id
    }).sort({ createdAt: -1 }).lean();

    if (!tournaments.length) {
        return reply({ content: '📭 No tournaments found.' });
    }

    const tournamentIds = tournaments.map(t => t._id);

    /* ── Bulk count teams and players per tournament ── */
    const [teamCounts, playerCounts] = await Promise.all([
        TournamentTeam.aggregate([
            { $match: { guildId: guild.id, tournamentId: { $in: tournamentIds }, isActive: true } },
            { $group: { _id: '$tournamentId', count: { $sum: 1 } } }
        ]),
        TournamentPlayer.aggregate([
            { $match: { guildId: guild.id, tournamentId: { $in: tournamentIds }, isActive: true } },
            { $group: { _id: '$tournamentId', count: { $sum: 1 } } }
        ])
    ]);

    const teamCountMap = new Map(teamCounts.map(r => [String(r._id), r.count]));
    const playerCountMap = new Map(playerCounts.map(r => [String(r._id), r.count]));

    /* ── Build lines ── */
    const lines = tournaments.map(tournament => {
        const teamCount = teamCountMap.get(String(tournament._id)) || 0;
        const playerCount = playerCountMap.get(String(tournament._id)) || 0;

        return (
            `${tournament.emoji || '🏆'} **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n` +
            `Phase: **${tournament.currentPhase || 'setup'}**\n` +
            `Teams: **${teamCount}** • Players: **${playerCount}**\n` +
            `Registration: **${tournament.registrationOpen ? 'Open' : 'Closed'}**` +
            (tournament.manualRegistration ? ` • 🖐️ Manual (no auto-sync)` : '')
        );
    });

    const embed = new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle('🏟️ SERVER TOURNAMENTS')
        .setDescription(lines.join('\n\n'))
        .setTimestamp();

    return reply({ embeds: [embed] });
}
