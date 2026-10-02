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

class OptionBuilder {
    constructor(type) {
        this.data = { type };
    }
    setName(name) { this.data.name = name; return this; }
    setDescription(description) { this.data.description = description; return this; }
    setRequired(required) { this.data.required = required; return this; }
    setAutocomplete(autocomplete) { this.data.autocomplete = autocomplete; return this; }
    addChannelTypes(...channelTypes) { this.data.channel_types = channelTypes; return this; }
}

class SubcommandBuilder {
    constructor() {
        this.data = { type: 1, options: [] };
    }
    setName(name) { this.data.name = name; return this; }
    setDescription(description) { this.data.description = description; return this; }
    addStringOption(callback) { return this.addOption(callback, 3); }
    addIntegerOption(callback) { return this.addOption(callback, 4); }
    addChannelOption(callback) { return this.addOption(callback, 7); }
    addBooleanOption(callback) { return this.addOption(callback, 5); }
    addOption(callback, type) {
        const option = new OptionBuilder(type);
        callback(option);
        this.data.options.push(option.data);
        return this;
    }
}

class SlashCommandBuilder {
    constructor() {
        this.data = { options: [] };
    }
    setName(name) { this.data.name = name; return this; }
    setDescription(description) { this.data.description = description; return this; }
    addSubcommand(callback) {
        const subcommand = new SubcommandBuilder();
        callback(subcommand);
        this.data.options.push(subcommand.data);
        return this;
    }
    toJSON() { return this.data; }
}

class EmbedBuilder {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    addFields() { return this; }
    setFooter() { return this; }
    setTimestamp() { return this; }
}

function loadScheduleCommand(fixtures) {
    const queries = [];
    const tournamentLookups = [];
    const command = requireWithMocks('../commands/tournament/schedule', {
        'discord.js': {
            SlashCommandBuilder,
            PermissionFlagsBits: { ManageChannels: 1n },
            ChannelType: { GuildText: 0, GuildAnnouncement: 5 },
            EmbedBuilder
        },
        '../../models/Tournament': {
            Fixture: {
                find: filter => {
                    queries.push(filter);
                    return {
                        sort() { return this; },
                        lean: async () => fixtures
                    };
                },
                findOne: async () => null
            },
            TournamentSettings: { find: async () => [] }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/getTournament': {
            resolveTournament: async (guildId, key) => {
                tournamentLookups.push({ guildId, key });
                return {
                    tournament: { _id: 'default-tournament-id', name: 'Default League', tournamentKey: 'default' }
                };
            },
            extractTournamentFromArgs: async () => ({ explicit: false, rest: [] })
        },
        '../../utils/istTime': {
            parseScheduleTime: () => new Date(),
            formatIst: () => '10 Oct, 9:00 PM IST',
            discordFull: () => '<t:1000:F>',
            discordRelative: () => '<t:1000:R>'
        },
        '../../utils/ai/emojiSlots': {
            slotEmoji: () => '🗓️',
            vsLine: (home, away) => `${home} vs ${away}`
        },
        '../../utils/matchScheduler': {
            scheduleMatch: async () => ({ ok: true }),
            cancelPlan: async () => ({ ok: true, cancelled: true, unlocked: true }),
            listPlans: async () => []
        }
    });

    return { command, queries, tournamentLookups };
}

function fixture(number, homeTeam = `Home ${number}`, awayTeam = `Away ${number}`) {
    return {
        _id: `fixture-${number}`,
        matchNumber: number,
        homeTeam,
        awayTeam,
        status: 'Pending',
        scheduledAt: new Date('2026-10-10T15:30:00.000Z'),
        channelPlan: { channelId: null }
    };
}

function autocompleteInteraction(focused) {
    const response = { choices: null };
    return {
        response,
        interaction: {
            guild: { id: 'guild-1' },
            user: { id: 'organizer-1' },
            options: {
                getSubcommand: () => 'set',
                getString: () => null,
                getFocused: () => focused
            },
            respond: async choices => {
                response.choices = choices;
            }
        }
    };
}

test('slash match options use autocomplete and return at most Discord’s 25 fixture choices', async () => {
    const fixtures = Array.from({ length: 30 }, (_, index) => fixture(index + 1));
    const harness = loadScheduleCommand(fixtures);
    const { interaction, response } = autocompleteInteraction('');

    const setSubcommand = harness.command.data.toJSON().options.find(option => option.name === 'set');
    const matchOption = setSubcommand.options.find(option => option.name === 'match');
    assert.equal(matchOption.type, 3);
    assert.equal(matchOption.required, true);
    assert.equal(matchOption.autocomplete, true);

    await harness.command.autocomplete(interaction);

    assert.equal(response.choices.length, 25);
    assert.match(response.choices[0].name, /^#1 · Home 1 vs Away 1/);
    assert.equal(response.choices[0].value, 'fixture-1');
    assert.deepEqual(harness.queries[0], {
        guildId: 'guild-1',
        tournamentId: 'default-tournament-id'
    });
    assert.deepEqual(harness.tournamentLookups, [{ guildId: 'guild-1', key: null }]);
});

test('autocomplete searches fixture numbers and team names', async () => {
    const fixtures = [
        fixture(4, 'Falcons', 'Tigers'),
        fixture(14, 'Rovers', 'United'),
        fixture(24, 'City', 'Falcons')
    ];
    const harness = loadScheduleCommand(fixtures);
    const { interaction, response } = autocompleteInteraction('falcons');

    await harness.command.autocomplete(interaction);
    assert.deepEqual(response.choices.map(choice => choice.value), ['fixture-4', 'fixture-24']);

    const numberHarness = loadScheduleCommand(fixtures);
    const numberInteraction = autocompleteInteraction('#14');
    await numberHarness.command.autocomplete(numberInteraction.interaction);
    assert.deepEqual(numberInteraction.response.choices.map(choice => choice.value), ['fixture-14']);
});
