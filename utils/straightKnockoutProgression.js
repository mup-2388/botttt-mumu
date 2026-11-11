const { Fixture } = require('../models/Tournament');
const { getFixtureWinnerSide, isKnockoutPhase } = require('./knockoutResults');

const PHASE_ORDER = ['roundof16', 'quarterfinal', 'semifinal', 'final'];
const ROUNDS_BY_TEAM_COUNT = {
    2: ['final'],
    4: ['semifinal', 'final'],
    8: ['quarterfinal', 'semifinal', 'final'],
    16: ['roundof16', 'quarterfinal', 'semifinal', 'final']
};
const PHASE_LABELS = {
    roundof16: 'Round of 16',
    quarterfinal: 'Quarter Final',
    semifinal: 'Semi Final',
    final: 'Final'
};

// Serialize progression and rollback work for the same tournament in this bot
// process so two reports for the last matches cannot create duplicate rounds.
const tournamentLocks = new Map();

/**
 * Create each next-round fixture as soon as both of its feeder matches have
 * been reported. The operation is safe to call after every result: unmatched
 * slots are left open and an existing next-round fixture is never duplicated.
 */
async function autoAdvanceStraightKnockout({ guildId, tournament, phase }) {
    if (!tournament || tournament.formatType !== 'knockout') {
        return { progressed: false, skipped: true, reason: 'not-straight-knockout' };
    }

    const currentPhase = String(phase || '').toLowerCase();
    if (!isKnockoutPhase(currentPhase)) {
        return { progressed: false, skipped: true, reason: 'not-a-knockout-phase' };
    }

    return withTournamentLock(guildId, tournament._id, async () => {
        const rounds = getTournamentRounds(tournament, currentPhase);
        const currentIndex = rounds.indexOf(currentPhase);
        if (currentIndex < 0) {
            return { progressed: false, skipped: true, reason: 'phase-not-in-bracket' };
        }

        const fixtures = await Fixture.find({
            guildId,
            tournamentId: tournament._id,
            phase: currentPhase
        }).sort({ matchNumber: 1, leg: 1 }).lean();
        const bracketSlots = fixtures.map(getBracketSlot);
        if (bracketSlots.some(slot => slot !== null)) {
            const uniqueSlots = new Set(bracketSlots);
            if (bracketSlots.some(slot => slot === null) ||
                uniqueSlots.size !== fixtures.length ||
                bracketSlots.some(slot => slot > fixtures.length)) {
                return {
                    progressed: false,
                    blocked: true,
                    reason: `The ${PHASE_LABELS[currentPhase] || currentPhase} bracket has incomplete or duplicate slot assignments.`
                };
            }
            fixtures.sort((a, b) => getBracketSlot(a) - getBracketSlot(b));
        } else {
            fixtures.sort((a, b) =>
                Number(a.matchNumber || 0) - Number(b.matchNumber || 0) ||
                Number(a.leg || 1) - Number(b.leg || 1)
            );
        }

        if (!fixtures.length) {
            return { progressed: false, skipped: true, reason: 'no-fixtures' };
        }

        const pendingFixtures = fixtures.filter(fixture => fixture.status !== 'Played');
        const nextPhase = rounds[currentIndex + 1];
        if (!nextPhase) {
            if (pendingFixtures.length) {
                return {
                    progressed: false,
                    waiting: true,
                    pendingFixtures: pendingFixtures.length,
                    phase: currentPhase
                };
            }
            await setCurrentPhase(tournament, 'completed');
            return { progressed: false, completed: true, phase: currentPhase };
        }

        if (fixtures.length < 2 || fixtures.length % 2 !== 0) {
            return {
                progressed: false,
                blocked: true,
                reason: `The ${PHASE_LABELS[currentPhase] || currentPhase} has an invalid fixture count (${fixtures.length}).`
            };
        }

        const expectedNextCount = fixtures.length / 2;
        const existingNextFixtures = await Fixture.find({
            guildId,
            tournamentId: tournament._id,
            phase: nextPhase
        }).sort({ matchNumber: 1, leg: 1 }).lean();

        // Older/manual advancement may create a complete round without slot labels.
        // Trust it only when the whole expected round exists; never let a partial
        // unnumbered round block automatic creation or advance the phase early.
        if (existingNextFixtures.some(fixture => getBracketSlot(fixture) === null)) {
            if (existingNextFixtures.length !== expectedNextCount) {
                return {
                    progressed: false,
                    blocked: true,
                    reason: `The existing ${PHASE_LABELS[nextPhase] || nextPhase} round is incomplete (${existingNextFixtures.length} of ${expectedNextCount} fixtures).`
                };
            }
            if (pendingFixtures.length === 0) await setCurrentPhase(tournament, nextPhase);
            return {
                progressed: false,
                alreadyAdvanced: true,
                nextPhase,
                fixtureCount: existingNextFixtures.length
            };
        }

        const existingBySlot = new Map();
        for (const fixture of existingNextFixtures) {
            const slot = getBracketSlot(fixture);
            if (slot === null || slot < 1 || slot > expectedNextCount || existingBySlot.has(slot)) {
                return {
                    progressed: false,
                    blocked: true,
                    reason: `The existing ${PHASE_LABELS[nextPhase] || nextPhase} bracket has an invalid slot assignment.`
                };
            }
            existingBySlot.set(slot, fixture);
        }

        const winners = [];
        const pendingNextFixtures = [];
        for (let pairIndex = 0; pairIndex < expectedNextCount; pairIndex++) {
            const homeFixture = fixtures[pairIndex * 2];
            const awayFixture = fixtures[(pairIndex * 2) + 1];
            if (homeFixture.status !== 'Played' || awayFixture.status !== 'Played') continue;

            const homeSide = getFixtureWinnerSide(homeFixture);
            const awaySide = getFixtureWinnerSide(awayFixture);
            if (!homeSide) {
                return {
                    progressed: false,
                    blocked: true,
                    reason: `Could not determine the winner of match #${homeFixture.matchNumber}.`
                };
            }
            if (!awaySide) {
                return {
                    progressed: false,
                    blocked: true,
                    reason: `Could not determine the winner of match #${awayFixture.matchNumber}.`
                };
            }

            const home = toTeamSnapshot(homeFixture, homeSide);
            const away = toTeamSnapshot(awayFixture, awaySide);
            winners.push(home, away);

            const slot = pairIndex + 1;
            const existing = existingBySlot.get(slot);
            if (existing) {
                if (!sameTeam(existing, 'home', home) || !sameTeam(existing, 'away', away)) {
                    return {
                        progressed: false,
                        blocked: true,
                        reason: `The existing ${PHASE_LABELS[nextPhase] || nextPhase} fixture for bracket slot ${slot} does not match the reported winners.`
                    };
                }
                continue;
            }

            pendingNextFixtures.push({ slot, home, away });
        }

        const uniqueWinners = dedupeTeams(winners);
        if (uniqueWinners.length !== winners.length) {
            return {
                progressed: false,
                blocked: true,
                reason: 'A team appears as the winner of more than one fixture in this round.'
            };
        }

        let matchNumber = 0;
        if (pendingNextFixtures.length) {
            const latestFixture = await Fixture.findOne({
                guildId,
                tournamentId: tournament._id
            }).sort({ matchNumber: -1 }).select('matchNumber');
            matchNumber = Number(latestFixture?.matchNumber || 0) + 1;
        }

        const nextFixtures = pendingNextFixtures.map(({ slot, home, away }) => buildNextFixture({
            guildId,
            tournament,
            phase: nextPhase,
            matchNumber: matchNumber++,
            slot,
            home,
            away
        }));

        if (nextFixtures.length) {
            await Fixture.insertMany(nextFixtures);
        }

        const nextFixtureCount = existingBySlot.size + nextFixtures.length;
        if (pendingFixtures.length === 0) {
            if (nextFixtureCount !== expectedNextCount) {
                return {
                    progressed: nextFixtures.length > 0,
                    blocked: true,
                    nextPhase,
                    fixtures: nextFixtures,
                    reason: `Only ${nextFixtureCount} of ${expectedNextCount} next-round fixtures could be prepared.`
                };
            }
            await setCurrentPhase(tournament, nextPhase);
        }

        if (nextFixtures.length) {
            return {
                progressed: true,
                waiting: pendingFixtures.length > 0,
                pendingFixtures: pendingFixtures.length,
                fromPhase: currentPhase,
                nextPhase,
                winners: uniqueWinners,
                fixtures: nextFixtures
            };
        }

        if (pendingFixtures.length) {
            return {
                progressed: false,
                waiting: true,
                pendingFixtures: pendingFixtures.length,
                phase: currentPhase,
                nextPhase
            };
        }

        return {
            progressed: false,
            alreadyAdvanced: true,
            nextPhase,
            fixtureCount: nextFixtureCount
        };
    });
}

