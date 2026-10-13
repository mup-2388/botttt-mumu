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
    setName(value) { this.name = value; return this; }
    setDescription(value) { this.description = value; return this; }
    setRequired(value) { this.required = value; return this; }
    addChoices(...choices) { this.choices = choices.flat(); return this; }
}

class FakeSlashCommandBuilder {
    constructor() { this.options = []; }
    setName(value) { this.name = value; return this; }
    setDescription(value) { this.description = value; return this; }
    addStringOption(configure) {
        const option = new FakeOption();
        configure(option);
        this.options.push(option);
        return this;
    }
}

class FakeActionRowBuilder {
    constructor() { this.components = []; }
    addComponents(...components) { this.components.push(...components); return this; }
}

class FakeStringSelectMenuBuilder {
    constructor() { this.options = []; }
    setCustomId(value) { this.customId = value; return this; }
    setPlaceholder(value) { this.placeholder = value; return this; }
    addOptions(...options) { this.options.push(...options.flat()); return this; }
}

class FakeButtonBuilder {
    setCustomId(value) { this.customId = value; return this; }
    setLabel(value) { this.label = value; return this; }
    setStyle(value) { this.style = value; return this; }
    setDisabled(value) { this.disabled = value; return this; }
}

class FakeEmbedBuilder {
    constructor() { this.fields = []; }
    setColor(value) { this.color = value; return this; }
    setTitle(value) { this.title = value; return this; }
    setDescription(value) { this.description = value; return this; }
    addFields(...fields) { this.fields.push(...fields.flat()); return this; }
    setFooter(value) { this.footer = value; return this; }
    setTimestamp() { return this; }
}

function makeQuery(rows, calls) {
    return {
        populate(field) {
            calls.populated.push(field);
            return this;
        },
        sort(sort) {
            calls.sorts.push(sort);
            return this;
        },
        lean: async () => rows
    };
}

function loadTopStats({ tournamentRows = [], eventRows = [] } = {}) {
    const calls = {
        tournamentFilters: [],
        eventFilters: [],
        tournamentPopulated: [],
        eventPopulated: [],
        tournamentSorts: [],
        eventSorts: []
    };
    const tournamentCalls = { populated: calls.tournamentPopulated, sorts: calls.tournamentSorts };
    const eventCalls = { populated: calls.eventPopulated, sorts: calls.eventSorts };

    const command = requireWithMocks('../commands/tournament/topstats', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1n },
            EmbedBuilder: FakeEmbedBuilder,
            ActionRowBuilder: FakeActionRowBuilder,
            StringSelectMenuBuilder: FakeStringSelectMenuBuilder,
            ButtonBuilder: FakeButtonBuilder,
            ButtonStyle: { Secondary: 2, Primary: 1 },
            ComponentType: { StringSelect: 3 }
        },
        '../../models/Tournament': {
            TournamentPlayer: {
                find: filter => {
                    calls.tournamentFilters.push(filter);
                    return makeQuery(tournamentRows, tournamentCalls);
                }
            },
            EventPlayer: {
                find: filter => {
                    calls.eventFilters.push(filter);
                    return makeQuery(eventRows, eventCalls);
                }
            }
        },
        '../../utils/getTournament': {
            getDefaultTournament: async () => null,
            getSelectableTournaments: async () => [],
            getTournamentByKey: async () => null
        },
        '../../utils/getEvent': {
            getSelectableEvents: async () => [],
            getEventByKey: async () => null,
            getEventByChannel: async () => null
        }
    });

    return { command, calls };
}

const competitions = [
    { label: 'Summer Cup', description: 'Tournament', value: 'tournament:summer', type: 'tournament' }
];

