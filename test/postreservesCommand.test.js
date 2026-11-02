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

class FakeSlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
}

function makeHarness({ fixtures = null } = {}) {
    const guildId = 'guild-1';
    const destinationId = '444444444444444444';
    const stadiumId = '333333333333333333';
    const fixturesRoleId = '1554519598597021766';
    const falconsRoleId = '111111111111111111';
    const wolvesRoleId = '222222222222222222';
    const sent = [];
    const fixtureFilters = [];
    let serverConfigReads = 0;
    let roleFetchCalls = 0;

    const sourceFixtures = fixtures || Array.from({ length: 30 }, (_, index) => ({
        matchNumber: index + 1,
        roundLabel: `Matchday ${Math.floor(index / 4) + 1}`,
        status: 'Pending',
        homeTeam: index % 2 ? 'Falcons' : 'Wolves',
        awayTeam: index % 2 ? 'Wolves' : 'Falcons',
        scheduledAt: null,
        venueName: null,
        reserved: {
            isReserved: true,
            until: index === 0 ? null : new Date(`2026-12-${String((index % 27) + 1).padStart(2, '0')}T15:00:00Z`),
            note: index === 0 ? null : `Weather delay for fixture ${index + 1}`
        }
    })).concat([
        {
            matchNumber: 90,
            status: 'Pending',
            homeTeam: 'Falcons',
            awayTeam: 'Wolves',
            reserved: { isReserved: false }
        },
        {
            matchNumber: 91,
            status: 'Played',
            homeTeam: 'Falcons',
            awayTeam: 'Wolves',
            reserved: { isReserved: true }
        }
    ]);

    const fixtureQuery = {
        select() { return this; },
        sort(sortSpec) {
            this.sortSpec = sortSpec;
            return this;
        },
        lean: async function () {
            return sourceFixtures
                .filter(fixture => fixture.reserved?.isReserved === true && ['Pending', 'Live'].includes(fixture.status))
                .sort((a, b) => a.matchNumber - b.matchNumber);
        }
    };
    const teams = [
        { name: 'Falcons', stadium: `<#${stadiumId}>`, captainID: '666666666666666666' },
        { name: 'Wolves', stadium: `<#${stadiumId}>`, captainID: '777777777777777777' }
    ];
    const teamQuery = {
        select() { return this; },
        lean: async () => teams
    };
    const permissionSet = { has: () => true };
    const destination = {
        id: destinationId,
        guildId,
        type: 0,
        permissionsFor: () => permissionSet,
        send: async payload => {
            sent.push(payload);
            return { id: `message-${sent.length}` };
        }
    };
    const stadium = { id: stadiumId, guildId, type: 0, name: 'falcons-arena' };
    const channels = new Map([
        [destinationId, destination],
        [stadiumId, stadium]
    ]);
    const rolesCache = new Map([
        [fixturesRoleId, { id: fixturesRoleId, name: 'HFSL fixtures', mentionable: true }],
        [falconsRoleId, { id: falconsRoleId, name: 'Falcons', mentionable: true }],
        [wolvesRoleId, { id: wolvesRoleId, name: 'Wolves', mentionable: true }]
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
    const command = requireWithMocks('../commands/tournament/postreserves', {
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
                }
            },
            Team: { find: () => teamQuery },
            ServerConfig: {
                findOne: () => {
                    serverConfigReads++;
                    return { lean: async () => ({ defaultFixturesChannelId: destinationId }) };
                }
            }
        },
        '../../utils/getTournament': {
            getDefaultTournament: async () => ({ _id: 'tournament-1', name: 'Test Cup' })
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/istTime': {
            discordFull: value => `<t:${Math.floor(new Date(value).getTime() / 1000)}:F>`,
            discordRelative: () => '<t:1798732800:R>'
        },
        '../../utils/ai/emojiSlots': {
            slotEmoji: () => '📅',
            vsLine: (home, away) => `${home} VS ${away}`
        },
        '../../utils/matchdayAnnouncement': {
            FIXTURES_ROLE_ID: fixturesRoleId,
            UNALDO_USER_ID: '774318165722529792',
            AASHANK_USER_ID: '1531201010532618241',
            DISCORD_MESSAGE_LIMIT: 2000
        },
        './postmatchday': {
            isSupportedTextChannel: channel => Boolean(channel && channel.guildId === guildId && channel.type === 0),
            resolveStadiumChannel: async (targetGuild, stadiumText) => {
                const id = String(stadiumText || '').match(/\d{15,22}/)?.[0];
                return { channel: id ? targetGuild.channels.cache.get(id) || null : null, error: 'not found' };
            },
            resolveTeamMention: ({ teamName, team, teamRoles, roleIds, userIds }) => {
                const role = teamRoles.find(candidate => candidate.name === team?.name);
                if (role) {
                    roleIds.add(role.id);
                    return `<@&${role.id}>`;
                }
                if (team?.captainID) {
                    userIds.add(team.captainID);
                    return `<@${team.captainID}>`;
                }
                return `**${teamName}**`;
            },
            normalizeName: value => String(value || '').trim().toLowerCase()
        }
    });

    return {
        command,
        guild,
        destination,
        sent,
        fixtureFilters,
        get serverConfigReads() { return serverConfigReads; },
        get roleFetchCalls() { return roleFetchCalls; },
        fixturesRoleId,
        falconsRoleId,
        wolvesRoleId,
        stadiumId,
        guildId
    };
}

