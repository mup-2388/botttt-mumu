/**
 * withdrawnresults.js
 *
 * Replace Matchday 14+ results involving Kohli Ki Toli or Manchester Undivided
 * with a normal 3-0 result for the other team. Database-only: no announcements.
 *
 * Usage: .withdrawnresults confirm
 * Slash: /withdrawnresults confirm:true
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { Fixture, TournamentTeam } = require('../../models/Tournament');
const { getDefaultTournament } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { matchdayNumber } = require('../../utils/matchdayAnnouncement');

const FIRST_MATCHDAY = 14;
const WITHDRAWN_TEAM_NAMES = new Set([
    'Kohli Ki Toli',
    'Manchester Undivided'
].map(normalizeTeamName));
const STANDING_PHASES = new Set(['league', 'group']);
const STAT_FIELDS = ['played', 'wins', 'draws', 'losses', 'gf', 'ga', 'points'];

module.exports = {
    name: 'withdrawnresults',
    description: 'Set Matchday 14+ results against the two withdrawn teams to 3-0.',
    usage: '.withdrawnresults confirm',
    aliases: [],
    hidden: false,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('withdrawnresults')
        .setDescription('Set Matchday 14+ results against the withdrawn teams to 3-0')
        .addBooleanOption(option =>
            option.setName('confirm')
                .setDescription('Confirm the database update')
                .setRequired(true)
        ),

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            if (!args.some(arg => String(arg).toLowerCase() === 'confirm')) {
                return message.reply('⚠️ Run `.withdrawnresults confirm` to apply the result changes.');
            }

            return await runWithdrawnResults({
                guild: message.guild,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[withdrawnresults] prefix error:', error);
            return message.reply('❌ Failed to update the fixture results.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
            }

            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            if (!interaction.options.getBoolean('confirm')) {
                return interaction.reply({
                    content: '⚠️ Set `confirm` to `true` to apply the result changes.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runWithdrawnResults({
                guild: interaction.guild,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[withdrawnresults] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to update the fixture results.');
            }

            return interaction.reply({
                content: '❌ Failed to update the fixture results.',
                ephemeral: true
            });
        }
    }
};

async function runWithdrawnResults({ guild, reply }) {
    const tournament = await getDefaultTournament(guild.id);
    if (!tournament) {
        return reply({ content: '❌ No default tournament is set.' });
    }

    const fixtures = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id
    })
        .select('phase roundLabel matchNumber homeTeam awayTeam homeTeamId awayTeamId homeTournamentTeamId awayTournamentTeamId status result reserved.isReserved reserved.until notes')
        .sort({ matchNumber: 1 });

    const matchedFixtures = [];
    let skippedBetweenWithdrawnTeams = 0;

    for (const fixture of fixtures) {
        const day = matchdayNumber(fixture);
        if (!Number.isInteger(day) || day < FIRST_MATCHDAY) continue;

        const homeIsWithdrawn = WITHDRAWN_TEAM_NAMES.has(normalizeTeamName(fixture.homeTeam));
        const awayIsWithdrawn = WITHDRAWN_TEAM_NAMES.has(normalizeTeamName(fixture.awayTeam));
        if (!homeIsWithdrawn && !awayIsWithdrawn) continue;

        if (homeIsWithdrawn && awayIsWithdrawn) {
            skippedBetweenWithdrawnTeams++;
            continue;
        }

        matchedFixtures.push({ fixture, homeIsWithdrawn });
    }

    if (!matchedFixtures.length) {
        return reply({ content: '📭 No matching fixtures from Matchday 14 onward were found.' });
    }

    const affectsStandings = matchedFixtures.some(({ fixture }) => STANDING_PHASES.has(String(fixture.phase || '').toLowerCase()));
    const entries = affectsStandings
        ? await TournamentTeam.find({ guildId: guild.id, tournamentId: tournament._id })
        : [];
    const teamEntries = buildTeamEntryLookup(entries);
    const teamStatDeltas = new Map();
    const updates = [];

    for (const { fixture, homeIsWithdrawn } of matchedFixtures) {
        const homeScore = homeIsWithdrawn ? 0 : 3;
        const awayScore = homeIsWithdrawn ? 3 : 0;
        const winner = homeIsWithdrawn ? fixture.awayTeam : fixture.homeTeam;
        const oldStatusIsPlayed = String(fixture.status || '').toLowerCase() === 'played';
        const phaseAffectsStandings = STANDING_PHASES.has(String(fixture.phase || '').toLowerCase());

        if (phaseAffectsStandings) {
            const homeEntry = findTeamEntry(fixture, 'home', teamEntries);
            const awayEntry = findTeamEntry(fixture, 'away', teamEntries);
            if (!homeEntry || !awayEntry) {
                return reply({
                    content: `❌ Tournament team entries are missing for match #${fixture.matchNumber}; no results were changed.`
                });
            }

            if (oldStatusIsPlayed) {
                const oldHomeScore = readExistingScore(fixture.result?.home);
                const oldAwayScore = readExistingScore(fixture.result?.away);
                if (oldHomeScore === null || oldAwayScore === null) {
                    return reply({
                        content: `❌ Match #${fixture.matchNumber} is marked Played but has no valid score; no results were changed.`
                    });
                }

                accumulateResultDelta(teamStatDeltas, homeEntry, oldHomeScore, oldAwayScore, tournament, -1);
                accumulateResultDelta(teamStatDeltas, awayEntry, oldAwayScore, oldHomeScore, tournament, -1);
            }

            accumulateResultDelta(teamStatDeltas, homeEntry, homeScore, awayScore, tournament, 1);
            accumulateResultDelta(teamStatDeltas, awayEntry, awayScore, homeScore, tournament, 1);
        }

        const existingResult = fixture.result || {};
        const alreadyCorrect = oldStatusIsPlayed &&
            Number(existingResult.home) === homeScore &&
            Number(existingResult.away) === awayScore &&
            String(existingResult.winner || '') === String(winner || '') &&
            existingResult.extraTimeHome == null &&
            existingResult.extraTimeAway == null &&
            existingResult.penaltiesHome == null &&
            existingResult.penaltiesAway == null &&
            fixture.reserved?.isReserved !== true &&
            !isWalkoverNote(fixture.notes);

        if (!alreadyCorrect) {
            updates.push({ fixture, homeScore, awayScore, winner });
        }
    }

    // All fixtures and their standings entries are validated before any writes.
    for (const { fixture, homeScore, awayScore, winner } of updates) {
        fixture.status = 'Played';
        fixture.result = {
            home: homeScore,
            away: awayScore,
            extraTimeHome: null,
            extraTimeAway: null,
            penaltiesHome: null,
            penaltiesAway: null,
            winner
        };

        if (fixture.reserved) {
            fixture.reserved.isReserved = false;
            fixture.reserved.until = null;
        }
        if (isWalkoverNote(fixture.notes)) fixture.notes = '';

        await fixture.save();
    }

    for (const { entry, delta } of teamStatDeltas.values()) {
        if (STAT_FIELDS.every(field => delta[field] === 0)) continue;

        entry.stats = entry.stats || {};
        for (const field of STAT_FIELDS) {
            entry.stats[field] = Math.max(0, numericStat(entry.stats[field]) + delta[field]);
        }
        await entry.save();
    }

    const skippedText = skippedBetweenWithdrawnTeams
        ? ` (${skippedBetweenWithdrawnTeams} fixture${skippedBetweenWithdrawnTeams === 1 ? '' : 's'} between the withdrawn teams left unchanged.)`
        : '';
    return reply({
        content: `✅ Updated ${updates.length} fixture result${updates.length === 1 ? '' : 's'} in **${tournament.name}**.${skippedText}`
    });
}

function normalizeTeamName(value) {
    return String(value || '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function buildTeamEntryLookup(entries) {
    const byId = new Map();
    const byTeamId = new Map();
    const byName = new Map();

    for (const entry of entries) {
        if (entry._id != null) byId.set(String(entry._id), entry);
        if (entry.teamId != null) byTeamId.set(String(entry.teamId), entry);
        const nameKey = normalizeTeamName(entry.teamNameSnapshot);
        if (nameKey) byName.set(nameKey, entry);
    }

    return { byId, byTeamId, byName };
}

function findTeamEntry(fixture, side, lookup) {
    const tournamentTeamId = side === 'home' ? fixture.homeTournamentTeamId : fixture.awayTournamentTeamId;
    const teamId = side === 'home' ? fixture.homeTeamId : fixture.awayTeamId;
    const teamName = side === 'home' ? fixture.homeTeam : fixture.awayTeam;

    return (tournamentTeamId && lookup.byId.get(String(tournamentTeamId))) ||
        (teamId && lookup.byTeamId.get(String(teamId))) ||
        lookup.byName.get(normalizeTeamName(teamName)) ||
        null;
}

function accumulateResultDelta(deltas, entry, goalsFor, goalsAgainst, tournament, multiplier) {
    const key = String(entry._id || entry.teamId || entry.teamNameSnapshot);
    let record = deltas.get(key);

    if (!record) {
        record = {
            entry,
            delta: Object.fromEntries(STAT_FIELDS.map(field => [field, 0]))
        };
        deltas.set(key, record);
    }

    const result = resultStatVector(goalsFor, goalsAgainst, tournament);
    for (const field of STAT_FIELDS) record.delta[field] += result[field] * multiplier;
}

function resultStatVector(goalsFor, goalsAgainst, tournament) {
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let points = 0;

    if (goalsFor > goalsAgainst) {
        wins = 1;
        points = Number(tournament.pointsWin ?? 3);
    } else if (goalsFor < goalsAgainst) {
        losses = 1;
        points = Number(tournament.pointsLoss ?? 0);
    } else {
        draws = 1;
        points = Number(tournament.pointsDraw ?? 1);
    }

    return { played: 1, wins, draws, losses, gf: goalsFor, ga: goalsAgainst, points };
}

function numericStat(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function readExistingScore(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

function isWalkoverNote(value) {
    return /^\s*(?:walkover|free\s*win|forfeit)\s*:/i.test(String(value || ''));
}

module.exports.runWithdrawnResults = runWithdrawnResults;
module.exports.normalizeTeamName = normalizeTeamName;
module.exports.matchdayNumber = matchdayNumber;
