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

function setPath(target, dottedPath, value) {
    const parts = dottedPath.split('.');
    let cursor = target;
    while (parts.length > 1) cursor = cursor[parts.shift()] ||= {};
    cursor[parts[0]] = value;
}

function unsetPath(target, dottedPath) {
    const parts = dottedPath.split('.');
    let cursor = target;
    while (parts.length > 1) cursor = cursor?.[parts.shift()];
    if (cursor) delete cursor[parts[0]];
}

function makeScheduler({ fixture, fixtureFind, roleMentionable = true, canMentionAllRoles = false }) {
    const events = [];
    const messages = [];
    const stages = [];
    let stored = structuredClone(fixture);

    const channel = {
        id: 'stadium-1',
        permissionsFor: () => ({ has: permission => permission === 'MentionEveryone' && canMentionAllRoles }),
        send: async payload => {
            events.push('send');
            messages.push(payload);
            return { id: `message-${messages.length}` };
        },
        permissionOverwrites: {
            cache: new Map(),
            edit: async (target, permissions) => {
                const isEveryone = target.id === 'everyone';
                const unlock = permissions.SendMessages === null;
                events.push(isEveryone ? (unlock ? 'unlock' : 'lock') : 'bot-overwrite');
            },
            delete: async () => events.push('bot-overwrite-remove')
        }
    };

    const teamRoles = [
        { id: 'home-role', name: fixture.homeTeam, mentionable: roleMentionable },
        { id: 'away-role', name: fixture.awayTeam, mentionable: roleMentionable }
    ];
    const guild = {
        id: 'guild-1',
        name: 'Test League',
        roles: {
            everyone: { id: 'everyone' },
            cache: {
                find: predicate => teamRoles.find(predicate),
                get: id => teamRoles.find(role => role.id === id)
            }
        },
        channels: { fetch: async () => channel },
        members: { me: { id: 'bot-user' } }
    };

    function cloneStored() {
        return structuredClone(stored);
    }

    function applyUpdate(update) {
        for (const [key, value] of Object.entries(update.$set || {})) {
            if (key === 'channelPlan') stored.channelPlan = structuredClone(value);
            else setPath(stored, key, value);
        }
        for (const key of Object.keys(update.$unset || {})) unsetPath(stored, key);
    }

    const Fixture = {
        updateOne: async (filter, update) => {
            events.push('db-update');
            applyUpdate(update);
            return { matchedCount: 1, modifiedCount: 1 };
        },
        findOneAndUpdate: async (filter, update) => {
            events.push('db-claim');
            if (!stored || String(filter._id) !== String(stored._id)) return null;
            applyUpdate(update);
            return cloneStored();
        },
        find: filter => {
            const rows = typeof fixtureFind === 'function' ? fixtureFind(filter, cloneStored()) : [];
            return {
                limit() { return this; },
                sort() { return this; },
                select() { return this; },
                lean: async () => rows
            };
        }
    };

    const fakeDiscord = {
        PermissionFlagsBits: { MentionEveryone: 'MentionEveryone' },
        PermissionsBitField: { Flags: { SendMessages: 1n, AddReactions: 2n } },
        EmbedBuilder: class {
            setColor() { return this; }
            setTitle() { return this; }
            setDescription() { return this; }
            setTimestamp() { return this; }
        }
    };

    const scheduler = requireWithMocks('../utils/matchScheduler', {
        'discord.js': fakeDiscord,
        '../models/Tournament': {
            Fixture,
            Team: {},
            TournamentSettings: {
                findById: () => ({ lean: async () => ({ name: 'Test League', tournamentKey: 'default' }) })
            },
            TournamentPlayer: {},
            Player: {}
        },
        './ai/announcements': {
            buildMatchAnnouncement: async ({ announcementType }) => {
                stages.push(announcementType);
                return `A little ${announcementType} roast for both teams.`;
            }
        },
        './istTime': {
            formatIst: () => '10 Oct, 9:00 PM IST',
            discordFull: () => '<t:1000:F>',
            discordRelative: () => '<t:1000:R>'
        },
        './aiGuard': { sanitizeAIText: text => ({ text }) },
        './ai/emojiSlots': {
            slotEmoji: () => '🗓️',
            vsLine: (home, away) => `${home} vs ${away}`
        }
    });

    return { scheduler, Fixture, guild, events, messages, stages, getStored: cloneStored };
}

function makeFixture(scheduledAt, channelPlan = {}) {
    return {
        _id: 'fixture-12',
        guildId: 'guild-1',
        tournamentId: 'tournament-1',
        matchNumber: 12,
        homeTeam: 'Falcons',
        awayTeam: 'Tigers',
        venueName: 'Wankhede',
        status: 'Pending',
        scheduledAt,
        reserved: { isReserved: false },
        channelPlan: { channelId: 'stadium-1', state: 'locked', ...channelPlan }
    };
}

