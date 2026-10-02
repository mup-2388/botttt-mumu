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

function makeFixture(matchNumber, { scheduledAt = null, status = 'Pending' } = {}) {
    return {
        _id: `fixture-${matchNumber}`,
        guildId: 'guild-1',
        tournamentId: 'tournament-1',
        matchNumber,
        homeTeam: `Home ${matchNumber}`,
        awayTeam: `Away ${matchNumber}`,
        status,
        scheduledAt,
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
            const chain = {
                sort(sortSpec) {
                    queryCalls[queryCalls.length - 1].sort = sortSpec;
                    rows.sort((a, b) => a.matchNumber - b.matchNumber);
                    return chain;
                },
                limit(maximum) {
                    queryCalls[queryCalls.length - 1].limit = maximum;
                    rows = rows.slice(0, maximum);
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
            reservedBadge: () => '',
            isReserved: () => false
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