test('postreserves announces all active reserved fixtures in paginated messages with scoped allowed mentions', async () => {
    const harness = makeHarness();
    const replies = [];

    await harness.command.runPostReserves({
        guild: harness.guild,
        reply: async payload => {
            replies.push(payload);
            return payload;
        }
    });

    assert.deepEqual(harness.fixtureFilters[0], {
        guildId: harness.guildId,
        tournamentId: 'tournament-1',
        'reserved.isReserved': true,
        status: { $in: ['Pending', 'Live'] }
    });
    assert.ok(harness.sent.length > 1, 'long announcements should be split into multiple messages');
    assert.ok(harness.sent.every(payload => payload.content.length <= 2000));

    const content = harness.sent.map(payload => payload.content).join('\n');
    for (let matchNumber = 1; matchNumber <= 30; matchNumber++) {
        assert.ok(content.includes(`__Match #${matchNumber}__`), `match ${matchNumber} should be announced`);
    }
    assert.ok(!content.includes('__Match #90__'), 'non-reserved fixtures should not be announced');
    assert.ok(!content.includes('__Match #91__'), 'played fixtures should not be announced');
    assert.ok(content.includes('New time: not set'), 'fixtures without a reserve date should say so');
    assert.match(content, /New time: <t:\d+:F> \(<t:\d+:R>\)/, 'reserve dates should use Discord timestamps');
    assert.ok(content.includes('Matchday 1'), 'the original round label should be shown');
    assert.ok(content.includes('Weather delay for fixture 2'), 'reserve notes should be included');
    assert.ok(content.includes(`<#${harness.stadiumId}>`), 'home stadium should be shown');
    assert.ok(content.includes(`<@&${harness.fixturesRoleId}>`), 'first page should announce the fixtures role');

    const firstPayload = harness.sent[0];
    assert.deepEqual(firstPayload.allowedMentions.parse, []);
    assert.ok(firstPayload.allowedMentions.roles.includes(harness.fixturesRoleId));
    assert.ok(firstPayload.allowedMentions.roles.includes(harness.falconsRoleId));
    assert.ok(firstPayload.allowedMentions.roles.includes(harness.wolvesRoleId));
    assert.ok(firstPayload.allowedMentions.users.includes('774318165722529792'));
    assert.ok(firstPayload.allowedMentions.users.includes('1531201010532618241'));
    assert.ok(harness.sent.slice(1).every(payload => !payload.content.includes(`<@&${harness.fixturesRoleId}>`)), 'global fixtures ping should only be sent once');
    assert.match(replies.at(-1).content, /Posted \*\*30 reserved matches\*\*/);
    assert.equal(harness.serverConfigReads, 1);
});

test('slash /postreserves defers ephemerally, then posts to the configured fixtures channel', async () => {
    const harness = makeHarness({
        fixtures: [{
            matchNumber: 4,
            status: 'Pending',
            homeTeam: 'Falcons',
            awayTeam: 'Wolves',
            scheduledAt: null,
            reserved: { isReserved: true, until: new Date('2026-12-15T15:00:00Z'), note: 'rain' }
        }]
    });
    let deferred = false;
    const replies = [];
    const interaction = {
        guild: harness.guild,
        user: { id: 'organizer-1' },
        deferReply: async options => { deferred = options.ephemeral; },
        editReply: async payload => {
            replies.push(payload);
            return payload;
        }
    };

    await harness.command.slashExecute(interaction);

    assert.equal(deferred, true);
    assert.equal(harness.sent.length, 1);
    assert.ok(harness.sent[0].content.includes('__Match #4__'));
    assert.match(replies.at(-1).content, /Posted \*\*1 reserved match\*\*/);
});

test('test mode posts a local preview without reading config or sending pings', async () => {
    const harness = makeHarness({
        fixtures: [{
            matchNumber: 3,
            status: 'Pending',
            homeTeam: 'Falcons',
            awayTeam: 'Wolves',
            scheduledAt: null,
            reserved: { isReserved: true, until: null, note: 'weather' }
        }]
    });
    const testSent = [];
    const testChannel = {
        id: '888888888888888888',
        guildId: harness.guildId,
        type: 0,
        permissionsFor: () => ({ has: () => true }),
        send: async payload => {
            testSent.push(payload);
            return { id: 'test-message' };
        }
    };
    const replies = [];

    await harness.command.runPostReserves({
        guild: harness.guild,
        testMode: true,
        targetChannel: testChannel,
        reply: async payload => {
            replies.push(payload);
            return payload;
        }
    });

    assert.equal(harness.serverConfigReads, 0);
    assert.equal(harness.roleFetchCalls, 0);
    assert.equal(testSent.length, 1);
    assert.doesNotMatch(testSent[0].content, /<@/);
    assert.deepEqual(testSent[0].allowedMentions.roles, []);
    assert.deepEqual(testSent[0].allowedMentions.users, []);
    assert.match(testSent[0].content, /Falcons VS Wolves/);
    assert.match(testSent[0].content, /weather/);
    assert.match(replies.at(-1).content, /No user or role pings were sent/);
});

test('testpostreserves prefix and slash command definitions use the no-ping preview', async () => {
    const calls = [];
    const fakeRun = async options => {
        calls.push(options);
        return 'done';
    };
    const command = requireWithMocks('../commands/tournament/testpostreserves', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1n }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        './postreserves': { runPostReserves: fakeRun }
    });
    const channel = { id: 'channel-1' };
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'user-1' },
        channel,
        reply: async payload => payload
    };

    await command.execute(message);

    assert.equal(command.name, 'testpostreserves');
    assert.ok(command.data, 'slash-command metadata should be defined');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].testMode, true);
    assert.equal(calls[0].targetChannel, channel);

    let deferred = false;
    const interaction = {
        guild: message.guild,
        user: message.author,
        channel,
        deferReply: async () => { deferred = true; },
        editReply: async payload => payload
    };
    await command.slashExecute(interaction);

    assert.equal(deferred, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].testMode, true);
    assert.equal(calls[1].targetChannel, channel);
});
