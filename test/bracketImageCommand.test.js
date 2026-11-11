const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { syncLiveBracketImageReference } = require('../utils/liveBracketImage');

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
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    setRequired(required) { this.required = required; return this; }
}

class FakeSlashCommandBuilder {
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    addStringOption(configure) { configure(new FakeOption()); return this; }
}

class FakeAttachmentBuilder {
    constructor(buffer, options) {
        this.buffer = buffer;
        this.name = options.name;
    }
}

function loadCommand({ hasImage = true } = {}) {
    const tournament = { _id: 'tournament-1', tournamentKey: 'cup-s1', name: 'Cup S1', emoji: '🏆', formatType: 'knockout' };
    const renderCalls = [];
    const command = requireWithMocks('../commands/tournament/bracketimage', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1 },
            AttachmentBuilder: FakeAttachmentBuilder
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/getTournament': {
            getDefaultTournament: async () => tournament,
            getTournamentByKey: async () => tournament,
            extractTournamentFromArgs: async () => ({ tournament, explicit: false, error: null })
        },
        '../../utils/generateKnockoutBracketImage': {
            generateKnockoutBracketImage: async () => {
                renderCalls.push(true);
                return hasImage
                    ? { buffer: Buffer.from('png-data'), fileName: 'knockout-bracket.png' }
                    : null;
            }
        }
    });
    return { command, tournament, renderCalls };
}

function makeChannel(id = 'channel-1') {
    const calls = { sent: [], edited: [] };
    const channel = {
        id,
        _messages: new Map(),
        messages: {
            fetch: async messageId => channel._messages.get(messageId) || null
        },
        send: async payload => {
            calls.sent.push(payload);
            const message = {
                id: `image-${calls.sent.length}`,
                channel,
                edit: async editPayload => {
                    calls.edited.push(editPayload);
                    return message;
                }
            };
            channel._messages.set(message.id, message);
            return message;
        }
    };
    return { channel, calls };
}

function makeClient(channel, liveSettings) {
    return {
        liveSettings,
        channels: { fetch: async id => id === channel.id ? channel : null }
    };
}

function makeCommandMessage({ client, channel }) {
    const replies = [];
    return {
        replies,
        message: {
            guild: { id: 'guild-1' },
            author: { id: 'organizer-1' },
            client,
            channel,
            reply: async payload => { replies.push(payload); }
        }
    };
}

function linkStandingsMessage({ command, tournament, client, channel }, message) {
    client.liveSettings.set(command.getLiveBracketImageKey('guild-1', tournament.tournamentKey), {
        channelId: channel.id,
        messageId: message.id,
        tournamentKey: tournament.tournamentKey
    });
}

test('a standings message keeps only the currently displayed bracket linked', () => {
    const liveSettings = new Map();
    const client = { liveSettings };
    const message = { id: 'message-1', channel: { id: 'channel-1' } };

    syncLiveBracketImageReference({
        client, guildId: 'guild-1', tournamentKey: 'cup-a', message, isBracketImage: true
    });
    syncLiveBracketImageReference({
        client, guildId: 'guild-1', tournamentKey: 'cup-b', message, isBracketImage: true
    });
    assert.equal(liveSettings.has('live_bracket_image:guild-1:cup-a'), false);
    assert.equal(liveSettings.has('live_bracket_image:guild-1:cup-b'), true);

    syncLiveBracketImageReference({
        client, guildId: 'guild-1', tournamentKey: 'cup-b', message, isBracketImage: false
    });
    assert.equal(liveSettings.size, 0);
});

test('bracketimage does not post a first image; standings must create and link it', async () => {
    const { command, tournament, renderCalls } = loadCommand();
    const { channel, calls } = makeChannel();
    const client = makeClient(channel, new Map());
    const result = await command.publishOrUpdateBracketImage({
        client,
        guildId: 'guild-1',
        tournament,
        channel
    });

    assert.deepEqual(result, { ok: false, reason: 'not-linked' });
    assert.equal(calls.sent.length, 0);
    assert.equal(renderCalls.length, 0);
});