/**
 * When an earlier result is undone, remove only unscheduled Pending fixtures
 * in later rounds. Never silently discard a later result, reservation, or
 * scheduled/live match.
 */
async function rollbackStraightKnockoutAfterUndo({ guildId, tournament, phase }) {
    if (!tournament || tournament.formatType !== 'knockout') {
        return { ok: true, removedFixtures: 0, skipped: true };
    }

    const currentPhase = String(phase || '').toLowerCase();
    if (!isKnockoutPhase(currentPhase)) {
        return { ok: true, removedFixtures: 0, skipped: true };
    }

    return withTournamentLock(guildId, tournament._id, async () => {
        const rounds = getTournamentRounds(tournament, currentPhase);
        const currentIndex = rounds.indexOf(currentPhase);
        if (currentIndex < 0) return { ok: true, removedFixtures: 0, skipped: true };

        const laterPhases = rounds.slice(currentIndex + 1);
        const laterFixtures = laterPhases.length
            ? await Fixture.find({
                guildId,
                tournamentId: tournament._id,
                phase: { $in: laterPhases }
            }).sort({ matchNumber: 1, leg: 1 }).lean()
            : [];

        const unsafeFixture = laterFixtures.find(fixture =>
            fixture.status !== 'Pending' ||
            fixture.scheduledAt != null ||
            fixture.reserved?.isReserved === true ||
            (fixture.channelPlan?.state && !['pending', 'cancelled'].includes(fixture.channelPlan.state))
        );

        if (unsafeFixture) {
            return {
                ok: false,
                removedFixtures: 0,
                error:
                    `Cannot undo this result because a later knockout fixture (#${unsafeFixture.matchNumber}) ` +
                    'has been played, cancelled, reserved, or scheduled. Resolve or reset that later fixture first.'
            };
        }

        if (laterFixtures.length) {
            await Fixture.deleteMany({
                guildId,
                tournamentId: tournament._id,
                phase: { $in: laterPhases }
            });
        }

        await setCurrentPhase(tournament, currentPhase);
        return { ok: true, removedFixtures: laterFixtures.length, phase: currentPhase };
    });
}

