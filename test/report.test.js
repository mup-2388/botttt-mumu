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

class Builder {
    constructor() { this.data = {}; }
    setName(value) { this.data.name = value; return this; }
    setDescription(value) { this.data.description = value; return this; }
    setColor(value) { this.data.color = value; return this; }
    setTitle(value) { this.data.title = value; return this; }
    setFooter(value) { this.data.footer = value; return this; }
    setTimestamp() { return this; }
    setCustomId(value) { this.data.customId = value; return this; }
    setPlaceholder(value) { this.data.placeholder = value; return this; }
    setLabel(value) { this.data.label = value; return this; }
    setStyle(value) { this.data.style = value; return this; }
    setEmoji(value) { this.data.emoji = value; return this; }
    addOptions(options) { this.data.options = options; return this; }
    addComponents(...components) { this.data.components = components; return this; }
}

function makeFixture(matchNumber, { scheduledAt = null, status = 'Pending', reserved = false } = {}) {
    return {
        _id: `fixture-${matchNumber}`,
        guildId: 'guild-1',
        tournamentId: 'tournament-1',
        matchNumber,
        homeTeam: `Home ${matchNumber}`,
        awayTeam: `Away ${matchNumber}`,
        status,
        scheduledAt,
        reserved: reserved ? { isReserved: true } : undefined,
        phase: 'league'
    };
}

function makeHarness(fixtures) {
    const queryCalls = [];
    const tournament = {
        _id: 'tournament-1',
        guildId: 'guild-1',
        tournamentKey: 'default',
        name: 'Default League',
        emoji: '🏆'
    };
    const Fixture = {
        find(query) {
            queryCalls.push({ query });
            let rows = [...fixtures];
            const reservedFilter = query['reserved.isReserved'];
            if (reservedFilter === true) rows = rows.filter(fixture => fixture.reserved?.isReserved === true);
            else if (reservedFilter?.$ne === true) rows = rows.filter(fixture => fixture.reserved?.isReserved !== true);
            let offset = 0;
            const chain = {
                sort(sortSpec) {
                    queryCalls[queryCalls.length - 1].sort = sortSpec;
                    rows.sort((a, b) => a.matchNumber - b.matchNumber);
                    return chain;
                },
                skip(amount) {
                    queryCalls[queryCalls.length - 1].skip = amount;
                    offset = amount;
                    return chain;
                },
                limit(maximum) {
                    queryCalls[queryCalls.length - 1].limit = maximum;
                    rows = rows.slice(offset, offset + maximum);
                    return chain;
                },
                lean: async () => rows
            };
            return chain;
        },

        distinct: async () => []
    };

    const command = requireWithMocks('../commands/tournament/report', {
        'discord.js': {
            SlashCommandBuilder: Builder,
            PermissionFlagsBits: { SendMessages: 1 },
            EmbedBuilder: Builder,
            ActionRowBuilder: Builder,
            ButtonBuilder: Builder,
            ButtonStyle: { Secondary: 2 },
            StringSelectMenuBuilder: Builder,
            ModalBuilder: Builder,
            TextInputBuilder: Builder,
            TextInputStyle: { Short: 1 }
        },
        '../../models/Tournament': { Fixture, TournamentTeam: {} },
        '../../utils/getTournament': {
            getDefaultTournament: async () => tournament,
            getSelectableTournaments: async () => [tournament],
            getTournamentByKey: async () => tournament
        },
        '../../utils/updateStandings': { updateAllLiveStandings: async () => {} },
        '../../utils/updateTopStats': { updateLiveTopStats: async () => {} },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/displayHelpers': { prettyPhase: () => 'League' },
        './master-schedule': { refreshLiveMasterSchedules: async () => {} },
        './sendbracket': { refreshLiveBracket: async () => {} },
        '../../utils/ai/emojiSlots': {
            slotEmoji: () => '⚽',
            vsLine: (home, away) => `${home} vs ${away}`
        },
        '../../utils/reservedMatches': {
            markReserved: async () => ({ ok: true }),
            reservedBadge: () => 'Reserved',
            isReserved: fixture => !!fixture?.reserved?.isReserved
        },
        '../../utils/istTime': {
            parseScheduleTime: () => ({ ok: true, date: new Date() }),
            discordFull: () => 'kickoff',
            discordRelative: () => 'soon'
        }
    });

    return { command, queryCalls };
}

