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

function makeHarness({ organizer, syncResult }) {
    const calls = { sync: 0 };
    const tournament = { _id: 'tournament-1', tournamentKey: 'glory-cup-s4', name: 'Glory Cup S4' };
    const command = requireWithMocks('../commands/tournament/syncrostercaptains', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1 }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => organizer },
        '../../utils/getTournament': {
            extractTournamentFromArgs: async () => ({
                tournament,
                explicit: true,
                rest: [],
                error: null
            }),
            resolveTournament: async () => ({ tournament, explicit: true, error: null })
        },
        '../../utils/tournamentCaptainSync': {
            syncCaptainsToTournamentRoster: async () => {
                calls.sync++;
                return syncResult;
            }
        }
    });

    const replies = [];
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1' },
        reply: async payload => { replies.push(payload); return payload; }
    };
    return { command, message, replies, calls };
}

test('organizer command reports roster captain sync results and skipped teams', async () => {
    const { command, message, replies, calls } = makeHarness({
        organizer: true,
        syncResult: {
            updated: 2,
            alreadyCorrect: 4,
            skipped: [{ teamName: 'No Leader', reason: 'configured captain <@captain-1> is not on this active tournament roster' }]
        }
    });

    await command.execute(message, ['tournament=glory-cup-s4']);

    assert.equal(calls.sync, 1);
    assert.equal(replies[0].content, undefined);
    assert.equal(replies[0].embeds.length, 1);
    const report = JSON.stringify(replies[0].embeds[0]);
    assert.match(report, /Updated/);
    assert.match(report, /Already correct/);
    assert.match(report, /No Leader/);
    assert.match(report, /<@captain-1>/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});

test('slash captain sync also returns an embed without a plain-text content body', async () => {
    const { command, calls } = makeHarness({
        organizer: true,
        syncResult: {
            updated: 1,
            alreadyCorrect: 2,
            skipped: [{ teamName: 'Review Team', reason: 'captain <@captain-2> needs review' }]
        }
    });
    const replies = [];
    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        deferred: false,
        replied: false,
        options: { getString: () => null },
        deferReply: async () => { interaction.deferred = true; },
        editReply: async payload => { replies.push(payload); return payload; },
        reply: async payload => { replies.push(payload); return payload; }
    };

    await command.slashExecute(interaction);

    assert.equal(calls.sync, 1);
    assert.equal(replies[0].content, undefined);
    assert.equal(replies[0].embeds.length, 1);
    assert.match(JSON.stringify(replies[0].embeds[0]), /<@captain-2>/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});

test('non-organizers cannot run the bulk captain reconciliation', async () => {
    const { command, message, replies, calls } = makeHarness({
        organizer: false,
        syncResult: { updated: 0, alreadyCorrect: 0, skipped: [] }
    });

    await command.execute(message, ['tournament=glory-cup-s4']);

    assert.equal(calls.sync, 0);
    assert.equal(replies[0].content, undefined);
    assert.match(replies[0].embeds[0].description, /Only an organizer/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});
