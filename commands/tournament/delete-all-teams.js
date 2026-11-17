/**
 * delete-all-teams.js
 *
 * Preview and remove every server-wide Team record in the current Discord
 * server. Global Player records and all player stats/awards are preserved.
 *
 * Usage:  .deleteallteams           -> preview
 *         .deleteallteams confirm  -> delete
 * Slash:  /delete-all-teams confirm:false|true
 *
 * The command reuses delete-team's cascade for each team, so active tournament
 * entries are deactivated, players become free agents, and unplayed fixtures
 * are cancelled without deleting player or historical tournament stats.
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    escapeMarkdown
} = require('discord.js');

const { Team, Player } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { runDeleteTeam } = require('./delete-team');

const PREVIEW_TEAM_LIMIT = 20;
const TEAM_NAME_DISPLAY_LIMIT = 80;

module.exports = {
    name: 'delete-all-teams',
    description: 'Preview or delete this server’s teams while preserving player stats and awards.',
    usage: '.deleteallteams [confirm]',
    aliases: ['deleteallteams'],
    // Keep this destructive utility behind prefix access if the global slash
    // command cap is full; the deployer prioritizes visible commands.
    hidden: true,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('delete-all-teams')
        .setDescription('Preview or delete this server’s teams; preserves player stats and awards')
        .addBooleanOption(option =>
            option.setName('confirm')
                .setDescription('false = preview only; true = remove all teams')
                .setRequired(true)
        ),

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const tokens = args.map(argument => String(argument).trim().toLowerCase());
            const validTokens = tokens.every(token => token === 'confirm' || token === '--confirm');
            if (!validTokens || tokens.length > 1) {
                return message.reply('❓ Use `.deleteallteams` to preview, then `.deleteallteams confirm` to delete.');
            }

            return await runDeleteAllTeams({
                guild: message.guild,
                confirm: tokens.length === 1,
                actorTag: message.author.tag || message.author.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[delete-all-teams] prefix error:', error);
            return message.reply('❌ Failed to process the server-team cleanup.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({
                    content: '❌ This command can only be used in a server.',
                    ephemeral: true
                });
            }

            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runDeleteAllTeams({
                guild: interaction.guild,
                confirm: interaction.options.getBoolean('confirm') === true,
                actorTag: interaction.user.tag || interaction.user.id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[delete-all-teams] slash error:', error);

            const payload = { content: '❌ Failed to process the server-team cleanup.' };
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(payload);
            }
            return interaction.reply({ ...payload, ephemeral: true });
        }
    }
};

async function runDeleteAllTeams({ guild, confirm, actorTag, reply }) {
    const teams = await Team.find({ guildId: guild.id })
        .select('_id name')
        .sort({ name: 1 })
        .lean();

    if (!teams.length) {
        return reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x95A5A6)
                    .setTitle('No Teams Found')
                    .setDescription('There are no server-wide teams to remove. No changes were made.')
                    .setTimestamp()
            ]
        });
    }

    const teamIds = teams.map(team => team._id);
    const playerCount = await Player.countDocuments({
        guildId: guild.id,
        teamId: { $in: teamIds }
    });

    if (!confirm) {
        const listedTeams = teams
            .slice(0, PREVIEW_TEAM_LIMIT)
            .map(team => `• ${safeTeamName(team.name)}`)
            .join('\n');
        const remainingCount = teams.length - Math.min(teams.length, PREVIEW_TEAM_LIMIT);
        const moreTeams = remainingCount > 0 ? `\n…and ${remainingCount} more` : '';

        const embed = new EmbedBuilder()
            .setColor(0xF39C12)
            .setTitle('⚠️ DELETE ALL SERVER TEAMS — PREVIEW')
            .setDescription(
                `Teams in this server: **${teams.length}**\n` +
                `${listedTeams}${moreTeams}\n\n` +
                `Players to detach as free agents: **${playerCount}**\n\n` +
                '**Nothing has been changed.** Re-run `.deleteallteams confirm` (slash: `confirm:true`) to proceed.'
            )
            .addFields({
                name: 'What confirmation will do',
                value:
                    'Delete the global Team records, clear players’ team/captain assignments, deactivate their active tournament-team entries, ' +
                    'cancel their unplayed fixtures, and attempt configured role cleanup. Player records, player stats, tournament player stats, ' +
                    'all-time stats, trophies, and awards are preserved. Team-level legacy stats are removed with the teams.'
            })
            .setFooter({ text: `Preview requested by ${safeTeamName(actorTag || 'Organizer')}` })
            .setTimestamp();

        return reply({ embeds: [embed] });
    }

    let teamsDeleted = 0;
    let failedTeam = null;
    let failure = null;

    for (const team of teams) {
        try {
            let missing = false;
            await runDeleteTeam({
                guild,
                teamName: team.name,
                reply: payload => {
                    if (String(payload?.content || '').startsWith('ℹ️ Team not found:')) {
                        missing = true;
                    }
                    return null;
                }
            });
            if (!missing) teamsDeleted++;
        } catch (error) {
            failedTeam = team.name;
            failure = error;
            break;
        }
    }

    const completed = !failure && teamsDeleted === teams.length;
    const embed = new EmbedBuilder()
        .setColor(completed ? 0x2ECC71 : 0xE74C3C)
        .setTitle(completed ? '🗑️ SERVER TEAMS REMOVED' : '⚠️ TEAM REMOVAL PARTIALLY COMPLETED')
        .setDescription(
            `Team records removed: **${teamsDeleted}** of **${teams.length}**\n` +
            `Player records deleted: **0**\n\n` +
            'Player stats, tournament player stats, all-time stats, trophies, and awards were not deleted. ' +
            'Players on removed teams are now free agents. Team-level legacy stats were removed with the Team records.\n\n' +
            (failure
                ? `Stopped on **${safeTeamName(failedTeam)}**: ${safeTeamName(failure.message || 'database error')}. ` +
                  'Some updates for that team may already have applied; preview again before retrying.'
                : 'Active tournament-team entries were deactivated, unplayed fixtures were cancelled, and configured role cleanup was attempted.')
        )
        .setFooter({ text: `Action performed by ${safeTeamName(actorTag || 'Organizer')}` })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

function safeTeamName(value) {
    const text = String(value || 'Unknown')
        .replace(/@/g, '@\u200b')
        .replace(/</g, '‹')
        .replace(/>/g, '›')
        .replace(/[\r\n]+/g, ' ');
    const escaped = escapeMarkdown(text);
    return escaped.length > TEAM_NAME_DISPLAY_LIMIT
        ? `${escaped.slice(0, TEAM_NAME_DISPLAY_LIMIT - 1)}…`
        : escaped;
}

module.exports.runDeleteAllTeams = runDeleteAllTeams;
