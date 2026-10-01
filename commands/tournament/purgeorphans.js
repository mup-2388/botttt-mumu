/**
 * purgeorphans.js
 *
 * Clean up LEFTOVER global teams & players: teams that are not registered in
 * ANY existing tournament (typically left behind after `/resettournament`
 * wiped a tournament, e.g. an old Nations League) and the players that were
 * only attached to them.
 *
 * After this, `mystats`, `nick`, `release`, `setvicecaptain`, auto-sync … can
 * no longer see those old teams.
 *
 * Safety:
 *   - teams registered in any tournament are never touched
 *   - players with EVENT stats are kept (only detached from the old team)
 *
 * Usage:  .purgeorphans             → preview
 *         .purgeorphans --confirm   → delete
 * Slash:  /purgeorphans confirm:<true|false>
 *
 * Aliases: cleanorphans, purgeglobal
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { isOrganizer } = require('../../utils/isOrganizer');
const {
    findOrphanTeams,
    findOrphanPlayers,
    removeGlobalTeams
} = require('../../utils/tournamentCleanup');

module.exports = {
    name: 'purgeorphans',
    description: 'Delete leftover teams/players that are not part of any tournament.',
    usage: '.purgeorphans [--confirm]',
    aliases: ['cleanorphans', 'purgeglobal'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('purgeorphans')
        .setDescription('Delete leftover teams/players that are not part of any tournament')
        .addBooleanOption(opt =>
            opt.setName('confirm')
                .setDescription('true = delete for real, false = preview only')
                .setRequired(true)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 You are not authorized to use this command.');
            }

            return await run({
                guild: message.guild,
                confirm: args.includes('--confirm'),
                actorTag: message.author.tag,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[purgeorphans] prefix error:', error);
            return message.reply('❌ Failed to purge leftovers.');
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

            return await run({
                guild: interaction.guild,
                confirm: interaction.options.getBoolean('confirm') === true,
                actorTag: interaction.user.tag,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[purgeorphans] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to purge leftovers.');
            }

            return interaction.reply({ content: '❌ Failed to purge leftovers.', ephemeral: true });
        }
    }
};

async function run({ guild, confirm, actorTag, reply }) {
    const teams = await findOrphanTeams(guild.id);
    const teamIds = teams.map(t => t._id);
    const players = await findOrphanPlayers(guild.id, { orphanTeamIds: teamIds });

    const teamList = teams.slice(0, 25).map(t => `• ${t.name}`).join('\n') || '—';
    const more = teams.length > 25 ? `\n…and ${teams.length - 25} more` : '';

    if (!confirm) {
        const embed = new EmbedBuilder()
            .setColor(0xF39C12)
            .setTitle('⚠️ PURGE LEFTOVERS — PREVIEW')
            .setDescription(
                `Teams not registered in any tournament: **${teams.length}**\n${teamList}${more}\n\n` +
                `Players with no tournament, no event stats and no live team: **${players.length}**\n\n` +
                '**Nothing was deleted.** Re-run with `--confirm` (slash: `confirm:true`) to delete.'
            )
            .setTimestamp();

        return reply({ embeds: [embed] });
    }

    const result = await removeGlobalTeams(guild.id, teamIds, {
        extraPlayerIds: players.map(p => p._id)
    });

    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🧹 LEFTOVERS PURGED')
        .setDescription(
            `Global teams deleted: **${result.teamsDeleted}**\n` +
            `Global players deleted: **${result.playersDeleted}**\n` +
            `Players detached (kept because of event stats): **${result.playersDetached}**`
        )
        .addFields({
            name: 'Unaffected',
            value: 'Tournaments, tournament teams/players, events and their stats were not touched.'
        })
        .setFooter({ text: `Action performed by ${actorTag}` })
        .setTimestamp();

    return reply({ embeds: [embed] });
}
