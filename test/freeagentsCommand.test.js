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

class FakeEmbedBuilder {
    constructor() { this.data = {}; }
    setColor(color) { this.data.color = color; return this; }
    setTitle(title) { this.data.title = title; return this; }
    setDescription(description) { this.data.description = description; return this; }
    setFooter(footer) { this.data.footer = footer; return this; }
    setTimestamp() { return this; }
}

function makeHarness({ players, tournamentPlayers, teams }) {
    const capturedQueries = [];
    const tournament = {
        _id: 'tournament-1',
        tournamentKey: 'glory-cup-s4',
        name: 'Glory Cup S4'
    };
    const command = requireWithMocks('../commands/tournament/freeagents', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            EmbedBuilder: FakeEmbedBuilder
        },
        '../../models/Tournament': {
            Player: {
                find: () => ({
                    sort() { return this; },
                    lean: async () => players
                })
            },
            TournamentPlayer: {
                find: query => {
                    capturedQueries.push(query);
                    return {
                        select() { return this; },
                        lean: async () => tournamentPlayers
                    };
                }
            }
        },
        '../../utils/getTournament': {
            extractTournamentFromArgs: async () => ({ explicit: false, tournament: null, error: null }),
            resolveTournament: async () => ({ tournament, error: null })
        },
        '../../utils/tournamentContext': {
            getTournamentTeams: async () => teams,
            effectiveCaptainId: entry => entry.captainID || null,
            effectiveViceCaptainId: entry => entry.viceCaptainID || null
        }
    });

    const replies = [];
    const message = {
        guild: { id: 'guild-1' },
        reply: async payload => { replies.push(payload); return payload; }
    };

    return { command, message, replies, capturedQueries, tournament };
}

test('freeagents excludes global members of active tournament teams when roster rows are missing', async () => {
    const players = [
        { _id: 'p-rostered', name: 'Rostered', teamId: 'team-1', discordID: 'rostered' },
        { _id: 'p-legacy', name: 'Legacy active row', teamId: 'team-1', discordID: 'legacy' },
        { _id: 'p-global-only', name: 'Global team member without tournament row', teamId: 'team-1', discordID: 'global-only' },
        { _id: 'p-unassigned', name: 'Global member with an unmarked legacy row', teamId: 'team-1', discordID: 'unassigned' },
        { _id: 'p-snapshot', name: 'Legacy team snapshot', teamId: 'team-1', discordID: 'snapshot' },
        { _id: 'p-free', name: 'Tournament Free Agent', teamId: null, discordID: 'free' },
        { _id: 'p-other', name: 'Other global team', teamId: 'team-2', discordID: 'other' }
    ];
    const tournamentPlayers = [
        { playerId: 'p-rostered', teamId: 'team-1', teamNameSnapshot: 'Retards United', isActive: true },
        // Legacy schema-defaulted active row: no isActive property.
        { playerId: 'p-legacy', teamId: 'team-1', teamNameSnapshot: 'Retards United' },
        // Legacy membership recorded by team name before teamId was populated.
        { playerId: 'p-snapshot', teamId: null, teamNameSnapshot: 'Retards United', isActive: true },
        // Missing snapshot data is not an explicit free-agent marker.
        { playerId: 'p-unassigned', teamId: null, teamNameSnapshot: '', isActive: true },
        { playerId: 'p-free', teamId: null, teamNameSnapshot: 'FREE AGENT', isActive: true }
    ];
    const teams = [{
        entry: { teamId: 'team-1', isActive: true },
        team: { _id: 'team-1', name: 'Retards United' }
    }];
    const { command, message, replies, capturedQueries } = makeHarness({ players, tournamentPlayers, teams });

    await command.execute(message, []);

    const description = replies[0].embeds[0].data.description;
    assert.match(description, /Tournament Free Agent/);
    assert.match(description, /Other global team/);
    assert.doesNotMatch(description, /Rostered/);
    assert.doesNotMatch(description, /Legacy active row/);
    assert.doesNotMatch(description, /Global team member without tournament row/);
    assert.doesNotMatch(description, /Global member with an unmarked legacy row/);
    assert.doesNotMatch(description, /Legacy team snapshot/);
    assert.deepEqual(capturedQueries[0].$or, [
        { isActive: true },
        { isActive: { $exists: false } }
    ]);
});

test('freeagents preserves an explicit tournament free-agent assignment', async () => {
    const players = [
        { _id: 'p-free', name: 'Tournament Free Agent', teamId: 'other-team', discordID: 'free' }
    ];
    const tournamentPlayers = [
        { playerId: 'p-free', teamId: null, teamNameSnapshot: 'FREE AGENT', isActive: true }
    ];
    const teams = [{
        entry: { teamId: 'team-1', isActive: true },
        team: { _id: 'team-1', name: 'Retards United' }
    }];
    const { command, message, replies } = makeHarness({ players, tournamentPlayers, teams });

    await command.execute(message, []);

    assert.match(replies[0].embeds[0].data.description, /Tournament Free Agent/);
});