function getTournamentRounds(tournament, phase) {
    const derived = ROUNDS_BY_TEAM_COUNT[Number(tournament.teamCount)] || [];
    if (derived.includes(phase)) return derived;

    const configured = Array.isArray(tournament.knockoutRounds)
        ? tournament.knockoutRounds.map(round => String(round).toLowerCase()).filter(round => PHASE_ORDER.includes(round))
        : [];
    if (configured.includes(phase)) return configured;

    const phaseIndex = PHASE_ORDER.indexOf(phase);
    return phaseIndex >= 0 ? PHASE_ORDER.slice(phaseIndex) : [];
}

function toTeamSnapshot(fixture, side) {
    return {
        name: String(fixture[`${side}Team`] || '').trim(),
        teamId: fixture[`${side}TeamId`] || null,
        tournamentTeamId: fixture[`${side}TournamentTeamId`] || null
    };
}

function dedupeTeams(teams) {
    const seen = new Set();
    const unique = [];
    for (const team of teams) {
        const key = team.tournamentTeamId
            ? `tournament:${String(team.tournamentTeamId)}`
            : team.teamId
                ? `team:${String(team.teamId)}`
                : `name:${team.name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(team);
    }
    return unique;
}

function getBracketSlot(fixture) {
    const slot = Number(fixture?.bracket?.slot);
    return Number.isInteger(slot) && slot > 0 ? slot : null;
}

function sameTeam(fixture, side, team) {
    const fixtureTournamentTeamId = fixture[`${side}TournamentTeamId`];
    const fixtureTeamId = fixture[`${side}TeamId`];
    if (fixtureTournamentTeamId && team.tournamentTeamId) {
        return String(fixtureTournamentTeamId) === String(team.tournamentTeamId);
    }
    if (fixtureTeamId && team.teamId) return String(fixtureTeamId) === String(team.teamId);
    return String(fixture[`${side}Team`] || '').trim().toLowerCase() === team.name.toLowerCase();
}

function buildNextFixture({ guildId, tournament, phase, matchNumber, slot, home, away }) {
    const isNeutralFinal = phase === 'final' && tournament.finalNeutralVenue;
    return {
        guildId,
        tournamentId: tournament._id,
        tournamentKey: tournament.tournamentKey,
        phase,
        roundLabel: PHASE_LABELS[phase] || phase,
        groupKey: null,
        leg: 1,
        matchNumber,
        homeTeam: home.name,
        awayTeam: away.name,
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        homeTournamentTeamId: home.tournamentTeamId,
        awayTournamentTeamId: away.tournamentTeamId,
        venueType: isNeutralFinal ? 'neutral' : 'home',
        venueName: isNeutralFinal ? 'Neutral Venue' : `${home.name} Stadium`,
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
        aggregateTieKey: null,
        notes: '',
        bracket: { advancesToMatchNumber: null, slot: String(slot) }
    };
}

async function setCurrentPhase(tournament, phase) {
    if (tournament.currentPhase === phase) return;
    tournament.currentPhase = phase;
    if (typeof tournament.save === 'function') await tournament.save();
}

async function withTournamentLock(guildId, tournamentId, callback) {
    const key = `${guildId}:${String(tournamentId)}`;
    const previous = tournamentLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    tournamentLocks.set(key, current);

    await previous.catch(() => null);
    try {
        return await callback();
    } finally {
        release();
        if (tournamentLocks.get(key) === current) tournamentLocks.delete(key);
    }
}

module.exports = {
    autoAdvanceStraightKnockout,
    rollbackStraightKnockoutAfterUndo,
    getTournamentRounds,
    buildNextFixture
};
