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

function makeHarness({ teamEntries, teams, players, existingEntries }) {
    const calls = { inserts: [], updates: [] };
    const service = requireWithMocks('../utils/tournamentRosterSync', {
        '../models/Tournament': {
            Team: { find: async () => teams },
            Player: { find: async () => players },
            TournamentTeam: { find: async () => teamEntries },
            TournamentPlayer: {
                find: async () => existingEntries,
                findOneAndUpdate: async (...args) => calls.inserts.push(args),
                updateOne: async (...args) => calls.updates.push(args)
            }
        },
        './tournamentLeadership': require('../utils/tournamentLeadership')
    });
    return { service, calls };
}

const tournament = { _id: 'tournament-1', tournamentKey: 'glory-cup-s4' };
const team = { _id: 'team-1', name: 'Retards United', captainID: 'captain-1', viceCaptainID: 'vice-1' };
const teamEntry = { _id: 'tt-1', teamId: team._id, captainID: null, viceCaptainID: null };

test('roster sync adds missing global players and applies current captain flags', async () => {
    const captain = { _id: 'p-cap', discordID: 'captain-1', name: 'Captain', teamId: team._id };
    const newPlayer = { _id: 'p-new', discordID: 'new-1', name: 'New Player', teamId: team._id };
    const { service, calls } = makeHarness({
        teamEntries: [teamEntry],
        teams: [team],
        players: [captain, newPlayer],
        existingEntries: []
    });

    const result = await service.syncTournamentRosterPlayers('guild-1', tournament);

    assert.equal(result.added, 2);
    assert.equal(calls.inserts.length, 2);
    const captainInsert = calls.inserts.find(call => call[0].playerId === captain._id);
    assert.equal(captainInsert[1].$setOnInsert.isCaptain, true);
    assert.equal(captainInsert[1].$setOnInsert.isViceCaptain, false);
    const newPlayerInsert = calls.inserts.find(call => call[0].playerId === newPlayer._id);
    assert.equal(newPlayerInsert[1].$setOnInsert.teamId, team._id);
    assert.equal(newPlayerInsert[1].$setOnInsert.isActive, true);
});

test('roster sync preserves withdrawn players unless reactivation is explicitly requested', async () => {
    const player = { _id: 'p-withdrawn', discordID: 'withdrawn-1', name: 'Withdrawn', teamId: team._id };
    const withdrawn = {
        _id: 'tp-withdrawn',
        playerId: player._id,
        teamId: team._id,
        isActive: false
    };
    const harness = makeHarness({
        teamEntries: [teamEntry],
        teams: [team],
        players: [player],
        existingEntries: [withdrawn]
    });

    const safeResult = await harness.service.syncTournamentRosterPlayers('guild-1', tournament);
    assert.equal(safeResult.withdrawnPreserved, 1);
    assert.equal(safeResult.reactivated, 0);
    assert.equal(harness.calls.updates.length, 0);

    const explicitResult = await harness.service.syncTournamentRosterPlayers('guild-1', tournament, {
        reactivateWithdrawn: true
    });
    assert.equal(explicitResult.reactivated, 1);
    assert.deepEqual(harness.calls.updates.at(-1), [
        { _id: withdrawn._id },
        {
            $set: {
                guildId: 'guild-1',
                tournamentId: tournament._id,
                playerId: player._id,
                teamId: team._id,
                playerNameSnapshot: player.name,
                teamNameSnapshot: team.name,
                isCaptain: false,
                isViceCaptain: false,
                isActive: true
            }
        }
    ]);
});

test('roster sync does not steal active free agents or tournament transfers', async () => {
    const freeAgent = { _id: 'p-free', discordID: 'free-1', name: 'Free Agent', teamId: team._id };
    const movedPlayer = { _id: 'p-moved', discordID: 'moved-1', name: 'Moved', teamId: team._id };
    const existingEntries = [
        { _id: 'tp-free', playerId: freeAgent._id, teamId: null, isActive: true },
        { _id: 'tp-moved', playerId: movedPlayer._id, teamId: 'team-2', teamNameSnapshot: 'Other Team', isActive: true }
    ];
    const { service, calls } = makeHarness({
        teamEntries: [teamEntry],
        teams: [team],
        players: [freeAgent, movedPlayer],
        existingEntries
    });

    const result = await service.syncTournamentRosterPlayers('guild-1', tournament);

    assert.equal(result.freeAgentsPreserved, 1);
    assert.equal(result.otherTeamsPreserved, 1);
    assert.equal(calls.inserts.length, 0);
    assert.equal(calls.updates.length, 0);
});

test('roster sync compares team names case-insensitively and reports a missing team record', async () => {
    const { service, calls } = makeHarness({
        teamEntries: [
            teamEntry,
            { _id: 'tt-missing', teamId: 'team-missing', teamNameSnapshot: 'Legacy Team' }
        ],
        teams: [team],
        players: [],
        existingEntries: []
    });

    const selectedResult = await service.syncTournamentRosterPlayers('guild-1', tournament, {
        teamName: 'RETARDS UNITED'
    });
    assert.equal(selectedResult.skippedTeams.length, 0);

    const allResult = await service.syncTournamentRosterPlayers('guild-1', tournament);
    assert.deepEqual(allResult.skippedTeams, [
        { teamName: 'Legacy Team', reason: 'team record is missing' }
    ]);
    assert.equal(calls.inserts.length, 0);
});
