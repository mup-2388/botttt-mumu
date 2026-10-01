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
    TournamentPlayer,
    EventSettings,
    ServerConfig
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

    const config = await ServerConfig.findOne({ guildId: guild.id }).lean();
    const defaultKey = String(config?.defaultTournamentKey || '').toLowerCase();

    const events = await EventSettings.find({ guildId: guild.id })
        .sort({ createdAt: -1 })
        .lean()
        .catch(() => []);

    if (!tournaments.length && !events.length) {
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

        const isDefault = tournament.tournamentKey &&
            String(tournament.tournamentKey).toLowerCase() === defaultKey;

        return (
            `${tournament.emoji || '🏆'} **${tournament.name}**${isDefault ? ' ⭐ **DEFAULT**' : ''}\n` +
            `Key: \`${tournament.tournamentKey}\`\n` +
            `Phase: **${tournament.currentPhase || 'setup'}**\n` +
            `Teams: **${teamCount}** • Players: **${playerCount}**\n` +
            `Registration: **${tournament.registrationOpen ? 'Open' : 'Closed'}**` +
            (tournament.manualRegistration ? ` • 🖐️ Manual (no auto-sync)` : '')
        );
    });

    const eventLines = events.map(ev => {
        const status = ev.isActive === false
            ? '🔴 closed'
            : ev.channelId ? `🟢 bound to <#${ev.channelId}>` : '🟡 unbound';

        return (
            `${ev.emoji || '🏆'} **${ev.name || ev.eventKey}** [EVENT]\n` +
            `Key: \`${ev.eventKey}\`\n` +
            `Status: ${status}`
        );
    });

    const embed = new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle('🏟️ SERVER TOURNAMENTS & EVENTS')
        .setDescription(
            [
                lines.join('\n\n'),
                eventLines.length ? eventLines.join('\n\n') : null
            ]
                .filter(Boolean)
                .join('\n\n━━━━━━━━━━━━━━━\n\n') || 'Nothing configured yet.'
        )
        .setFooter({
            text: defaultKey
                ? `Default tournament: ${defaultKey} • commands without a key use it`
                : 'No default tournament set — use .setdefaulttournament <key>'
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}
