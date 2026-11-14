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
    addChoices(...choices) { this.choices = choices; return this; }
}

class FakeSlashCommandBuilder {
    constructor() { this.options = []; }
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    addStringOption(configure) {
        const option = configure(new FakeOption());
        this.options.push(option);
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
    const fixtureFilters = [];
    const fixtureRows = [
        { roundLabel: 'Matchday 1', status: 'Pending', matchNumber: 10, homeTeam: 'Falcons', awayTeam: 'Wolves' },
        { roundLabel: 'Matchday 1', status: 'Pending', matchNumber: 2, homeTeam: 'Wolves', awayTeam: 'Falcons', scheduledAt: new Date() },
        { roundLabel: 'Matchday 1', status: 'Pending', matchNumber: 1, homeTeam: 'Falcons', awayTeam: 'Wolves', reserved: { isReserved: true } },
        { roundLabel: 'Matchday 2', status: 'Pending', matchNumber: 3, homeTeam: 'Falcons', awayTeam: 'Wolves' },
        { phase: 'roundof16', roundLabel: 'Round of 16 1', status: 'Pending', matchNumber: 12, homeTeam: 'Falcons', awayTeam: 'Wolves' },
        { phase: 'roundof16', roundLabel: 'Round of 16 2', status: 'Pending', matchNumber: 11, homeTeam: 'Wolves', awayTeam: 'Falcons' },
        { phase: 'roundof16', roundLabel: 'Round of 16 3', status: 'Played', matchNumber: 10, homeTeam: 'Falcons', awayTeam: 'Wolves' },
        { phase: 'quarterfinal', roundLabel: 'Quarter Final 1', status: 'Pending', matchNumber: 13, homeTeam: 'Falcons', awayTeam: 'Wolves' },
        { phase: 'final', roundLabel: 'Final', status: 'Pending', matchNumber: 14, homeTeam: 'Falcons', awayTeam: 'Wolves' }
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
                find: filter => {
                    fixtureFilters.push(filter);
                    return fixtureQuery;
                },
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

    assert.deepEqual(command.data.options.map(option => option.name), ['deadline', 'round', 'venue']);
    assert.equal(command.data.options[2].required, false);
    assert.equal(command.data.options[2].maxLength, 100);

    assert.deepEqual(command.parsePostMatchdayArgs(['round of 16', 'Friday', '8 PM']), {
        roundPhase: 'roundof16',
        deadline: 'Friday 8 PM',
        venue: null
    });
    assert.deepEqual(command.parsePostMatchdayArgs(['Friday', '8 PM']), {
        roundPhase: null,
        deadline: 'Friday 8 PM',
        venue: null
    });
    assert.deepEqual(command.parsePostMatchdayArgs(['final', 'Friday', '8', 'PM', 'venue:Wembley', 'Stadium']), {
        roundPhase: 'final',
        deadline: 'Friday 8 PM',
        venue: 'Wembley Stadium'
    });
    assert.deepEqual(command.parsePostMatchdayArgs(['final', 'Friday', 'venue:']), {
        roundPhase: 'final',
        deadline: 'Friday',
        venue: ''
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
    assert.deepEqual(fixtureFilters[0]['reserved.isReserved'], { $ne: true });
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

    await command.runPostMatchday({
        guild,
        deadline: 'Friday 8 PM',
        roundPhase: 'roundof16',
        reply: async payload => {
            replyPayloads.push(payload);
            return payload;
        }
    });

    assert.equal(sent.length, 2);
    assert.equal(fixtureFilters[1].phase, 'roundof16');
    assert.match(sent[1].content, /^# ROUND OF 16/m);
    assert.ok(sent[1].content.indexOf('__Match 11__') < sent[1].content.indexOf('__Match 12__'));
    assert.doesNotMatch(sent[1].content, /__Match 10__|__Match 13__/);
    assert.match(replyPayloads.at(-1).content, /Posted \*\*Round of 16\*\*/);
    assert.equal(serverConfigReads, 2);

    const falconsStadium = teams[0].stadium;
    teams[0].stadium = '';
    await command.runPostMatchday({
        guild,
        deadline: 'Sunday 8 PM',
        roundPhase: 'final',
        venue: 'Wembley Stadium',
        reply: async payload => {
            replyPayloads.push(payload);
            return payload;
        }
    });
    teams[0].stadium = falconsStadium;

    assert.equal(sent.length, 3);
    assert.equal(fixtureFilters[2].phase, 'final');
    assert.match(sent[2].content, /^# FINAL/m);
    assert.ok(sent[2].content.includes('<:Stadium:1487010283506630776> Wembley Stadium'));
    assert.doesNotMatch(sent[2].content, /<#333333333333333333>|<#555555555555555555>/);
    assert.match(replyPayloads.at(-1).content, /Posted \*\*Final\*\*/);
    assert.equal(serverConfigReads, 3);

    await command.runPostMatchday({
        guild,
        deadline: 'Sunday 8 PM',
        roundPhase: 'final',
        reply: async payload => {
            replyPayloads.push(payload);
            return payload;
        }
    });

    assert.equal(sent.length, 4);
    assert.ok(sent[3].content.includes(`<:Stadium:1487010283506630776> <#${stadiumOneId}>`));
    assert.doesNotMatch(sent[3].content, /Wembley Stadium/);
    assert.equal(serverConfigReads, 4);

    await command.execute({
        guild,
        author: { id: 'organizer-1' },
        reply: async payload => {
            replyPayloads.push(payload);
            return payload;
        }
    }, ['final', 'Monday', '8', 'PM', 'venue:Prefix', 'Ground']);

    assert.equal(sent.length, 5);
    assert.ok(sent[4].content.includes('<:Stadium:1487010283506630776> Prefix Ground'));
    assert.equal(serverConfigReads, 5);

    const slashInteraction = {
        guild,
        user: { id: 'organizer-1' },
        options: {
            getString: name => ({
                deadline: 'Tuesday 8 PM',
                round: 'final',
                venue: 'Slash Arena @everyone <#333333333333333333>'
            })[name] ?? null
        },
        deferReply: async function () { this.deferred = true; },
        editReply: async payload => {
            replyPayloads.push(payload);
            return payload;
        },
        deferred: false,
        replied: false
    };
    await command.slashExecute(slashInteraction);

    assert.equal(sent.length, 6);
    assert.ok(sent[5].content.includes('<:Stadium:1487010283506630776> Slash Arena @\u200beveryone ‹#333333333333333333›'));
    assert.doesNotMatch(sent[5].content, /<#333333333333333333>/);
    assert.equal(serverConfigReads, 6);

    let invalidVenueReply;
    await command.runPostMatchday({
        guild,
        deadline: 'Friday 8 PM',
        roundPhase: 'roundof16',
        venue: 'Must Be Final Only',
        reply: async payload => {
            invalidVenueReply = payload;
            return payload;
        }
    });
    assert.match(invalidVenueReply.content, /only be used with the Final/);
    assert.equal(sent.length, 6);
    assert.equal(serverConfigReads, 6);

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

    assert.equal(serverConfigReads, 6, 'test mode should not read or use the configured destination');
    assert.equal(roleFetchCalls, roleFetchesAfterPublish, 'test mode should not look up ping roles');
    assert.equal(testSent.length, 1);
    assert.ok(testSent[0].content.includes('HFSL fixtures'));
    assert.ok(testSent[0].content.includes('Questions? UNALDO · Aashank'));
    assert.doesNotMatch(testSent[0].content, /<@/);
    assert.deepEqual(testSent[0].allowedMentions.roles, []);
    assert.deepEqual(testSent[0].allowedMentions.users, []);
    assert.match(replyPayloads.at(-1).content, /No user or role pings were sent/);

    const previewCommand = requireWithMocks('../commands/tournament/testpostmatchday', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1n }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        './postmatchday': command
    });
    assert.deepEqual(previewCommand.data.options.map(option => option.name), ['deadline', 'round', 'venue']);
    assert.equal(previewCommand.data.options[2].required, false);
    const previewReplies = [];
    await previewCommand.execute({
        guild,
        author: { id: 'organizer-1' },
        channel: testChannel,
        reply: async payload => {
            previewReplies.push(payload);
            return payload;
        }
    }, ['roundof16', 'Friday', '8 PM']);

    assert.equal(testSent.length, 2);
    assert.match(testSent[1].content, /^# ROUND OF 16/m);
    assert.doesNotMatch(testSent[1].content, /<@/);
    assert.deepEqual(testSent[1].allowedMentions.roles, []);
    assert.deepEqual(testSent[1].allowedMentions.users, []);
    assert.match(previewReplies.at(-1).content, /Test announcement for \*\*Round of 16\*\*/);
    assert.equal(serverConfigReads, 6, 'preview command should continue using its current channel');
    assert.equal(roleFetchCalls, roleFetchesAfterPublish, 'preview command should not look up ping roles');

    await previewCommand.execute({
        guild,
        author: { id: 'organizer-1' },
        channel: testChannel,
        reply: async payload => {
            previewReplies.push(payload);
            return payload;
        }
    }, ['final', 'Sunday', '8', 'PM', 'venue:Neutral', 'Ground']);

    assert.equal(testSent.length, 3);
    assert.match(testSent[2].content, /^# FINAL/m);
    assert.ok(testSent[2].content.includes('<:Stadium:1487010283506630776> Neutral Ground'));
    assert.doesNotMatch(testSent[2].content, /<#333333333333333333>/);
    assert.doesNotMatch(testSent[2].content, /<@/);
    assert.match(previewReplies.at(-1).content, /Test announcement for \*\*Final\*\*/);

    const previewSlashReplies = [];
    const previewSlashInteraction = {
        guild,
        user: { id: 'organizer-1' },
        channel: testChannel,
        options: {
            getString: name => ({
                deadline: 'Monday 8 PM',
                round: 'final',
                venue: 'Preview Arena'
            })[name] ?? null
        },
        deferReply: async function () { this.deferred = true; },
        editReply: async payload => {
            previewSlashReplies.push(payload);
            return payload;
        },
        deferred: false,
        replied: false
    };
    await previewCommand.slashExecute(previewSlashInteraction);

    assert.equal(testSent.length, 4);
    assert.match(testSent[3].content, /^# FINAL/m);
    assert.ok(testSent[3].content.includes('<:Stadium:1487010283506630776> Preview Arena'));
    assert.doesNotMatch(testSent[3].content, /<@/);
    assert.match(previewSlashReplies.at(-1).content, /Test announcement for \*\*Final\*\*/);
    assert.equal(serverConfigReads, 6, 'preview command should continue using its current channel');
    assert.equal(roleFetchCalls, roleFetchesAfterPublish, 'preview command should not look up ping roles');
});
