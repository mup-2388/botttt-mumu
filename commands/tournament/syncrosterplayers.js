/**
 * syncrosterplayers.js
 *
 * Enrolls global players into active tournament team rosters when they have no
 * active tournament assignment. Withdrawals, free agents, and tournament-only
 * transfers are preserved by default. Organizers may explicitly opt into
 * restoring withdrawn entries with reactivate=true.
 *
 * Usage: .syncrosterplayers [team=<Team Name>] [tournament=<key>] [reactivate=true]
 * Slash: /syncrosterplayers [team:<name>] [tournament:<key>] [reactivate_withdrawn:true]
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { isOrganizer } = require('../../utils/isOrganizer');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const { parseTeamTokenInTournament } = require('../../utils/tournamentContext');
const { syncTournamentRosterPlayers } = require('../../utils/tournamentRosterSync');

module.exports = {
    name: 'syncrosterplayers',
    description: 'Add missing global players to active tournament team rosters.',
    usage: '[team=<Team Name>] [tournament=<key>] [reactivate=true]',
    aliases: ['srp', 'syncplayers'],
    category: 'tournament',
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('syncrosterplayers')
        .setDescription('Add missing global players to active tournament team rosters')
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Only sync this team (default: all active tournament teams)')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('reactivate_withdrawn')
                .setDescription('Explicitly re-enroll withdrawn players')
                .setRequired(false)
        ),

    async execute(message, args = []) {
        try {
            if (!message.guild) return;
            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Only an organizer can sync tournament rosters.');
            }

            const parsedTournament = await extractTournamentFromArgs(message.guild.id, args);
            if (parsedTournament.error) return message.reply(parsedTournament.error);

            const { reactivateWithdrawn, rest, error } = parseReactivateToken(parsedTournament.rest);
            if (error) return message.reply(error);

            const resolved = parsedTournament.tournament
                ? { tournament: parsedTournament.tournament, error: null }
                : await resolveTournament(message.guild.id, null);
            if (!resolved.tournament) return message.reply(resolved.error);

            const parsedTeam = await parseTeamTokenInTournament(
                message.guild.id,
                resolved.tournament,
                rest
            );
            if (parsedTeam.rest.length) {
                return message.reply(
                    '❌ Unknown arguments. Use `team=<Team Name>`, `tournament=<key>`, and/or `reactivate=true`.'
                );
            }

            return await runSync({
                guild: message.guild,
                tournament: resolved.tournament,
                teamName: parsedTeam.teamName,
                reactivateWithdrawn,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[syncrosterplayers] prefix error:', error);
            return message.reply('❌ Failed to sync tournament rosters.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 Only an organizer can sync tournament rosters.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });
            const resolved = await resolveTournament(
                interaction.guild.id,
                interaction.options.getString('tournament')?.toLowerCase() || null
            );
            if (!resolved.tournament) return interaction.editReply(resolved.error);

            return await runSync({
                guild: interaction.guild,
                tournament: resolved.tournament,
                teamName: interaction.options.getString('team'),
                reactivateWithdrawn: interaction.options.getBoolean('reactivate_withdrawn') ?? false,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[syncrosterplayers] slash error:', error);
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to sync tournament rosters.');
            }
            return interaction.reply({
                content: '❌ Failed to sync tournament rosters.',
                ephemeral: true
            });
        }
    }
};

async function runSync({ guild, tournament, teamName, reactivateWithdrawn, reply }) {
    const result = await syncTournamentRosterPlayers(guild.id, tournament, {
        teamName,
        reactivateWithdrawn
    });
    const examples = result.examples.slice(0, 6).map(item =>
        `• **${shortText(item.playerName, 60)}** (${shortText(item.teamName, 60)}) — ${shortText(item.reason, 100)}`
    );
    const skippedTeams = result.skippedTeams.slice(0, 6).map(item =>
        `• **${shortText(item.teamName || teamName || 'Tournament', 60)}** — ${shortText(item.reason, 100)}`
    );
    const omittedExamples = result.examples.length > examples.length
        ? `\n…and ${result.examples.length - examples.length} more preserved player(s).`
        : '';
    const omittedTeams = result.skippedTeams.length > skippedTeams.length
        ? `\n…and ${result.skippedTeams.length - skippedTeams.length} more team(s) skipped.`
        : '';

    return reply({
        content:
            `✅ **Roster sync completed for ${shortText(tournament.name, 120)}${teamName ? ` — ${shortText(teamName, 80)}` : ''}.**\n` +
            `Added: **${result.added}** • Already on team: **${result.alreadyPresent}** • ` +
            `Reactivated: **${result.reactivated}**\n` +
            `Withdrawn preserved: **${result.withdrawnPreserved}** • Free agents preserved: **${result.freeAgentsPreserved}** • ` +
            `Players assigned to another tournament team preserved: **${result.otherTeamsPreserved}**` +
            (examples.length ? `\n\n${examples.join('\n')}${omittedExamples}` : '') +
            (skippedTeams.length ? `\n\n${skippedTeams.join('\n')}${omittedTeams}` : '') +
            `\n\n${reactivateWithdrawn ? 'Withdrawn entries were explicitly reactivated where they matched a global team.' : 'Withdrawn entries were not reactivated; add `reactivate=true` only if you intend to restore them.'}`,
        allowedMentions: { parse: [] }
    });
}

function shortText(value, maxLength) {
    const text = String(value || 'Unknown').replace(/[\r\n]+/g, ' ');
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseReactivateToken(args = []) {
    let reactivateWithdrawn = false;
    const rest = [];

    for (const arg of args) {
        if (typeof arg === 'string' && /^reactivate=/i.test(arg)) {
            const value = arg.split('=').slice(1).join('=').trim().toLowerCase();
            if (!['true', 'false'].includes(value)) {
                return { reactivateWithdrawn: false, rest: [], error: '❌ Use `reactivate=true` or `reactivate=false`.' };
            }
            reactivateWithdrawn = value === 'true';
        } else {
            rest.push(arg);
        }
    }

    return { reactivateWithdrawn, rest, error: null };
}
