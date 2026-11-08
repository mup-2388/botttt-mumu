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

class FakeOption {
    setName() { return this; }
    setDescription() { return this; }
    setRequired() { return this; }
}

class FakeSlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addStringOption(configure) { configure(new FakeOption()); return this; }
}

test('myteam shows a transferred player only on their current default-tournament team', async () => {
    const tournament = {
        _id: 'tournament-1',
        tournamentKey: 'glory-cup-s4',
        name: 'Glory Cup S4'
    };
    const teams = [
        { _id: 'team-old', name: 'Old Global Team' },
        { _id: 'team-current', name: 'Current Tournament Team' }
    ];
    const player = {
        _id: 'player-1',
        name: 'Transferred Player',
        discordID: 'discord-1',
        teamId: 'team-old'
    };
    const tournamentPlayer = {
        _id: 'tp-1',
        playerId: player._id,
        tournamentId: tournament._id,
        teamId: 'team-current',
        isActive: true,
        playerNameSnapshot: player.name
    };
    const playerQueries = [];
    const rosterQueries = [];

    const command = requireWithMocks('../commands/tournament/myteam', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder
        },
        '../../models/Tournament': {
            Team: {},
            Player: {
                find: async query => {
                    playerQueries.push(query);
                    if (query._id?.$in) {
                        const ids = new Set(query._id.$in.map(String));
                        return ids.has(String(player._id)) ? [player] : [];
                    }
                    if (query.teamId) {
                        return String(query.teamId) === String(player.teamId) ? [player] : [];
                    }
                    return [];
                }
            },
            TournamentTeam: {
                findOne: async query => ({ _id: `entry-${query.teamId}`, teamId: query.teamId, isActive: true })
            },
            TournamentPlayer: {
                find: async query => {
                    rosterQueries.push(query);
                    return String(query.teamId) === String(tournamentPlayer.teamId)
                        && String(query.tournamentId) === String(tournamentPlayer.tournamentId)
                        ? [tournamentPlayer]
                        : [];
                }
            },
            TournamentSettings: {},
            UserProfile: {}
        },
        '../../utils/stringHelpers': { escapeRegex: value => value },
        '../../utils/displayHelpers': { parseColor: () => 0 },
        '../../utils/getTournament': {
            resolveTournament: async () => ({ tournament, error: null })
        },
        '../../utils/tournamentContext': {
            getUserTeamInTournament: async () => null,
            getUserTeams: async () => teams,
            effectiveCaptainId: () => null,
            effectiveViceCaptainId: () => null
        },
        '../../utils/tournamentLeadership': {
            getUserLeadershipRole: () => 'player'
        },
        '../../utils/squadDisplay': require('../utils/squadDisplay')
    });

    const oldTeamRoster = await command._buildSquadEntries('guild-1', teams[0]);
    const currentTeamRoster = await command._buildSquadEntries('guild-1', teams[1]);

    assert.deepEqual(oldTeamRoster, []);
    assert.equal(currentTeamRoster.length, 1);
    assert.equal(currentTeamRoster[0].name, 'Transferred Player');
    assert.deepEqual([...currentTeamRoster[0].tournaments], ['Glory Cup S4']);
    assert.deepEqual(rosterQueries.map(query => [query.tournamentId, query.teamId]), [
        ['tournament-1', 'team-old'],
        ['tournament-1', 'team-current']
    ]);
    assert.deepEqual(playerQueries, [
        { guildId: 'guild-1', _id: { $in: ['player-1'] } }
    ]);
});
