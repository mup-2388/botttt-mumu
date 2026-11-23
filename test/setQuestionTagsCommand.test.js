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
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    setRequired(required) { this.required = required; return this; }
    setMaxLength(maxLength) { this.maxLength = maxLength; return this; }
}

class FakeSlashCommandBuilder {
    constructor() { this.options = []; }
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    addStringOption(configure) {
        this.options.push(configure(new FakeOption()));
        return this;
    }
}

test('setquestiontags saves any number of unique server members and supports clear', async () => {
    const firstUserId = '888888888888888888';
    const secondUserId = '999999999999999999';
    const thirdUserId = '101010101010101010';
    const memberIds = new Set([firstUserId, secondUserId, thirdUserId]);
    const updates = [];
    const command = requireWithMocks('../commands/tournament/setquestiontags', {
        'discord.js': { SlashCommandBuilder: FakeSlashCommandBuilder },
        '../../models/Tournament': {
            ServerConfig: {
                findOneAndUpdate: async (...args) => {
                    updates.push(args);
                    return { guildId: 'guild-1' };
                }
            }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true }
    });
    const guild = {
        id: 'guild-1',
        members: {
            cache: new Map([[firstUserId, { id: firstUserId }]]),
            fetch: async userId => memberIds.has(userId) ? { id: userId } : null
        }
    };
    const replies = [];
    const message = {
        guild,
        author: { id: 'organizer-1' },
        reply: async payload => {
            replies.push(payload);
            return payload;
        }
    };

    assert.equal(command.name, 'setquestiontags');
    assert.equal(command.data.options[0].name, 'users');
    assert.equal(command.data.options[0].required, true);
    assert.equal(command.data.options[0].maxLength, 6000);
    assert.deepEqual(command.parseQuestionTagInput(`<@${firstUserId}> <@!${secondUserId}> ${firstUserId}`), {
        userIds: [firstUserId, secondUserId]
    });
    assert.deepEqual(command.parseQuestionTagInput('clear'), { userIds: [] });
    assert.ok(command.parseQuestionTagInput(`<@&${firstUserId}>`).error, 'role mentions are rejected');

    await command.execute(message, [
        `<@${firstUserId}>`,
        `<@!${secondUserId}>`,
        `<@${thirdUserId}>`,
        `<@${firstUserId}>`
    ]);

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0][0], { guildId: 'guild-1' });
    assert.deepEqual(updates[0][1], {
        $setOnInsert: { guildId: 'guild-1' },
        $set: { questionTagUserIds: [firstUserId, secondUserId, thirdUserId] }
    });
    assert.deepEqual(updates[0][2], { upsert: true, new: true });
    assert.match(replies.at(-1).content, /Saved \*\*3\*\* Questions contacts/);

    await command.execute(message, [`<@${firstUserId}>`, '<@111111111111111111>']);
    assert.equal(updates.length, 1, 'invalid or non-member IDs must not partially update the saved list');
    assert.match(replies.at(-1).content, /not a member of this server/);

    await command.execute(message, ['clear']);
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[1][1].$set.questionTagUserIds, []);
    assert.match(replies.at(-1).content, /Cleared the Questions tags/);
});

test('slash setquestiontags defers privately and accepts a list of member mentions', async () => {
    const userIds = ['888888888888888888', '999999999999999999'];
    const updates = [];
    const command = requireWithMocks('../commands/tournament/setquestiontags', {
        'discord.js': { SlashCommandBuilder: FakeSlashCommandBuilder },
        '../../models/Tournament': {
            ServerConfig: {
                findOneAndUpdate: async (...args) => {
                    updates.push(args);
                    return { guildId: 'guild-1' };
                }
            }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true }
    });
    const guild = {
        id: 'guild-1',
        members: {
            cache: new Map(),
            fetch: async userId => userIds.includes(userId) ? { id: userId } : null
        }
    };
    const replies = [];
    const interaction = {
        guild,
        user: { id: 'organizer-1' },
        options: { getString: () => `<@${userIds[0]}>, <@${userIds[1]}>` },
        deferReply: async function (options) {
            this.deferred = true;
            this.ephemeral = options.ephemeral;
        },
        editReply: async payload => {
            replies.push(payload);
            return payload;
        },
        deferred: false,
        replied: false
    };

    await command.slashExecute(interaction);

    assert.equal(interaction.deferred, true);
    assert.equal(interaction.ephemeral, true);
    assert.deepEqual(updates[0][1].$set.questionTagUserIds, userIds);
    assert.match(replies.at(-1).content, /Saved \*\*2\*\* Questions contacts/);
});
