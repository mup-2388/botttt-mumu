const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function requireWithMocks(modulePath, mocks) {
    const resolvedPath = require.resolve(modulePath);
    const originalLoad = Module._load;
    delete require.cache[resolvedPath];

    Module._load = function (request, parent, isMain) {
        if (parent?.filename === resolvedPath && Object.prototype.hasOwnProperty.call(mocks, request)) {
            return mocks[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return require(resolvedPath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[resolvedPath];
    }
}

function makeHarness({ entries, teams, roster, players }) {
    const calls = { teamUpdates: [], playerUpdates: [] };
    const service = requireWithMocks('../utils/tournamentCaptainSync', {
        '../models/Tournament': {
            Team: {
                find: async () => teams
            },
            Player: {
                find: async () => players
            },
            TournamentTeam: {
                find: async () => entries,
                updateOne: async (...args) => calls.teamUpdates.push(args)
            },
            TournamentPlayer: {
                find: async () => roster,
                updateMany: async (...args) => calls.playerUpdates.push(args),
                updateOne: async (...args) => calls.playerUpdates.push(args)
            }
        },
        './tournamentLeadership': require('../utils/tournamentLeadership')
    });
    return { service, calls };
}

const tournament = { _id: 'tournament-1', name: 'Glory Cup S4' };

test('sync chooses a global captain only when that user is on the active tournament roster', async () => {
    const team = { _id: 'team-1', name: 'Retards United', captainID: 'rostered-global-cap' };
    const entry = { _id: 'tt-1', teamId: team._id, captainID: 'stale-old-cap', viceCaptainID: null };
    const rosterPlayer = { _id: 'player-1', discordID: 'rostered-global-cap' };
    const { service, calls } = makeHarness({
        entries: [entry],
        teams: [team],
        roster: [{ _id: 'tp-1', teamId: team._id, playerId: rosterPlayer._id, isActive: true }],
        players: [rosterPlayer]
    });

    const result = await service.syncCaptainsToTournamentRoster('guild-1', tournament);

    assert.deepEqual(result, { updated: 1, alreadyCorrect: 0, skipped: [] });
    assert.deepEqual(calls.teamUpdates[0], [
        { _id: entry._id },
        { $set: { captainID: 'rostered-global-cap' } }
    ]);
    assert.deepEqual(calls.playerUpdates[0][1], { $set: { isCaptain: false } });
    assert.deepEqual(calls.playerUpdates[1], [
        {
            guildId: 'guild-1',
            tournamentId: tournament._id,
            teamId: team._id,
            playerId: rosterPlayer._id,
            isActive: true
        },
        { $set: { isCaptain: true, isViceCaptain: false } }
    ]);
});

test('sync preserves a tournament override when the global captain is not rostered', async () => {
    const team = { _id: 'team-1', name: 'Retards United', captainID: 'old-global-cap' };
    const entry = { _id: 'tt-1', teamId: team._id, captainID: 'current-rostered-cap', viceCaptainID: null };
    const rosterPlayer = { _id: 'player-1', discordID: 'current-rostered-cap' };
    const { service, calls } = makeHarness({
        entries: [entry],
        teams: [team],
        roster: [{ _id: 'tp-1', teamId: team._id, playerId: rosterPlayer._id, isActive: true }],
        players: [rosterPlayer]
    });

    const result = await service.syncCaptainsToTournamentRoster('guild-1', tournament);

    assert.deepEqual(result, { updated: 0, alreadyCorrect: 1, skipped: [] });
    assert.equal(calls.teamUpdates.length, 0);
    assert.equal(calls.playerUpdates.length, 2);
});

test('sync falls back to one uniquely flagged active roster captain when configured IDs are stale', async () => {
    const team = { _id: 'team-1', name: 'Retards United', captainID: 'not-rostered' };
    const entry = { _id: 'tt-1', teamId: team._id, captainID: 'also-not-rostered', viceCaptainID: null };
    const rosterPlayer = { _id: 'player-1', discordID: 'current-rostered-cap' };
    const { service, calls } = makeHarness({
        entries: [entry],
        teams: [team],
        roster: [{ _id: 'tp-1', teamId: team._id, playerId: rosterPlayer._id, isActive: true, isCaptain: true }],
        players: [rosterPlayer]
    });

    const result = await service.syncCaptainsToTournamentRoster('guild-1', tournament);

    assert.equal(result.updated, 1);
    assert.equal(result.skipped.length, 0);
    assert.deepEqual(calls.teamUpdates[0][1], { $set: { captainID: 'current-rostered-cap' } });
});

test('sync skips ambiguous captain flags instead of assigning an arbitrary roster member', async () => {
    const team = { _id: 'team-1', name: 'Retards United', captainID: 'not-rostered' };
    const entry = { _id: 'tt-1', teamId: team._id, captainID: 'also-not-rostered', viceCaptainID: null };
    const players = [
        { _id: 'player-1', discordID: 'candidate-1' },
        { _id: 'player-2', discordID: 'candidate-2' }
    ];
    const { service, calls } = makeHarness({
        entries: [entry],
        teams: [team],
        roster: players.map((player, index) => ({
            _id: `tp-${index}`,
            teamId: team._id,
            playerId: player._id,
            isActive: true,
            isCaptain: true
        })),
        players
    });

    const result = await service.syncCaptainsToTournamentRoster('guild-1', tournament);

    assert.equal(result.updated, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /multiple rostered players/);
    assert.equal(calls.teamUpdates.length, 0);
    assert.equal(calls.playerUpdates.length, 0);
});
