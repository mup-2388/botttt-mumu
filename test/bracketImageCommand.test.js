const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const {
    getLiveBracketImageKey,
    isLiveBracketImageReference
} = require('../utils/liveBracketImage');

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
    const tournament = {
        _id: 'tournament-1',
        tournamentKey: 'cup-s1',
        name: 'Cup S1',
        emoji: '🏆',
        formatType: 'knockout'
    };
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
            getTournamentByKey: async () => tournament
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

function makeChannel(id) {
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

function makeClient(channels, liveSettings = new Map()) {
    const channelMap = new Map(channels.map(channel => [channel.id, channel]));
    return {
        liveSettings,
        channels: { fetch: async id => channelMap.get(id) || null }
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

test('bracketimage posts and persists the first dedicated live bracket message', async () => {
    const { command, tournament } = loadCommand();
    const { channel, calls } = makeChannel('channel-1');
    const client = makeClient([channel]);
    const { message, replies } = makeCommandMessage({ client, channel });

    await command.execute(message, []);

    const saved = client.liveSettings.get(getLiveBracketImageKey('guild-1', tournament.tournamentKey));
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.edited.length, 0);
    assert.equal(calls.sent[0].files[0].name, 'knockout-bracket.png');
    assert.match(replies[0], /Posted the live bracket/);
    assert.equal(isLiveBracketImageReference(saved), true);
    assert.deepEqual(saved, {
        channelId: 'channel-1',
        messageId: 'image-1',
        tournamentKey: 'cup-s1',
        source: 'bracketimage'
    });
});

test('re-running bracketimage from another channel edits the same single message', async () => {
    const { command, tournament } = loadCommand();
    const first = makeChannel('channel-1');
    const elsewhere = makeChannel('channel-2');
    const client = makeClient([first.channel, elsewhere.channel]);
    const firstInvocation = makeCommandMessage({ client, channel: first.channel });
    const secondInvocation = makeCommandMessage({ client, channel: elsewhere.channel });

    await command.execute(firstInvocation.message, []);
    await command.execute(secondInvocation.message, []);

    const saved = client.liveSettings.get(getLiveBracketImageKey('guild-1', tournament.tournamentKey));
    assert.equal(first.calls.sent.length, 1);
    assert.equal(first.calls.edited.length, 1);
    assert.deepEqual(first.calls.edited[0].attachments, []);
    assert.equal(first.calls.edited[0].files[0].name, 'knockout-bracket.png');
    assert.equal(elsewhere.calls.sent.length, 0);
    assert.match(secondInvocation.replies[0], /Updated the live bracket/);
    assert.equal(saved.channelId, 'channel-1');
    assert.equal(saved.messageId, 'image-1');
});

test('slash /bracketimage creates then updates the persistent post instead of duplicating it', async () => {
    const { command } = loadCommand();
    const { channel, calls } = makeChannel('channel-1');
    const client = makeClient([channel]);
    const confirmations = [];
    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        client,
        channel,
        options: { getString: () => null },
        deferReply: async () => { interaction.deferred = true; },
        editReply: async payload => { confirmations.push(payload.content); }
    };

    await command.slashExecute(interaction);
    await command.slashExecute(interaction);

    assert.equal(calls.sent.length, 1);
    assert.equal(calls.edited.length, 1);
    assert.match(confirmations[0], /Posted the live bracket/);
    assert.match(confirmations[1], /Updated the live bracket/);
});

test('simultaneous first-time bracketimage calls still create only one live message', async () => {
    const { command } = loadCommand();
    const { channel, calls } = makeChannel('channel-1');
    const client = makeClient([channel]);
    const first = makeCommandMessage({ client, channel });
    const second = makeCommandMessage({ client, channel });

    await Promise.all([
        command.execute(first.message, []),
        command.execute(second.message, [])
    ]);

    assert.equal(calls.sent.length, 1);
    assert.equal(calls.edited.length, 1);
    assert.equal(client.liveSettings.size, 1);
});

test('report refresh edits the dedicated live bracket in place without posting another message', async () => {
    const { command, tournament } = loadCommand();
    const { channel, calls } = makeChannel('channel-1');
    const client = makeClient([channel]);
    const { message } = makeCommandMessage({ client, channel });
    await command.execute(message, []);

    const result = await command.refreshLiveBracketImage(client, 'guild-1', tournament.tournamentKey, tournament);
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.action, 'updated');
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.edited.length, 1);
});

