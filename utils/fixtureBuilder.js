/**
 * fixtureBuilder.js
 *
 * Shared fixture generation utilities for tournament commands.
 * Used by generatestage.js and finishdraw.js to avoid duplication.
 *
 * All builders accept NORMALIZED team objects:
 *   { tournamentTeamId, teamId, name }
 *
 * Callers must normalize their own team data before calling these functions.
 */

const { Fixture } = require('../models/Tournament');
const { prettyPhase } = require('./displayHelpers');

const KNOCKOUT_ROUNDS_BY_TEAM_COUNT = {
    2: ['final'],
    4: ['semifinal', 'final'],
    8: ['quarterfinal', 'semifinal', 'final'],
    16: ['roundof16', 'quarterfinal', 'semifinal', 'final']
};

/** Return the straight-knockout rounds for a power-of-two field of 2–16 teams. */
function getKnockoutRounds(teamCount) {
    return KNOCKOUT_ROUNDS_BY_TEAM_COUNT[Number(teamCount)] || [];
}

/**
 * Pair an already seeded power-of-two field in a standard bracket order.
 * Teams are ordered by seed from best to worst; the returned pairs are in
 * bracket order so consecutive winners meet in the next round.
 */
function buildStandardKnockoutPairs(teams) {
    if (!Array.isArray(teams) || !getKnockoutRounds(teams.length).length) return [];

    const seedPositions = getBracketSeedPositions(teams.length);
    const bracket = seedPositions.map(seed => teams[seed - 1]);
    const pairs = [];

    for (let index = 0; index < bracket.length; index += 2) {
        pairs.push([bracket[index], bracket[index + 1]]);
    }

    return pairs;
}

function getBracketSeedPositions(size) {
    if (size === 1) return [1];

    const previous = getBracketSeedPositions(size / 2);
    return previous.flatMap(seed => [seed, size + 1 - seed]);
}

/* ====================================================
   ROUND-ROBIN BUILDER
==================================================== */

/**
 * Build round-robin fixtures using the circle method.
 *
 * @param {Object} opts
 * @param {string} opts.guildId
 * @param {Object} opts.tournament - TournamentSettings document
 * @param {Array} opts.teams - Normalized team objects [{ tournamentTeamId, teamId, name }]
 * @param {string} opts.phase - 'league' | 'group' | etc.
 * @param {string} opts.roundPrefix - e.g. 'Matchday' or 'Group A Matchday'
 * @param {string|null} opts.groupKey
 * @param {boolean} opts.homeAway - Generate second-leg fixtures?
 * @param {number} opts.startMatchNumber
 * @returns {Array} Fixture documents (not yet saved)
 */
function buildRoundRobinFixtures({
    guildId,
    tournament,
    teams,
    phase,
    roundPrefix,
    groupKey,
    homeAway,
    startMatchNumber
}) {
    const list = teams.map(entry => ({
        tournamentTeamId: entry.tournamentTeamId,
        teamId: entry.teamId,
        name: entry.name
    }));

    // Add bye for odd number of teams
    if (list.length % 2 !== 0) {
        list.push({ name: '__BYE__' });
    }

    const totalRounds = list.length - 1;
    const half = list.length / 2;
    let rotation = [...list];

    const fixtures = [];
    let matchNumber = startMatchNumber;

    for (let round = 0; round < totalRounds; round++) {
        for (let i = 0; i < half; i++) {
            const home = rotation[i];
            const away = rotation[rotation.length - 1 - i];

            // Skip bye matches
            if (home.name === '__BYE__' || away.name === '__BYE__') continue;

            fixtures.push(buildFixtureDoc({
                guildId,
                tournament,
                phase,
                groupKey,
                roundLabel: `${roundPrefix} ${round + 1}`,
                matchNumber: matchNumber++,
                home,
                away
            }));
        }

        // Rotate teams (circle method)
        const fixed = rotation[0];
        const rest = rotation.slice(1);
        rest.unshift(rest.pop());
        rotation = [fixed, ...rest];
    }

    // Generate second-leg fixtures if home/away is enabled
    if (homeAway) {
        const firstLeg = [...fixtures];

        for (const fixture of firstLeg) {
            fixtures.push(buildFixtureDoc({
                guildId,
                tournament,
                phase,
                groupKey,
                roundLabel: `${roundPrefix} ${extractRoundNumber(fixture.roundLabel) + totalRounds}`,
                matchNumber: matchNumber++,
                home: {
                    tournamentTeamId: fixture.awayTournamentTeamId,
                    teamId: fixture.awayTeamId,
                    name: fixture.awayTeam
                },
                away: {
                    tournamentTeamId: fixture.homeTournamentTeamId,
                    teamId: fixture.homeTeamId,
                    name: fixture.homeTeam
                }
            }));
        }
    }

    return fixtures;
}

/* ====================================================
   ONE-MATCH-PER-TEAM QUALIFIER
==================================================== */

/**
 * Build one qualifier fixture for every team, pairing teams in a shuffled draw.
 * This is used by Glory Cup: it deliberately creates only one matchday, not a
 * complete round-robin schedule. An odd number of teams cannot satisfy the
 * one-match-per-team rule, so callers must handle that case before generation.
 */
