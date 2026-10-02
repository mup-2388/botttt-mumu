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
    setMaxLength() { return this; }
}

class FakeSlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addStringOption(configure) {
        configure(new FakeOption());
        return this;
    }
}

test('postmatchday posts the next round with real allowed mentions and no fixture mutations', async () => {
    const guildId = 'guild-1';
    const destinationId = '444444444444444444';
    const stadiumOneId = '333333333333333333';
    const stadiumTwoId = '555555555555555555';
    const fixturesRoleId = '1554519598597021766';
    const homeRoleId = '111111111111111111';
    const awayRoleId = '222222222222222222';
    const sent = [];
    const fixtureRows = [
        { roundLabel: 'Matchday 1', status: 'Pending', matchNumber: 10, homeTeam: 'Falcons', awayTeam: 'Wolves' },
        { roundLabel: 'Matchday 1', status: 'Pending', matchNumber: 2, homeTeam: 'Wolves', awayTeam: 'Falcons', scheduledAt: new Date() },
        { roundLabel: 'Matchday 2', status: 'Pending', matchNumber: 1, homeTeam: 'Falcons', awayTeam: 'Wolves' }
    ];
    const fixtureQuery = {
        select() { return this; },
        sort() { return this; },
        lean: async () => fixtureRows
    };
    const teams = [
        { name: 'Falcons', stadium: `<#${stadiumOneId}>`, captainID: '666666666666666666' },
        { name: 'Wolves', stadium: 'wolves-arena', captainID: '777777777777777777' }
    ];
    const teamQuery = {
        select() { return this; },
        lean: async () => teams
    };

    const permissionSet = { has: () => true };
    const testSent = [];
    let serverConfigReads = 0;
    let roleFetchCalls = 0;
    const testChannel = {
        id: '888888888888888888',
        guildId,
        type: 0,
        permissionsFor: () => permissionSet,
        send: async payload => {
            testSent.push(payload);
            return { id: 'test-message' };
        }
    };
    const destination = {
        id: destinationId,
        guildId,
        type: 0,
        permissionsFor: () => permissionSet,
        send: async payload => {
            sent.push(payload);
            return { id: 'posted-message' };
        }
    };
    const stadiumOne = { id: stadiumOneId, guildId, type: 0, name: 'falcons-arena' };
    const stadiumTwo = { id: stadiumTwoId, guildId, type: 0, name: 'wolves-arena' };
    const channels = new Map([
        [destinationId, destination],
        [stadiumOneId, stadiumOne],
        [stadiumTwoId, stadiumTwo],
        [testChannel.id, testChannel]
    ]);
    const rolesCache = new Map([
        [fixturesRoleId, { id: fixturesRoleId, name: 'HFSL fixtures', mentionable: true }],
        [homeRoleId, { id: homeRoleId, name: 'Falcons', mentionable: true }],
        [awayRoleId, { id: awayRoleId, name: 'Wolves', mentionable: true }]
    ]);
    const guild = {
        id: guildId,
        channels: {
            cache: channels,
            fetch: async id => id ? channels.get(id) || null : channels
        },
        roles: {
            cache: rolesCache,
            fetch: async id => {
                roleFetchCalls++;
                return id ? rolesCache.get(id) || null : rolesCache;
            }
        },
        members: {
            me: { permissionsIn: () => permissionSet }
        }
    };
    const replyPayloads = [];

    const command = requireWithMocks('../commands/tournament/postmatchday', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1n, MentionEveryone: 2n },
            ChannelType: { GuildText: 0, GuildAnnouncement: 5 },
            escapeMarkdown: value => String(value)
        },
        '../../models/Tournament': {
            Fixture: {
                find: () => fixtureQuery,
                updateOne: async () => { throw new Error('postmatchday must not write fixtures'); }
            },
            Team: { find: () => teamQuery },
            ServerConfig: {
                findOne: () => {
                    serverConfigReads++;
                    return { lean: async () => ({ defaultFixturesChannelId: destinationId }) };
                }
            }
        },
        '../../utils/getTournament': { getDefaultTournament: async () => ({ _id: 'tournament-1', name: 'Test Cup' }) },
        '../../utils/isOrganizer': { isOrganizer: async () => true }
    });

    await command.runPostMatchday({
        guild,
        deadline: 'Friday 8 PM',
        reply: async payload => {
            replyPayloads.push(payload);
            return payload;
        }
    });

    assert.equal(sent.length, 1);
    const announcement = sent[0];
    assert.ok(announcement.content.indexOf('__Match 2__') < announcement.content.indexOf('__Match 10__'));
    assert.ok(!announcement.content.includes('__Match 1__\n'));
    assert.ok(announcement.content.includes(`<:Stadium:1487010283506630776> <#${stadiumTwoId}>`));
    assert.ok(announcement.content.includes('Deadline : `Friday 8 PM`'));
    assert.ok(announcement.content.includes(`<@&${fixturesRoleId}>`));
    assert.deepEqual(announcement.allowedMentions.parse, []);
    assert.deepEqual(announcement.allowedMentions.roles, [fixturesRoleId, awayRoleId, homeRoleId]);
    assert.deepEqual(announcement.allowedMentions.users, [
        '774318165722529792',
        '1531201010532618241'
    ]);
    assert.match(replyPayloads.at(-1).content, /Posted \*\*Matchday 1\*\*/);
    assert.equal(serverConfigReads, 1);
    const roleFetchesAfterPublish = roleFetchCalls;

    await command.runPostMatchday({
        guild,
        deadline: 'Friday 8 PM',
        testMode: true,
        targetChannel: testChannel,
        reply: async payload => {
            replyPayloads.push(payload);
            return payload;
        }
    });

    assert.equal(serverConfigReads, 1, 'test mode should not read or use the configured destination');
    assert.equal(roleFetchCalls, roleFetchesAfterPublish, 'test mode should not look up ping roles');
    assert.equal(testSent.length, 1);
    assert.ok(testSent[0].content.includes('HFSL fixtures'));
    assert.ok(testSent[0].content.includes('Questions? UNALDO · Aashank'));
    assert.doesNotMatch(testSent[0].content, /<@/);
    assert.deepEqual(testSent[0].allowedMentions.roles, []);
    assert.deepEqual(testSent[0].allowedMentions.users, []);
    assert.match(replyPayloads.at(-1).content, /No user or role pings were sent/);
});
