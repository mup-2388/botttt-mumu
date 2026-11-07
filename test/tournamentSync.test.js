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

function createSyncHarness({
    teamEntry = null,
    players = [],
    inactivePlayerIds = []
} = {}) {
    const calls = {
        teamUpdates: [],
        playerUpdates: []
    };

    const entryByPlayerId = new Map(inactivePlayerIds.map(playerId => [
        playerId,
        { _id: `tournament-player-${playerId}`, isActive: false }
    ]));

    const service = requireWithMocks('../utils/tournamentSync', {
        '../models/Tournament': {
            Team: {
                find: () => ({ sort: async () => players.length ? [team] : [team] }),
                findOne: async () => team
            },
            Player: {
                find: async () => players,
                findOne: async () => null
            },
            TournamentSettings: {
                find: async () => []
            },
            TournamentTeam: {
                findOne: async () => teamEntry,
                countDocuments: async () => teamEntry?.isActive === false ? 0 : (teamEntry ? 1 : 0),
                findOneAndUpdate: async (filter, update) => {
                    calls.teamUpdates.push({ filter, update });
                    return {
                        _id: 'tournament-team-1',
                        ...(teamEntry || {}),
                        ...update.$set,
                        captainID: teamEntry?.captainID || null,
                        viceCaptainID: teamEntry?.viceCaptainID || null
                    };
                },
                find: () => ({ populate: async () => [] })
            },
            TournamentPlayer: {
                findOne: async filter => entryByPlayerId.get(String(filter.playerId)) || null,
                findOneAndUpdate: async (filter, update) => {
                    calls.playerUpdates.push({ filter, update });
                    return { _id: `tournament-player-${filter.playerId}`, ...update.$set };
                }
            }
        }
    });

    return { service, calls };
}

const tournament = { _id: 'tournament-1', tournamentKey: 'glory-cup', teamCount: 0 };
const team = {
    _id: 'team-1',
    name: 'Alpha',
    captainID: 'captain-1',
    viceCaptainID: 'vice-1',
    groupKey: null
};
const players = [
    { _id: 'player-captain', discordID: 'captain-1', name: 'Captain' },
    { _id: 'player-vice', discordID: 'vice-1', name: 'Vice Captain' },
    { _id: 'player-member', discordID: 'member-1', name: 'Player' }
];

test('auto-sync carries global captain and vice-captain status into tournament player entries', async () => {
    const { service, calls } = createSyncHarness({ players });

    const result = await service.syncTeamToTournament('guild-1', tournament, team);
    const flagsByPlayer = new Map(calls.playerUpdates.map(({ filter, update }) => [
        String(filter.playerId),
        { isCaptain: update.$set.isCaptain, isViceCaptain: update.$set.isViceCaptain }
    ]));

    assert.equal(result.teamSynced, true);
    assert.equal(result.playersSynced, 3);
    assert.deepEqual(flagsByPlayer.get('player-captain'), { isCaptain: true, isViceCaptain: false });
    assert.deepEqual(flagsByPlayer.get('player-vice'), { isCaptain: false, isViceCaptain: true });
    assert.deepEqual(flagsByPlayer.get('player-member'), { isCaptain: false, isViceCaptain: false });
    assert.equal(Object.hasOwn(calls.teamUpdates[0].update.$set, 'captainID'), false);
});

test('auto-sync respects tournament-specific captain and vice-captain overrides', async () => {
    const overrideEntry = {
        _id: 'tournament-team-1',
        isActive: true,
        captainID: 'tournament-captain',
        viceCaptainID: 'tournament-vice'
    };
    const overridePlayers = [
        { _id: 'tp-cap', discordID: 'tournament-captain', name: 'Tournament Captain' },
        { _id: 'tp-vc', discordID: 'tournament-vice', name: 'Tournament Vice' },
        ...players
    ];
    const { service, calls } = createSyncHarness({ teamEntry: overrideEntry, players: overridePlayers });

    await service.syncTeamToTournament('guild-1', tournament, team);

    const flagsByDiscordId = new Map(calls.playerUpdates.map(({ update }) => [
        update.$set.playerNameSnapshot,
        { isCaptain: update.$set.isCaptain, isViceCaptain: update.$set.isViceCaptain }
    ]));
    assert.deepEqual(flagsByDiscordId.get('Tournament Captain'), { isCaptain: true, isViceCaptain: false });
    assert.deepEqual(flagsByDiscordId.get('Tournament Vice'), { isCaptain: false, isViceCaptain: true });
    assert.deepEqual(flagsByDiscordId.get('Captain'), { isCaptain: false, isViceCaptain: false });
});

test('setup re-sync does not reactivate withdrawn tournament teams', async () => {
    const inactiveTeam = { _id: 'tournament-team-1', isActive: false };
    const { service, calls } = createSyncHarness({ teamEntry: inactiveTeam, players });

    const result = await service.syncAllTeamsToTournament('guild-1', tournament);

    assert.deepEqual(result, { syncedTeams: 0, syncedPlayers: 0 });
    assert.equal(calls.teamUpdates.length, 0);
    assert.equal(calls.playerUpdates.length, 0);
});

test('setup re-sync preserves individually withdrawn tournament players', async () => {
    const activeTeam = { _id: 'tournament-team-1', isActive: true };
    const { service, calls } = createSyncHarness({
        teamEntry: activeTeam,
        players: [players[0]],
        inactivePlayerIds: [players[0]._id]
    });

    const result = await service.syncTeamToTournament('guild-1', tournament, team, {
        preserveInactive: true,
        preserveInactivePlayers: true
    });

    assert.equal(result.teamSynced, true);
    assert.equal(result.playersSynced, 0);
    assert.equal(calls.playerUpdates.length, 0);
});
