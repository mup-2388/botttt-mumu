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

function createContext({ userId, tournamentPlayer, captainID = 'current-captain', tournamentCaptainID = captainID }) {
    const tournament = { _id: 'tournament-1', tournamentKey: 'glory-cup-s4', name: 'Glory Cup S4' };
    const team = {
        _id: 'team-retards',
        name: 'Retards United',
        captainID,
        viceCaptainID: null
    };
    const entry = {
        _id: 'tournament-team-1',
        teamId: team._id,
        tournamentId: tournament._id,
        isActive: true,
        captainID: tournamentCaptainID,
        viceCaptainID: null
    };
    const player = { _id: 'player-1', discordID: userId };

    const context = requireWithMocks('../utils/tournamentContext', {
        '../models/Tournament': {
            Team: {
                find: async () => [team],
                findOne: async () => team
            },
            Player: {
                findOne: async () => player
            },
            TournamentTeam: {
                find: async () => [entry]
            },
            TournamentPlayer: {
                findOne: async () => tournamentPlayer
            }
        },
        './getTournament': {
            resolveTournament: async () => ({ tournament, explicit: false, error: null }),
            getDefaultTournament: async () => tournament
        },
        './stringHelpers': {
            escapeRegex: value => value
        },
        './tournamentLeadership': require('../utils/tournamentLeadership')
    });

    return { context, tournament, team };
}

test('stale captain flags on a roster entry do not authorize a different current tournament leader', async () => {
    const { context, team } = createContext({
        userId: 'old-captain',
        tournamentPlayer: {
            _id: 'tp-1',
            teamId: 'team-retards',
            isActive: true,
            isCaptain: true,
            isViceCaptain: false
        }
    });

    const result = await context.resolveActorTeam({
        guildId: 'guild-1',
        userId: 'old-captain',
        need: 'manage',
        noun: 'claim free agents'
    });

    assert.equal(result.ctx.team.name, 'Retards United');
    assert.equal(result.ctx.role, 'player');
    assert.match(result.error, /current tournament role is \*\*player\*\*/);
});

test('the rostered captain configured for the selected tournament is authorized', async () => {
    const { context } = createContext({
        userId: 'current-captain',
        tournamentPlayer: {
            _id: 'tp-captain',
            teamId: 'team-retards',
            isActive: true
        }
    });

    const result = await context.resolveActorTeam({
        guildId: 'guild-1',
        userId: 'current-captain',
        need: 'manage',
        noun: 'claim free agents'
    });

    assert.equal(result.error, null);
    assert.equal(result.ctx.team.name, 'Retards United');
    assert.equal(result.ctx.role, 'captain');
});

test('a configured captain who is absent from the active roster is not authorized', async () => {
    const { context } = createContext({
        userId: 'old-captain',
        captainID: 'old-captain',
        tournamentCaptainID: 'old-captain',
        tournamentPlayer: null
    });

    const result = await context.resolveActorTeam({
        guildId: 'guild-1',
        userId: 'old-captain',
        need: 'manage',
        noun: 'claim free agents'
    });

    assert.equal(result.ctx, null);
    assert.match(result.error, /not on a team in/);
});

test('a cached TournamentPlayer captain flag cannot authorize when no team leader is assigned', async () => {
    const { context } = createContext({
        userId: 'stale-captain',
        captainID: null,
        tournamentCaptainID: null,
        tournamentPlayer: {
            _id: 'tp-1',
            teamId: 'team-retards',
            isActive: true,
            isCaptain: true
        }
    });

    const result = await context.resolveActorTeam({
        guildId: 'guild-1',
        userId: 'stale-captain',
        need: 'manage',
        noun: 'claim free agents'
    });

    assert.equal(result.ctx.role, 'player');
    assert.match(result.error, /current tournament role is \*\*player\*\*/);
});