test('bracketimage is unavailable to groups-knockout tournaments before the phase switch', async () => {
    const { command, tournament, renderCalls } = loadCommand();
    tournament.formatType = 'groups_knockout';
    tournament.currentPhase = 'groups';
    const { channel, calls } = makeChannel();
    const result = await command.publishOrUpdateBracketImage({
        client: makeClient(channel, new Map()), guildId: 'guild-1', tournament, channel
    });

    assert.deepEqual(result, { ok: false, reason: 'not-knockout-stage' });
    assert.equal(renderCalls.length, 0);
    assert.equal(calls.sent.length, 0);
});

test('bracketimage edits the standings-linked message and replaces its attachment', async () => {
    const { command, tournament } = loadCommand();
    const { channel, calls } = makeChannel();
    const liveSettings = new Map();
    const client = makeClient(channel, liveSettings);
    const originalMessage = await channel.send({ content: 'Bracket posted from standings' });
    linkStandingsMessage({ command, tournament, client, channel }, originalMessage);
    const { message, replies } = makeCommandMessage({ client, channel });

    await command.execute(message, []);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.edited.length, 1);
    assert.deepEqual(calls.edited[0].attachments, []);
    assert.equal(calls.edited[0].files[0].name, 'knockout-bracket.png');
    assert.match(replies[0], /Updated the live bracket image/);
    assert.deepEqual(liveSettings.get(command.getLiveBracketImageKey('guild-1', tournament.tournamentKey)), {
        channelId: 'channel-1', messageId: originalMessage.id, tournamentKey: 'cup-s1'
    });

    await command.execute(message, []);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.edited.length, 2);
});

test('a report refresh reposts and re-links the image when its saved message is deleted', async () => {
    const { command, tournament } = loadCommand();
    const { channel, calls } = makeChannel();
    const key = command.getLiveBracketImageKey('guild-1', tournament.tournamentKey);
    const liveSettings = new Map([[key, {
        channelId: channel.id,
        messageId: 'deleted-image',
        tournamentKey: tournament.tournamentKey
    }]]);
    const client = makeClient(channel, liveSettings);

    const result = await command.refreshLiveBracketImage(client, 'guild-1', tournament.tournamentKey, tournament);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'reposted');
    assert.equal(calls.sent.length, 1);
    assert.equal(liveSettings.get(key).messageId, 'image-1');
});

test('bracketimage reposts if a fetched message goes stale before it can be edited', async () => {
    const { command, tournament } = loadCommand();
    const { channel, calls } = makeChannel();
    const liveSettings = new Map();
    const client = makeClient(channel, liveSettings);
    const originalMessage = await channel.send({ content: 'Bracket posted from standings' });
    originalMessage.edit = async () => {
        const error = new Error('Unknown Message');
        error.code = 10008;
        throw error;
    };
    linkStandingsMessage({ command, tournament, client, channel }, originalMessage);

    const result = await command.publishOrUpdateBracketImage({
        client, guildId: 'guild-1', tournament, channel
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'reposted');
    assert.equal(calls.sent.length, 2);
    assert.equal(liveSettings.get(command.getLiveBracketImageKey('guild-1', tournament.tournamentKey)).messageId, 'image-2');
});

test('bracketimage reports missing fixtures without posting a blank image', async () => {
    const { command, tournament } = loadCommand({ hasImage: false });
    const { channel, calls } = makeChannel();
    const liveSettings = new Map();
    const client = makeClient(channel, liveSettings);
    const originalMessage = await channel.send({ content: 'Bracket posted from standings' });
    linkStandingsMessage({ command, tournament, client, channel }, originalMessage);
    const { message, replies } = makeCommandMessage({ client, channel });

    await command.execute(message, []);
    assert.match(replies[0], /No knockout fixtures are available/i);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.edited.length, 0);
});