function buildOneMatchPerTeamFixtures({
    guildId,
    tournament,
    teams,
    phase = 'league',
    roundLabel = 'Matchday 1',
    startMatchNumber = 1,
    random = Math.random
}) {
    if (!Array.isArray(teams) || teams.length < 2) return [];
    if (teams.length % 2 !== 0) {
        throw new RangeError('One-match-per-team fixtures require an even number of teams.');
    }

    const draw = teams.map(entry => ({
        tournamentTeamId: entry.tournamentTeamId,
        teamId: entry.teamId,
        name: entry.name
    }));

    // Fisher-Yates draw so pairings are not determined by registration order.
    for (let i = draw.length - 1; i > 0; i--) {
        const swapIndex = Math.floor(random() * (i + 1));
        [draw[i], draw[swapIndex]] = [draw[swapIndex], draw[i]];
    }

    const fixtures = [];
    for (let i = 0; i < draw.length; i += 2) {
        fixtures.push(buildFixtureDoc({
            guildId,
            tournament,
            phase,
            groupKey: null,
            roundLabel,
            matchNumber: startMatchNumber + i / 2,
            home: draw[i],
            away: draw[i + 1]
        }));
    }

    return fixtures;
}

/* ====================================================
   KNOCKOUT BUILDER
==================================================== */

/**
 * Build knockout fixtures from pairs of teams.
 * Supports two-legged ties with aggregate tie keys.
 *
 * @param {Object} opts
 * @param {string} opts.guildId
 * @param {Object} opts.tournament
 * @param {string} opts.phase
 * @param {Array} opts.pairs - Array of [home, away] normalized team pairs
 * @param {boolean} opts.twoLegged
 * @param {number} opts.startMatchNumber
 * @returns {Array} Fixture documents (not yet saved)
 */
function buildKnockoutFixtures({
    guildId,
    tournament,
    phase,
    pairs,
    twoLegged,
    startMatchNumber
}) {
    const fixtures = [];
    let matchNumber = startMatchNumber;

    for (let i = 0; i < pairs.length; i++) {
        const [home, away] = pairs[i];
        const roundLabel = `${prettyPhase(phase)} ${i + 1}`;
        const tieKey = `${tournament.tournamentKey}_${phase}_${i + 1}`;

        // Leg 1
        fixtures.push(buildFixtureDoc({
            guildId,
            tournament,
            phase,
            groupKey: null,
            roundLabel,
            matchNumber: matchNumber++,
            home,
            away,
            aggregateTieKey: twoLegged ? tieKey : null,
            leg: 1
        }));

        // Leg 2 (if two-legged)
        if (twoLegged) {
            fixtures.push(buildFixtureDoc({
                guildId,
                tournament,
                phase,
                groupKey: null,
                roundLabel,
                matchNumber: matchNumber++,
                home: away,
                away: home,
                aggregateTieKey: tieKey,
                leg: 2
            }));
        }
    }

    return fixtures;
}

/* ====================================================
   SINGLE FIXTURE DOCUMENT
==================================================== */

/**
 * Build a single fixture document object.
 *
 * @param {Object} opts
 * @param {string} opts.guildId
 * @param {Object} opts.tournament
 * @param {string} opts.phase
 * @param {string|null} opts.groupKey
 * @param {string} opts.roundLabel
 * @param {number} opts.matchNumber
 * @param {Object} opts.home - { tournamentTeamId, teamId, name }
 * @param {Object} opts.away - { tournamentTeamId, teamId, name }
 * @param {string|null} opts.aggregateTieKey
 * @param {number} opts.leg
 * @returns {Object} Fixture document (not yet saved)
 */
function buildFixtureDoc({
    guildId,
    tournament,
    phase,
    groupKey,
    roundLabel,
    matchNumber,
    home,
    away,
    aggregateTieKey = null,
    leg = 1
}) {
    return {
        guildId,
        tournamentId: tournament._id,
        tournamentKey: tournament.tournamentKey,

        phase,
        roundLabel,
        groupKey,
        leg,
        matchNumber,

        homeTeam: home.name,
        awayTeam: away.name,

        homeTeamId: home.teamId || null,
        awayTeamId: away.teamId || null,

        homeTournamentTeamId: home.tournamentTeamId || null,
        awayTournamentTeamId: away.tournamentTeamId || null,

        venueType: phase === 'final' && tournament.finalNeutralVenue ? 'neutral' : 'home',
        venueName: phase === 'final' && tournament.finalNeutralVenue ? 'Neutral Ground' : 'Home Ground',

        scheduledAt: null,
        status: 'Pending',

        result: {
            home: null,
            away: null,
            extraTimeHome: null,
            extraTimeAway: null,
            penaltiesHome: null,
            penaltiesAway: null,
            winner: ''
        },

        aggregateTieKey,
        notes: leg > 1 ? `${roundLabel} (Leg ${leg})` : '',

        bracket: {
            advancesToMatchNumber: null,
            slot: ''
        }
    };
}

/* ====================================================
   HELPERS
==================================================== */

/** Get the next available match number for a tournament. */
async function getNextMatchNumber(guildId, tournamentId) {
    const latest = await Fixture.findOne({ guildId, tournamentId })
        .sort({ matchNumber: -1 })
        .select('matchNumber');

    return latest ? latest.matchNumber + 1 : 1;
}

/** Extract the numeric part from a round label like "Group A Matchday 3". */
function extractRoundNumber(label) {
    const match = String(label || '').match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
}

module.exports = {
    getKnockoutRounds,
    buildStandardKnockoutPairs,
    buildRoundRobinFixtures,
    buildOneMatchPerTeamFixtures,
    buildKnockoutFixtures,
    buildFixtureDoc,
    getNextMatchNumber,
    extractRoundNumber
};