test('a report refresh reposts and re-links the image if the saved message was deleted', async () => {
    const { command, tournament } = loadCommand();
    const { channel, calls } = makeChannel('channel-1');
    const key = getLiveBracketImageKey('guild-1', tournament.tournamentKey);
    const client = makeClient([channel], new Map([[key, {
        channelId: channel.id,
        messageId: 'deleted-image',
        tournamentKey: tournament.tournamentKey,
        source: 'bracketimage'
    }]]));

    const result = await command.refreshLiveBracketImage(client, 'guild-1', tournament.tournamentKey, tournament);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'reposted');
    assert.equal(calls.sent.length, 1);
    assert.equal(client.liveSettings.get(key).messageId, 'image-1');
});

test('bracketimage recovers if a fetched message goes stale before the edit', async () => {
    const { command, tournament } = loadCommand();
    const { channel, calls } = makeChannel('channel-1');
    const key = getLiveBracketImageKey('guild-1', tournament.tournamentKey);
    const originalMessage = await channel.send({ content: 'Live bracket' });
    originalMessage.edit = async () => {
        const error = new Error('Unknown Message');
        error.code = 10008;
        throw error;
    };
    const client = makeClient([channel], new Map([[key, {
        channelId: channel.id,
        messageId: originalMessage.id,
        tournamentKey: tournament.tournamentKey,
        source: 'bracketimage'
    }]]));

    const result = await command.publishOrUpdateBracketImage({
        client, guildId: 'guild-1', tournament, channel
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'reposted');
    assert.equal(calls.sent.length, 2);
    assert.equal(client.liveSettings.get(key).messageId, 'image-2');
});

test('bracketimage creates a dedicated message instead of taking over a legacy standings image', async () => {
    const { command, tournament } = loadCommand();
    const oldStandings = makeChannel('old-channel');
    const commandChannel = makeChannel('command-channel');
    const legacyMessage = await oldStandings.channel.send({ content: 'Old standings bracket' });
    const key = getLiveBracketImageKey('guild-1', tournament.tournamentKey);
    const client = makeClient([oldStandings.channel, commandChannel.channel], new Map([[key, {
        channelId: oldStandings.channel.id,
        messageId: legacyMessage.id,
        tournamentKey: tournament.tournamentKey
    }]]));

    const result = await command.publishOrUpdateBracketImage({
        client, guildId: 'guild-1', tournament, channel: commandChannel.channel
    });

    assert.equal(result.action, 'posted');
    assert.equal(oldStandings.calls.edited.length, 0);
    assert.equal(commandChannel.calls.sent.length, 1);
    assert.equal(client.liveSettings.get(key).channelId, 'command-channel');
    assert.equal(client.liveSettings.get(key).source, 'bracketimage');
});

test('reports do not create a live bracket until bracketimage has been run', async () => {
    const { command, tournament } = loadCommand();
    const { channel, calls } = makeChannel('channel-1');
    const client = makeClient([channel]);

    const result = await command.refreshLiveBracketImage(client, 'guild-1', tournament.tournamentKey, tournament);
    assert.equal(result.updated, false);
    assert.equal(result.reason, 'not-linked');
    assert.equal(calls.sent.length, 0);
});

test('bracketimage is unavailable before groups-knockout changes to a knockout phase', async () => {
    const { command, tournament, renderCalls } = loadCommand();
    tournament.formatType = 'groups_knockout';
    tournament.currentPhase = 'groups';
    const { channel, calls } = makeChannel('channel-1');
    const client = makeClient([channel]);
    const { message, replies } = makeCommandMessage({ client, channel });

    await command.execute(message, []);
    assert.equal(renderCalls.length, 0);
    assert.equal(calls.sent.length, 0);
    assert.match(replies[0], /available after the knockout stage/i);
});

test('bracketimage does not post a blank image when knockout fixtures are missing', async () => {
    const { command } = loadCommand({ hasImage: false });
    const { channel, calls } = makeChannel('channel-1');
    const client = makeClient([channel]);
    const { message, replies } = makeCommandMessage({ client, channel });

    await command.execute(message, []);
    assert.match(replies[0], /No knockout fixtures are available/i);
    assert.equal(calls.sent.length, 0);
    assert.equal(client.liveSettings.size, 0);
});
