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
            skipped: [{ teamName: 'No Leader', reason: 'configured captain is not on this active tournament roster' }]
        }
    });

    await command.execute(message, ['tournament=glory-cup-s4']);

    assert.equal(calls.sync, 1);
    assert.match(replies[0].content, /Updated: \*\*2\*\*/);
    assert.match(replies[0].content, /Already correct: \*\*4\*\*/);
    assert.match(replies[0].content, /No Leader/);
    assert.match(replies[0].content, /global team leadership was left untouched/);
});

test('non-organizers cannot run the bulk captain reconciliation', async () => {
    const { command, message, replies, calls } = makeHarness({
        organizer: false,
        syncResult: { updated: 0, alreadyCorrect: 0, skipped: [] }
    });

    await command.execute(message, ['tournament=glory-cup-s4']);

    assert.equal(calls.sync, 0);
    assert.match(replies[0], /Only an organizer/);
});