test('scheduling locks immediately and sends a role-ping announcement with the IST kickoff time', async () => {
    const kickoff = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const fixture = makeFixture(kickoff);
    fixture.venueName = 'Wankhede <@&999> @everyone';
    const harness = makeScheduler({ fixture });

    const result = await harness.scheduler.scheduleMatch({
        client: { guilds: { cache: new Map() } },
        guild: harness.guild,
        fixture,
        channelId: 'stadium-1',
        pingCaptains: false,
        actorId: 'organizer-1'
    });

    assert.equal(result.ok, true);
    assert.equal(harness.stages[0], 'scheduled');
    assert.ok(harness.events.indexOf('lock') < harness.events.indexOf('send'));
    assert.equal(harness.events.includes('unlock'), false);
    assert.match(harness.messages[0].content, /MATCH SCHEDULED/);
    assert.match(harness.messages[0].content, /<@&home-role>/);
    assert.match(harness.messages[0].content, /<@&away-role>/);
    assert.match(harness.messages[0].content, /10 Oct, 9:00 PM IST/);
    assert.deepEqual(harness.messages[0].allowedMentions, {
        parse: ['roles'],
        users: []
    });
    assert.deepEqual([...harness.messages[0].content.matchAll(/<@&([^>]+)>/g)].map(([, id]) => id), ['home-role', 'away-role']);
    assert.doesNotMatch(harness.messages[0].content, /@everyone|@here|<@&999>/);
    assert.equal(harness.getStored().channelPlan.state, 'locked');
    assert.equal(harness.getStored().channelPlan.scheduledAnnouncementMessageId, 'message-1');
    assert.equal(result.unlockAt.getTime(), kickoff.getTime() - 60_000);
});


test('schedule refuses to lock when neither team role is mentionable and the bot cannot mention roles', async () => {
    const fixture = makeFixture(new Date(Date.now() + 2 * 60 * 60 * 1000));
    const harness = makeScheduler({ fixture, roleMentionable: false, canMentionAllRoles: false });

    const result = await harness.scheduler.scheduleMatch({
        client: { guilds: { cache: new Map() } },
        guild: harness.guild,
        fixture,
        channelId: 'stadium-1',
        pingCaptains: false,
        actorId: 'organizer-1'
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Discord will show but not notify/);
    assert.equal(harness.events.includes('lock'), false);
    assert.equal(harness.events.includes('db-update'), false);
    assert.equal(harness.messages.length, 0);
});


test('schedule may ping non-mentionable team roles when the bot has Mention Everyone in the channel', async () => {
    const fixture = makeFixture(new Date(Date.now() + 2 * 60 * 60 * 1000));
    const harness = makeScheduler({ fixture, roleMentionable: false, canMentionAllRoles: true });

    const result = await harness.scheduler.scheduleMatch({
        client: { guilds: { cache: new Map() } },
        guild: harness.guild,
        fixture,
        channelId: 'stadium-1',
        pingCaptains: false,
        actorId: 'organizer-1'
    });

    assert.equal(result.ok, true);
    assert.equal(harness.messages.length, 1);
    assert.deepEqual(harness.messages[0].allowedMentions.parse, ['roles']);
});

test('one minute before kickoff, the scheduler unlocks first and sends the final team-role ping', async () => {
    const now = new Date();
    const fixture = makeFixture(new Date(now.getTime() + 10 * 60_000), {
        scheduledAnnouncementMessageId: 'schedule-message',
        announceAt: new Date(now.getTime() - 1_000),
        unlockClaimedAt: null,
        unlockedAt: null,
        unlockAnnouncedAt: null,
        unlockMessageId: null
    });
    const harness = makeScheduler({
        fixture,
        fixtureFind: filter => filter['channelPlan.unlockAnnouncedAt'] === null ? [fixture] : []
    });

    await harness.scheduler.tick({ guilds: { cache: new Map([[harness.guild.id, harness.guild]]) } });

    assert.deepEqual(harness.stages, ['unlock']);
    assert.ok(harness.events.indexOf('unlock') >= 0);
    assert.ok(harness.events.indexOf('unlock') < harness.events.indexOf('send'));
    assert.equal(harness.messages.length, 1);
    assert.match(harness.messages[0].content, /KICKOFF IN ONE MINUTE/);
    assert.deepEqual(harness.messages[0].allowedMentions.parse, ['roles']);
    assert.ok(harness.getStored().channelPlan.unlockedAt);
    assert.ok(harness.getStored().channelPlan.unlockAnnouncedAt);
    assert.equal(harness.getStored().channelPlan.state, 'done');
    assert.equal(harness.getStored().channelPlan.unlockMessageId, 'message-1');
});

test('a delayed scheduler still unlocks and announces when kickoff has already arrived', async () => {
    const now = new Date();
    const fixture = makeFixture(new Date(now.getTime() - 1_000), {
        scheduledAnnouncementMessageId: 'schedule-message',
        announceAt: new Date(now.getTime() - 61_000),
        unlockClaimedAt: null,
        unlockedAt: null,
        unlockAnnouncedAt: null
    });
    const harness = makeScheduler({
        fixture,
        fixtureFind: filter => filter['channelPlan.unlockAnnouncedAt'] === null ? [fixture] : []
    });

    await harness.scheduler.tick({ guilds: { cache: new Map([[harness.guild.id, harness.guild]]) } });

    assert.deepEqual(harness.stages, ['kickoff']);
    assert.ok(harness.events.indexOf('unlock') < harness.events.indexOf('send'));
    assert.match(harness.messages[0].content, /KICKOFF TIME/);
    assert.equal(harness.getStored().channelPlan.state, 'done');
});
