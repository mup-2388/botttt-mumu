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
    addStringOption(configure) {
        configure(new FakeOption());
        return this;
    }
}

function loadCommand(models = {}, updateLiveTopStats = async () => {}) {
    return requireWithMocks('../commands/tournament/removemvp', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1n },
            escapeMarkdown: value => String(value)
        },
        '../../models/Tournament': models,
        '../../utils/getTournament': {
            getDefaultTournament: async () => null,
            getTournamentByKey: async () => null
        },
        '../../utils/getEvent': {
            getEventByKey: async () => null,
            getEventByChannel: async () => null
        },
        '../../utils/updateTopStats': { updateLiveTopStats },
        '../../utils/isOrganizer': { isOrganizer: async () => true }
    });
}

const idOne = '111111111111111111';
const idTwo = '222222222222222222';
const idThree = '333333333333333333';

test('extracts and deduplicates raw Discord IDs and user mentions', () => {
    const command = loadCommand();

    assert.deepEqual(
        command.extractUserIds(`<@${idOne}> <@!${idTwo}> ${idOne} 123456`),
        [idOne, idTwo]
    );
});

test('reads IDs and user tags from a replied-to message, or directly from command arguments', async () => {
    const command = loadCommand();
    const replied = {
        content: `IDs: ${idOne}, ${idThree}`,
        mentions: { users: new Map([[idTwo, { id: idTwo }], [idOne, { id: idOne }]]) }
    };
    const message = {
        reference: { messageId: 'quoted-message' },
        channel: { messages: { fetch: async () => replied } }
    };

    assert.deepEqual(await command.getUserIdsFromPrefix(message, []), [idTwo, idOne, idThree]);
    assert.deepEqual(
        await command.getUserIdsFromPrefix({}, [`<@${idOne}>`, idTwo, idOne]),
        [idOne, idTwo]
    );
});

test('removes exactly one tournament MVP per distinct user and never decrements below zero', async () => {
    const playerByDiscordId = new Map([
        [idOne, { _id: 'player-one', discordID: idOne, name: 'Ada' }],
        [idTwo, { _id: 'player-two', discordID: idTwo, name: 'Bex' }]
    ]);
    const tournamentCounts = new Map([['player-one', 2], ['player-two', 0]]);
    const allTimeCounts = new Map([[idOne, 4], [idTwo, 0]]);
    const tournamentUpdates = [];
    const profileUpdates = [];
    const topStatsUpdates = [];

    const command = loadCommand({
        Player: {
            findOne: async ({ discordID }) => playerByDiscordId.get(discordID) || null
        },
        TournamentPlayer: {
            findOneAndUpdate: async (filter, update, options) => {
                tournamentUpdates.push({ filter, update, options });
                assert.equal(filter['stats.mvps'].$gt, 0);
                assert.equal(update.$inc['stats.mvps'], -1);
                assert.equal(options.returnDocument, 'after');

                const count = tournamentCounts.get(filter.playerId) || 0;
                if (count <= 0) return null;
                tournamentCounts.set(filter.playerId, count - 1);
                return { stats: { mvps: count - 1 } };
            }
        },
        EventPlayer: {},
        UserProfile: {
            findOneAndUpdate: async (filter, update) => {
                profileUpdates.push({ filter, update });
                const count = allTimeCounts.get(filter.discordID) || 0;
                if (count <= 0) return null;
                allTimeCounts.set(filter.discordID, count + update.$inc['allTimeStats.mvps']);
                return {};
            }
        }
    }, async (...args) => topStatsUpdates.push(args));

    let response;
    await command.runRemoveMvp({
        client: {},
        guild: { id: 'guild-one' },
        target: {
            type: 'tournament',
            doc: { _id: 'tournament-one', tournamentKey: 'cup', name: 'Test Cup' }
        },
        userIds: [idOne, idTwo, idThree, idOne],
        reply: async payload => { response = payload; return payload; }
    });

    assert.equal(tournamentCounts.get('player-one'), 1);
    assert.equal(tournamentCounts.get('player-two'), 0);
    assert.equal(allTimeCounts.get(idOne), 3);
    assert.equal(allTimeCounts.get(idTwo), 0);
    assert.equal(tournamentUpdates.length, 2);
    assert.equal(profileUpdates.length, 1);
    assert.equal(topStatsUpdates.length, 1);
    assert.match(response.content, /Removed one MVP from \*\*1\*\* of \*\*3\*\*/);
    assert.match(response.content, /no player record/);
    assert.match(response.content, /no MVP to remove/);
    assert.deepEqual(response.allowedMentions, { parse: [], users: [], roles: [] });
});

test('also decrements one MVP for an event player', async () => {
    let eventCount = 1;
    let allTimeCount = 1;
    let eventFilter;
    let topStatsCalled = false;
    const command = loadCommand({
        Player: {
            findOne: async () => ({ _id: 'player-one', discordID: idOne, name: 'Ada' })
        },
        TournamentPlayer: {},
        EventPlayer: {
            findOneAndUpdate: async (filter, update) => {
                eventFilter = filter;
                assert.equal(update.$inc['stats.mvps'], -1);
                if (!eventCount || filter['stats.mvps'].$gt !== 0) return null;
                eventCount--;
                return { stats: { mvps: eventCount } };
            }
        },
        UserProfile: {
            findOneAndUpdate: async (filter, update) => {
                assert.equal(filter['allTimeStats.mvps'].$gt, 0);
                allTimeCount += update.$inc['allTimeStats.mvps'];
                return {};
            }
        }
    }, async () => { topStatsCalled = true; });

    await command.runRemoveMvp({
        client: {},
        guild: { id: 'guild-one' },
        target: { type: 'event', doc: { _id: 'event-one', eventKey: 'friendly', name: 'Friendly' } },
        userIds: [idOne],
        reply: async payload => payload
    });

    assert.equal(eventCount, 0);
    assert.equal(allTimeCount, 0);
    assert.equal(eventFilter.eventId, 'event-one');
    assert.equal(topStatsCalled, false);
});