test('report menu keeps scheduled matches selectable in numerical order', async () => {
    const fixtures = Array.from({ length: 30 }, (_, index) => {
        const matchNumber = index + 1;
        return matchNumber === 7
            ? makeFixture(matchNumber, { scheduledAt: new Date('2026-10-10T15:30:00.000Z') })
            : makeFixture(matchNumber);
    });
    const harness = makeHarness(fixtures);
    let response;
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1' },
        client: {},
        reply: async payload => {
            response = payload;
            return {};
        }
    };

    await harness.command.execute(message, []);

    assert.match(response.embeds[0].data.description, /#7 — \*\*Home 7 vs Away 7\*\*/);
    const fixtureSelector = response.components.flatMap(row => row.data.components || [])
        .find(component => component.data.customId === 'report_fixture');
    assert.deepEqual(
        fixtureSelector.data.options.map(option => option.value),
        Array.from({ length: 25 }, (_, index) => `fixture-${index + 1}`)
    );
    assert.deepEqual(harness.queryCalls[0].query.$or[1], {
        scheduledAt: { $ne: null },
        status: { $nin: ['Played', 'Cancelled'] }
    });
    assert.deepEqual(harness.queryCalls[0].sort, { matchNumber: 1 });
    assert.equal(harness.queryCalls[0].limit, 25);
});

test('main report screen hides reserved fixtures and provides a separate reserved-report button', async () => {
    const fixtures = [
        ...Array.from({ length: 30 }, (_, index) => makeFixture(index + 1, { reserved: true })),
        makeFixture(31)
    ];
    const harness = makeHarness(fixtures);
    let response;
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1' },
        client: {},
        reply: async payload => {
            response = payload;
            return {};
        }
    };

    await harness.command.execute(message, []);

    assert.match(response.embeds[0].data.title, /REPORT MATCH/);
    assert.match(response.embeds[0].data.description, /#31 — \*\*Home 31 vs Away 31\*\*/);
    assert.doesNotMatch(response.embeds[0].data.description, /#1 — \*\*Home 1 vs Away 1\*\*/);
    const components = response.components.flatMap(row => row.data.components || []);
    const fixtureSelector = components.find(component => component.data.customId === 'report_fixture');
    assert.deepEqual(fixtureSelector.data.options.map(option => option.value), ['fixture-31']);
    assert.ok(components.some(component => component.data.customId === 'report_reserved_view'));
    assert.deepEqual(harness.queryCalls[0].query['reserved.isReserved'], { $ne: true });
});

test('reserved report button opens a paged reserved-only selector and can return to normal pending fixtures', async () => {
    const fixtures = [
        ...Array.from({ length: 30 }, (_, index) => makeFixture(index + 1, { reserved: true })),
        makeFixture(31)
    ];
    const harness = makeHarness(fixtures);
    const handlers = {};
    let response;
    const msg = {
        createMessageComponentCollector: () => ({
            on(event, handler) {
                handlers[event] = handler;
                return this;
            }
        }),
        edit: async payload => {
            response = payload;
            return msg;
        }
    };
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1' },
        client: {},
        reply: async payload => {
            response = payload;
            return msg;
        }
    };

    await harness.command.execute(message, []);

    async function click(customId) {
        return handlers.collect({
            user: { id: 'organizer-1' },
            customId,
            isButton: () => true,
            isStringSelectMenu: () => false,
            update: async payload => { response = payload; },
            reply: async () => {}
        });
    }

    await click('report_reserved_view');
    assert.match(response.embeds[0].data.title, /REPORT RESERVED MATCH/);
    assert.match(response.embeds[0].data.description, /Reserved fixtures · page 1/);
    let components = response.components.flatMap(row => row.data.components || []);
    let fixtureSelector = components.find(component => component.data.customId === 'report_fixture');
    assert.deepEqual(
        fixtureSelector.data.options.map(option => option.value),
        Array.from({ length: 25 }, (_, index) => `fixture-${index + 1}`)
    );
    assert.ok(components.some(component => component.data.customId === 'report_reserved_next'));
    assert.deepEqual(harness.queryCalls[1].query['reserved.isReserved'], true);

    await click('report_reserved_next');
    assert.match(response.embeds[0].data.description, /Reserved fixtures · page 2/);
    components = response.components.flatMap(row => row.data.components || []);
    fixtureSelector = components.find(component => component.data.customId === 'report_fixture');
    assert.deepEqual(
        fixtureSelector.data.options.map(option => option.value),
        Array.from({ length: 5 }, (_, index) => `fixture-${index + 26}`)
    );
    assert.ok(components.some(component => component.data.customId === 'report_reserved_prev'));
    assert.ok(!components.some(component => component.data.customId === 'report_reserved_next'));

    await click('report_pending_view');
    assert.match(response.embeds[0].data.title, /REPORT MATCH/);
    components = response.components.flatMap(row => row.data.components || []);
    fixtureSelector = components.find(component => component.data.customId === 'report_fixture');
    assert.deepEqual(fixtureSelector.data.options.map(option => option.value), ['fixture-31']);
});
