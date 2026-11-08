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
    addBooleanOption(configure) { configure(new FakeOption()); return this; }
}

function makeHarness({ organizer, result, rest = ['team=Retards', 'United', 'reactivate=true'] }) {
    const calls = [];
    const tournament = { _id: 'tournament-1', tournamentKey: 'glory-cup-s4', name: 'Glory Cup S4' };
    const command = requireWithMocks('../commands/tournament/syncrosterplayers', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1 }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => organizer },
        '../../utils/getTournament': {
            extractTournamentFromArgs: async () => ({
                tournament,
                explicit: true,
                rest,
                error: null
            }),
            resolveTournament: async () => ({ tournament, explicit: true, error: null })
        },
        '../../utils/tournamentContext': {
            parseTeamTokenInTournament: async () => ({ teamName: 'Retards United', rest: [] })
        },
        '../../utils/tournamentRosterSync': {
            syncTournamentRosterPlayers: async (...args) => {
                calls.push(args);
                return result;
            }
        }
    });
    const replies = [];
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1' },
        reply: async payload => { replies.push(payload); return payload; }
    };
    return { command, message, replies, calls, tournament };
}

test('roster sync command targets the selected team and only reactivates when requested', async () => {
    const { command, message, replies, calls, tournament } = makeHarness({
        organizer: true,
        result: {
            added: 3,
            addedPlayers: [{ playerName: 'Player One', discordID: '123456789012345678' }],
            alreadyPresent: 2,
            legacyActiveFlagsRepaired: 2,
            globalTeamAssignmentsRepaired: 1,
            globalTeamAssignmentsRepairedPlayers: [{ playerName: 'Player Two', discordID: null }],
            reactivated: 1,
            reactivatedPlayers: [],
            withdrawnPreserved: 0,
            freeAgentsPreserved: 0,
            otherTeamsPreserved: 0,
            examples: [],
            skippedTeams: []
        }
    });

    await command.execute(message, []);

    assert.deepEqual(calls[0], [
        'guild-1',
        tournament,
        { teamName: 'Retards United', reactivateWithdrawn: true }
    ]);
    assert.equal(replies[0].content, undefined);
    assert.equal(replies[0].embeds.length, 1);
    const report = JSON.stringify(replies[0].embeds[0]);
    assert.match(report, /Added/);
    assert.match(report, /Reactivated/);
    assert.match(report, /Legacy active flags repaired/);
    assert.match(report, /Global team assignments repaired/);
    assert.match(report, /Player Two/);
    assert.match(report, /<@123456789012345678>/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});

test('prefix sync keeps withdrawals inactive by default', async () => {
    const { command, message, calls } = makeHarness({
        organizer: true,
        rest: ['team=Retards', 'United'],
        result: {
            added: 0, alreadyPresent: 0, reactivated: 0,
            withdrawnPreserved: 2, freeAgentsPreserved: 0,
            otherTeamsPreserved: 0, examples: [], skippedTeams: []
        }
    });

    await command.execute(message, []);

    assert.deepEqual(calls[0][2], {
        teamName: 'Retards United',
        reactivateWithdrawn: false
    });
});

test('slash sync uses its team and explicit reactivation option', async () => {
    const { command, calls, tournament } = makeHarness({
        organizer: true,
        result: {
            added: 1, alreadyPresent: 0, reactivated: 0,
            withdrawnPreserved: 0, freeAgentsPreserved: 0,
            otherTeamsPreserved: 0, examples: [], skippedTeams: []
        }
    });
    const replies = [];
    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        deferred: false,
        replied: false,
        options: {
            getString: name => name === 'team' ? 'Retards United' : null,
            getBoolean: name => name === 'reactivate_withdrawn' ? true : null
        },
        deferReply: async () => { interaction.deferred = true; },
        editReply: async payload => { replies.push(payload); return payload; },
        reply: async payload => { replies.push(payload); return payload; }
    };

    await command.slashExecute(interaction);

    assert.deepEqual(calls[0], [
        'guild-1',
        tournament,
        { teamName: 'Retards United', reactivateWithdrawn: true }
    ]);
    assert.equal(replies[0].content, undefined);
    assert.equal(replies[0].embeds.length, 1);
    assert.match(JSON.stringify(replies[0].embeds[0]), /Added/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});

test('non-organizers cannot sync tournament players', async () => {
    const { command, message, replies, calls } = makeHarness({
        organizer: false,
        result: {
            added: 0, alreadyPresent: 0, reactivated: 0,
            withdrawnPreserved: 0, freeAgentsPreserved: 0,
            otherTeamsPreserved: 0, examples: [], skippedTeams: []
        }
    });

    await command.execute(message, []);

    assert.equal(calls.length, 0);
    assert.equal(replies[0].content, undefined);
    assert.match(replies[0].embeds[0].description, /Only an organizer/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});
