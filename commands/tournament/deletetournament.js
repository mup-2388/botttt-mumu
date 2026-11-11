/**
 * deletetournament.js
 *
 * COMPLETELY delete a tournament — as if it never existed:
 *   - tournament settings (the tournament itself)
 *   - its team entries, player entries, fixtures, draw session
 *   - its live standings / top-stats messages
 *   - its trophies / awards on player profiles
 *   - the server DEFAULT pointer, if it pointed at this tournament
 *   - the global teams & players that only existed because of it
 *     (so mystats / nick / release / setvicecaptain … stop seeing the old team)
 *
 * Never touched: other tournaments, events (and their stats), and teams that
 * are still registered in another tournament.
 *
 * Usage:  .deletetournament <key>               → preview (nothing deleted)
 *         .deletetournament <key> --confirm     → delete
 *         .deletetournament <key> --confirm --keep-global
 *             (keep global teams/players, only remove the tournament itself)
 *
 * Slash:  /deletetournament key:<key> confirm:<true> [keep_global:<true>]
 *
 * Aliases: deltournament, removetournament, tdelete
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer,
    Fixture,
    ServerConfig
} = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { purgeTournament } = require('../../utils/tournamentCleanup');
const { getSelectableTournaments } = require('../../utils/getTournament');

module.exports = {
    name: 'deletetournament',
    description: 'Completely delete a tournament (and its leftover teams/players).',
    usage: '.deletetournament <key> [--confirm] [--keep-global]',
    aliases: ['deltournament', 'removetournament', 'tdelete'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('deletetournament')
        .setDescription('Completely delete a tournament and its leftover teams/players')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Tournament key')
                .setRequired(true)
        )
        .addBooleanOption(opt =>
            opt.setName('confirm')
                .setDescription('true = delete for real, false = preview only')
                .setRequired(true)
        )
        .addBooleanOption(opt =>
            opt.setName('keep_global')
                .setDescription('Keep global teams/players (only delete the tournament itself)')
                .setRequired(false)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 You are not authorized to use this command.');
            }

            const flags = args.filter(a => a.startsWith('--'));
            const key = args.find(a => !a.startsWith('--'))?.toLowerCase();

            if (!key) {
                return message.reply(
                    '❌ Usage: `.deletetournament <key> [--confirm] [--keep-global]`\n' +
                    'Without `--confirm` you only get a preview.'
                );
            }

            return await runDelete({
                client: message.client,
                guild: message.guild,
                key,
                confirm: flags.includes('--confirm'),
                keepGlobal: flags.includes('--keep-global'),
                actorTag: message.author.tag,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[deletetournament] prefix error:', error);
            return message.reply('❌ Failed to delete tournament.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 You are not authorized to use this command.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runDelete({
                client: interaction.client,
                guild: interaction.guild,
                key: interaction.options.getString('key').toLowerCase(),
                confirm: interaction.options.getBoolean('confirm') === true,
                keepGlobal: interaction.options.getBoolean('keep_global') === true,
                actorTag: interaction.user.tag,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[deletetournament] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to delete tournament.');
            }

            return interaction.reply({
                content: '❌ Failed to delete tournament.',
                ephemeral: true
            });
        }
    }
};

async function runDelete({ client, guild, key, confirm, keepGlobal, actorTag, reply }) {
    const tournament = await TournamentSettings.findOne({
        guildId: guild.id,
        tournamentKey: key
    });

    if (!tournament) {
        const all = await getSelectableTournaments(guild.id, { includeCompleted: true });
        const list = all.map(t => `\`${t.tournamentKey}\``).join(', ') || 'none';
        return reply({
            content: `❌ Tournament \`${key}\` not found.\nAvailable: ${list}`
        });
    }

    const config = await ServerConfig.findOne({ guildId: guild.id }).lean();
    const isDefault = String(config?.defaultTournamentKey || '').toLowerCase() === tournament.tournamentKey;

    /* ── Preview ── */
    if (!confirm) {
        const [teams, players, fixtures] = await Promise.all([
            TournamentTeam.countDocuments({ guildId: guild.id, tournamentId: tournament._id }),
            TournamentPlayer.countDocuments({ guildId: guild.id, tournamentId: tournament._id }),
            Fixture.countDocuments({ guildId: guild.id, tournamentId: tournament._id })
        ]);

        const embed = new EmbedBuilder()
            .setColor(0xF39C12)
            .setTitle('⚠️ DELETE TOURNAMENT — PREVIEW')
            .setDescription(
                `${tournament.emoji || '🏆'} **${tournament.name}** (\`${tournament.tournamentKey}\`)\n` +
                `Phase: \`${tournament.currentPhase}\`${isDefault ? ' • **current default**' : ''}\n\n` +
                `Team entries: **${teams}**\n` +
                `Player entries: **${players}**\n` +
                `Fixtures: **${fixtures}**\n\n` +
                (keepGlobal
                    ? 'Global teams/players will be **kept** (`--keep-global`).'
                    : 'Global teams/players that are **not used by another tournament** will be deleted too. ' +
                      'Players with event stats are kept (only detached from the old team).') +
                '\n\n**Nothing was deleted.** Re-run with `--confirm` (slash: `confirm:true`) to delete.'
            )
            .setTimestamp();

        return reply({ embeds: [embed] });
    }

    /* ── Delete ── */
    const s = await purgeTournament({
        client,
        guildId: guild.id,
        tournament,
        removeGlobalLeftovers: !keepGlobal
    });

    const lines = [
        `Tournament settings deleted: **${s.settings}**`,
        `Team entries deleted: **${s.tournamentTeams}**`,
        `Player entries deleted: **${s.tournamentPlayers}**`,
        `Fixtures deleted: **${s.fixtures}**`,
        `Live messages unlinked: **${s.liveMessages}**`,
        `Profile trophies/awards removed (profiles touched): **${s.profiles}**`,
        `Draw session: **${s.draw}**`
    ];

    if (!keepGlobal) {
        lines.push(
            `Global teams deleted: **${s.teamsDeleted}**`,
            `Global players deleted: **${s.playersDeleted}**`,
            `Players detached (kept: event stats): **${s.playersDetached}**`
        );
    }

    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🗑️ TOURNAMENT DELETED')
        .setDescription(
            `${tournament.emoji || '🏆'} **${tournament.name}** (\`${tournament.tournamentKey}\`) is gone.\n\n` +
            lines.join('\n') +
            (s.defaultCleared
                ? '\n\n⚠️ It was the **default tournament**. Set a new one with `.setdefaulttournament <key>` ' +
                  '(until then the newest tournament is used).'
                : '')
        )
        .addFields({
            name: 'Unaffected',
            value: 'Other tournaments and all events (including their stats) were not touched.'
        })
        .setFooter({ text: `Action performed by ${actorTag}` })
        .setTimestamp();

    return reply({ embeds: [embed] });
}
