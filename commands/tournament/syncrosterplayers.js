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
                return message.reply(embedNotice(
                    'Organizer only',
                    'Only an organizer can sync tournament rosters.',
                    0xED4245
                ));
            }

            const parsedTournament = await extractTournamentFromArgs(message.guild.id, args);
            if (parsedTournament.error) {
                return message.reply(embedNotice('Tournament roster sync', parsedTournament.error, 0xED4245));
            }

            const { reactivateWithdrawn, rest, error } = parseReactivateToken(parsedTournament.rest);
            if (error) return message.reply(embedNotice('Tournament roster sync', error, 0xED4245));

            const resolved = parsedTournament.tournament
                ? { tournament: parsedTournament.tournament, error: null }
                : await resolveTournament(message.guild.id, null);
            if (!resolved.tournament) {
                return message.reply(embedNotice('Tournament roster sync', resolved.error, 0xED4245));
            }

            const parsedTeam = await parseTeamTokenInTournament(
                message.guild.id,
                resolved.tournament,
                rest
            );
            if (parsedTeam.rest.length) {
                return message.reply(embedNotice(
                    'Tournament roster sync',
                    'Unknown arguments. Use `team=<Team Name>`, `tournament=<key>`, and/or `reactivate=true`.',
                    0xED4245
                ));
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
            return message.reply(embedNotice(
                'Tournament roster sync failed',
                'Failed to sync tournament rosters.',
                0xED4245
            ));
        }
    },

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild, interaction.user.id))) {
                return interaction.reply({
                    ...embedNotice('Organizer only', 'Only an organizer can sync tournament rosters.', 0xED4245),
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });
            const resolved = await resolveTournament(
                interaction.guild.id,
                interaction.options.getString('tournament')?.toLowerCase() || null
            );
            if (!resolved.tournament) {
                return interaction.editReply(embedNotice('Tournament roster sync', resolved.error, 0xED4245));
            }

            return await runSync({
                guild: interaction.guild,
                tournament: resolved.tournament,
                teamName: interaction.options.getString('team'),
                reactivateWithdrawn: interaction.options.getBoolean('reactivate_withdrawn') ?? false,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[syncrosterplayers] slash error:', error);
            const failure = embedNotice(
                'Tournament roster sync failed',
                'Failed to sync tournament rosters.',
                0xED4245
            );
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(failure);
            }
            return interaction.reply({ ...failure, ephemeral: true });
        }
    }
};

async function runSync({ guild, tournament, teamName, reactivateWithdrawn, reply }) {
    const result = await syncTournamentRosterPlayers(guild.id, tournament, {
        teamName,
        reactivateWithdrawn
    });
    const addedLines = formatPlayerLines(result.addedPlayers || []);
    const reactivatedLines = formatPlayerLines(result.reactivatedPlayers || []);
    const preservedLines = result.examples.slice(0, 6).map(item =>
        `• **${shortText(item.playerName, 60)}** (${shortText(item.teamName, 60)}) — ${shortText(item.reason, 100)}`
    );
    const skippedLines = result.skippedTeams.slice(0, 6).map(item =>
        `• **${shortText(item.teamName || teamName || 'Tournament', 60)}** — ${shortText(item.reason, 100)}`
    );
    if (result.examples.length > preservedLines.length) {
        preservedLines.push(`…and ${result.examples.length - preservedLines.length} more preserved player(s).`);
    }
    if (result.skippedTeams.length > skippedLines.length) {
        skippedLines.push(`…and ${result.skippedTeams.length - skippedLines.length} more team(s) skipped.`);
    }

    const details = [
        addedLines.length ? `**Added players**\n${addedLines.join('\n')}` : '',
        reactivatedLines.length ? `**Reactivated players**\n${reactivatedLines.join('\n')}` : '',
        preservedLines.length ? `**Preserved entries**\n${preservedLines.join('\n')}` : '',
        skippedLines.length ? `**Skipped teams**\n${skippedLines.join('\n')}` : ''
    ].filter(Boolean).join('\n\n');

    return reply({
        embeds: [{
            color: 0x5865F2,
            title: 'Tournament Roster Sync',
            description:
                `Completed for **${shortText(tournament.name, 120)}**` +
                `${teamName ? ` — **${shortText(teamName, 80)}**` : ''}.` +
                (details ? `\n\n${details}` : ''),
            fields: [
                { name: 'Added', value: String(result.added), inline: true },
                { name: 'Already on team', value: String(result.alreadyPresent), inline: true },
                { name: 'Legacy active flags repaired', value: String(result.legacyActiveFlagsRepaired || 0), inline: true },
                { name: 'Reactivated', value: String(result.reactivated), inline: true },
                { name: 'Withdrawn preserved', value: String(result.withdrawnPreserved), inline: true },
                { name: 'Free agents preserved', value: String(result.freeAgentsPreserved), inline: true },
                { name: 'Assigned elsewhere preserved', value: String(result.otherTeamsPreserved), inline: true }
            ],
            footer: {
                text: `${reactivateWithdrawn
                    ? 'Withdrawn entries were explicitly reactivated where they matched a global team.'
                    : 'Withdrawn entries remain inactive by default.'} Mentions shown in the embed are display-only; no notification pings were sent.`
            }
        }],
        allowedMentions: { parse: [] }
    });
}

function formatPlayerLines(players) {
    const lines = players.slice(0, 6).map(player => {
        const discordID = String(player.discordID || '');
        const label = /^\d{15,22}$/.test(discordID)
            ? `<@${discordID}>`
            : `**${shortText(player.playerName, 60)}**`;
        return `• ${label}`;
    });
    if (players.length > lines.length) {
        lines.push(`…and ${players.length - lines.length} more player(s).`);
    }
    return lines;
}

function embedNotice(title, description, color = 0x5865F2) {
    return {
        embeds: [{ title, description: shortText(description, 4000), color }],
        allowedMentions: { parse: [] }
    };
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