test('topstats offers G+A and ranks tournament players by goals plus assists', async () => {
    const rows = [
        {
            playerNameSnapshot: 'Goal Scorer',
            playerId: { name: 'Goal Scorer', discordID: 'player-goal' },
            stats: { goals: 3, assists: 0, played: 8 }
        },
        {
            playerNameSnapshot: 'Assist Leader',
            playerId: { name: 'Assist Leader', discordID: 'player-assist' },
            stats: { goals: 0, assists: 4, played: 10 }
        },
        {
            playerNameSnapshot: 'Two-Way Player',
            playerId: { name: 'Two-Way Player', discordID: 'player-two-way' },
            stats: { goals: 2, assists: 1, played: 3 }
        }
    ];
    const { command, calls } = loadTopStats({ tournamentRows: rows });

    const slashChoices = command.data.options[0].choices;
    assert.ok(slashChoices.some(choice => choice.value === 'ga' && choice.name === 'G+A'));
    assert.equal(command.normalizeCategory('G+A'), 'ga');

    const competition = {
        type: 'tournament',
        key: 'summer',
        name: 'Summer Cup',
        value: 'tournament:summer',
        doc: { _id: 'tournament-id', emoji: '🏆' }
    };
    const payload = await command.buildTopStatsPayload({
        guildId: 'guild-1',
        competition,
        competitions,
        category: 'ga',
        page: 0
    });

    assert.deepEqual(calls.tournamentFilters[0], {
        guildId: 'guild-1',
        tournamentId: 'tournament-id',
        isActive: true,
        $or: [
            { 'stats.goals': { $gt: 0 } },
            { 'stats.assists': { $gt: 0 } }
        ]
    });
    assert.deepEqual(calls.tournamentPopulated, ['playerId', 'teamId']);
    assert.deepEqual(calls.tournamentSorts, [], 'G+A is sorted by the combined stat in memory');

    const embed = payload.embeds[0];
    assert.match(embed.title, /G\+A LEADERBOARD/);
    const assistRank = embed.description.indexOf('Assist Leader');
    const twoWayRank = embed.description.indexOf('Two-Way Player');
    const goalRank = embed.description.indexOf('Goal Scorer');
    assert.ok(assistRank >= 0 && twoWayRank >= 0 && goalRank >= 0);
    assert.ok(assistRank < twoWayRank, 'the player with four contributions ranks first');
    assert.ok(twoWayRank < goalRank, 'equal G+A is broken by fewer matches played');
    assert.match(embed.description, /Assist Leader\s+\| 04/);
    assert.match(embed.description, /Two-Way Player\s+\| 03/);
    assert.match(embed.description, /Goal Scorer\s+\| 03/);

    const categoryMenu = payload.components[1].components[0];
    assert.ok(categoryMenu.options.some(option => option.value === 'ga' && option.default));
});

test('G+A also uses the event leaderboard selection and includes assist-only players', async () => {
    const { command, calls } = loadTopStats({
        eventRows: [{
            playerNameSnapshot: 'Event Playmaker',
            playerId: { name: 'Event Playmaker' },
            stats: { goals: 0, assists: 2, played: 1 }
        }]
    });
    const competition = {
        type: 'event',
        key: 'freestyle',
        name: 'Freestyle Event',
        value: 'event:freestyle',
        doc: { _id: 'event-id', emoji: '✨', isActive: true, channelId: 'channel-1' }
    };

    const payload = await command.buildTopStatsPayload({
        guildId: 'guild-1',
        competition,
        competitions: [{ label: 'Freestyle Event', description: 'Event', value: 'event:freestyle' }],
        category: 'ga',
        page: 0
    });

    assert.equal(calls.eventFilters[0].eventId, 'event-id');
    assert.deepEqual(calls.eventFilters[0].$or, [
        { 'stats.goals': { $gt: 0 } },
        { 'stats.assists': { $gt: 0 } }
    ]);
    assert.deepEqual(calls.eventPopulated, ['playerId']);
    assert.match(payload.embeds[0].description, /Event Playmaker\s+\| 02/);
    assert.match(payload.embeds[0].title, /G\+A LEADERBOARD — EVENT/);
});
