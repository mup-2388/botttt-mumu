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
    constructor() { this.choices = []; }
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    setRequired(required) { this.required = required; return this; }
    setMinValue(value) { this.minValue = value; return this; }
    addChoices(...choices) { this.choices.push(...choices); return this; }
}

class FakeSlashCommandBuilder {
    constructor() { this.options = []; }
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    addStringOption(configure) { return this.addOption(configure); }
    addIntegerOption(configure) { return this.addOption(configure); }
    addBooleanOption(configure) { return this.addOption(configure); }
    addRoleOption(configure) { return this.addOption(configure); }
    addOption(configure) {
        const option = new FakeOption();
        configure(option);
        this.options.push(option);
        return this;
    }
}

class FakeEmbedBuilder {
    setColor(color) { this.color = color; return this; }
    setTitle(title) { this.title = title; return this; }
    setDescription(description) { this.description = description; return this; }
    setTimestamp() { return this; }
}

const fakeDiscord = {
    SlashCommandBuilder: FakeSlashCommandBuilder,
    EmbedBuilder: FakeEmbedBuilder,
    AttachmentBuilder: class {
        constructor(buffer, options) { this.buffer = buffer; this.name = options.name; }
    },
    ActionRowBuilder: class {
        addComponents(...components) { this.components = components; return this; }
    },
    StringSelectMenuBuilder: class {
        setCustomId(id) { this.customId = id; return this; }
        setPlaceholder(text) { this.placeholder = text; return this; }
        addOptions(options) { this.options = options; return this; }
    },
    ButtonBuilder: class {
        setCustomId(id) { this.customId = id; return this; }
        setLabel(label) { this.label = label; return this; }
        setStyle(style) { this.style = style; return this; }
    },
    ButtonStyle: { Success: 1, Secondary: 2, Primary: 3 },
    PermissionFlagsBits: { SendMessages: 1 }
};

function loadFixtureBuilder() {
    return requireWithMocks('../utils/fixtureBuilder', {
        '../models/Tournament': { Fixture: { findOne: () => ({ sort() { return this; }, select: async () => null }) } },
        './displayHelpers': {
            prettyPhase: phase => ({
                roundof16: 'Round of 16',
                quarterfinal: 'Quarter Final',
                semifinal: 'Semi Final',
                final: 'Final'
            }[phase] || phase)
        }
    });
}

function makeTeams(count) {
    return Array.from({ length: count }, (_, index) => ({
        _id: `entry-${index + 1}`,
        teamId: { _id: `team-${index + 1}`, name: `Team ${String(index + 1).padStart(2, '0')}` },
        teamNameSnapshot: `Team ${String(index + 1).padStart(2, '0')}`,
        isActive: true,
        stats: { played: 0, points: 0, gf: 0, ga: 0 }
    }));
}

test('straight knockout phases cover a seeded 16-team path starting at the Round of 16', () => {
    const { getKnockoutRounds, buildStandardKnockoutPairs } = loadFixtureBuilder();
    const teams = makeTeams(16).map(entry => ({
        tournamentTeamId: entry._id,
        teamId: entry.teamId._id,
        name: entry.teamId.name
    }));

    assert.deepEqual(getKnockoutRounds(16), ['roundof16', 'quarterfinal', 'semifinal', 'final']);
    assert.deepEqual(buildStandardKnockoutPairs(teams).map(pair => pair.map(team => team.name)), [
        ['Team 01', 'Team 16'],
        ['Team 08', 'Team 09'],
        ['Team 04', 'Team 13'],
        ['Team 05', 'Team 12'],
        ['Team 02', 'Team 15'],
        ['Team 07', 'Team 10'],
        ['Team 03', 'Team 14'],
        ['Team 06', 'Team 11']
    ]);
    assert.deepEqual(getKnockoutRounds(12), []);
    assert.deepEqual(getKnockoutRounds(32), []);
});

test('settournament exposes and saves straight knockout without inheriting a qualifier or group stage', async () => {
    let updateCall;
    let syncedSettings;
    let response;
    const savedSettings = {
        tournamentKey: 'cup-s1',
        name: 'Cup S1',
        formatType: 'knockout',
        schedulingMode: 'auto',
        teamCount: 16,
        groupCount: 0,
        teamsPerGroup: 0,
        homeAway: false,
        hasKnockout: true,
        knockoutRounds: [],
        currentPhase: 'registration',
        registrationOpen: true,
        manualRegistration: false,
        captainRoleId: '',
        tournamentPlayerRoleId: ''
    };

    const command = requireWithMocks('../commands/tournament/settournament', {
        'discord.js': fakeDiscord,
        '../../models/Tournament': {
            TournamentSettings: {
                findOneAndUpdate: async (filter, update, options) => {
                    updateCall = { filter, update, options };
                    return savedSettings;
                }
            }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/tournamentSync': {
            syncAllTeamsToTournament: async (_guildId, settings) => {
                syncedSettings = settings;
                return { syncedTeams: 16, syncedPlayers: 128 };
            }
        }
    });

    const formatOption = command.data.options.find(option => option.name === 'format');
    assert.ok(formatOption.choices.some(choice => choice.value === 'knockout'));

    const stringValues = {
        key: 'cup-s1',
        format: 'knockout',
        mode: 'auto',
        name: 'Cup S1',
        knockoutrounds: null,
        twoleggedrounds: null,
        currentphase: null
    };
    const integerValues = { teams: 16, groups: 4, teamspergroup: 4 };
    const booleanValues = { homeaway: true, hasknockout: false, registrationopen: true, manualregistration: false };

    await command.slashExecute({
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        options: {
            getString: name => stringValues[name] ?? null,
            getInteger: name => integerValues[name] ?? null,
            getBoolean: name => booleanValues[name] ?? null,
            getRole: () => null
        },
        deferReply: async () => {},
        editReply: async payload => { response = payload; }
    });

    assert.deepEqual(updateCall.filter, { guildId: 'guild-1', tournamentKey: 'cup-s1' });
    assert.equal(updateCall.update.$set.formatType, 'knockout');
    assert.equal(updateCall.update.$set.teamCount, 16);
    assert.equal(updateCall.update.$set.groupCount, 0);
    assert.equal(updateCall.update.$set.teamsPerGroup, 0);
    assert.equal(updateCall.update.$set.homeAway, false);
    assert.equal(updateCall.update.$set.hasKnockout, true);
    assert.deepEqual(updateCall.update.$set.knockoutRounds, []);
    assert.deepEqual(updateCall.update.$set.twoLeggedRounds, []);
    assert.equal(syncedSettings, savedSettings);
    assert.match(response.content, /Straight Knockout/);
});

function loadAutofixturesHarness({ teamCount = 16, existingCount = 36, inProgressCount = 0 } = {}) {
    const tournament = {
        _id: 'tournament-1',
        guildId: 'guild-1',
        tournamentKey: 'cup-s1',
        name: 'Cup S1',
        formatType: 'knockout',
        groupCount: 4,
        homeAway: true
    };
    const teams = makeTeams(teamCount);
    const calls = { deleted: null, inserted: null, settings: null, replies: [] };
    const fixtureBuilder = loadFixtureBuilder();

    const command = requireWithMocks('../commands/tournament/autofixtures', {
        'discord.js': fakeDiscord,
        '../../models/Tournament': {
            Fixture: {
                countDocuments: async query => query.status ? inProgressCount : existingCount,
                deleteMany: async query => { calls.deleted = query; },
                insertMany: async fixtures => { calls.inserted = fixtures; }
            },
            TournamentSettings: {
                updateOne: async (filter, update) => { calls.settings = { filter, update }; }
            },
            TournamentTeam: {
                find: () => ({
                    populate() { return this; },
                    sort: async () => teams
                })
            }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/getTournament': {
            resolveTournament: async () => ({ tournament, error: null }),
            extractTournamentFromArgs: async () => ({ explicit: false, error: null })
        },
        '../../utils/fixtureBuilder': fixtureBuilder
    });

    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        options: {
            getString: () => 'cup-s1',
            getBoolean: () => true
        },
        deferReply: async () => {},
        editReply: async payload => { calls.replies.push(payload); }
    };

    return { command, interaction, tournament, teams, calls };
}

test('autofixtures replaces only the old schedule with eight seeded Round-of-16 matches', async () => {
    const harness = loadAutofixturesHarness();
    const originalTeams = structuredClone(harness.teams);
    await harness.command.slashExecute(harness.interaction);

    assert.deepEqual(harness.calls.deleted, { guildId: 'guild-1', tournamentId: 'tournament-1' });
    assert.equal(harness.calls.inserted.length, 8);
    assert.ok(harness.calls.inserted.every(fixture => fixture.phase === 'roundof16'));
    assert.deepEqual(harness.calls.inserted.map(fixture => fixture.matchNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(harness.calls.inserted.slice(0, 2).map(fixture => [fixture.homeTeam, fixture.awayTeam]), [
        ['Team 01', 'Team 16'],
        ['Team 08', 'Team 09']
    ]);
    assert.equal(new Set(harness.calls.inserted.flatMap(fixture => [fixture.homeTournamentTeamId, fixture.awayTournamentTeamId])).size, 16);
    assert.deepEqual(harness.teams, originalTeams);
    assert.equal(harness.calls.settings.update.$set.currentPhase, 'knockout');
    assert.equal(harness.calls.settings.update.$set.groupCount, 0);
    assert.equal(harness.calls.settings.update.$set.homeAway, false);
    assert.deepEqual(harness.calls.settings.update.$set.knockoutRounds, ['roundof16', 'quarterfinal', 'semifinal', 'final']);
    assert.match(harness.calls.replies[0].embeds[0].description, /Straight Knockout — Round of 16/);
    assert.match(harness.calls.replies[0].embeds[0].description, /registered teams and rosters were preserved/i);
});

test('autofixtures rejects unsupported team counts before deleting or changing fixtures', async () => {
    const harness = loadAutofixturesHarness({ teamCount: 12 });
    await harness.command.slashExecute(harness.interaction);

    assert.equal(harness.calls.deleted, null);
    assert.equal(harness.calls.inserted, null);
    assert.match(harness.calls.replies[0].content, /power-of-two field/);
});

test('autofixtures protects a straight-knockout schedule when a match is played or live', async () => {
    const harness = loadAutofixturesHarness({ inProgressCount: 1 });
    await harness.command.slashExecute(harness.interaction);

    assert.equal(harness.calls.deleted, null);
    assert.equal(harness.calls.inserted, null);
    assert.match(harness.calls.replies[0].content, /live or played/);
});

function loadGenerateStageHarness({ teamCount = 16, existingCount = 0, inProgressCount = 0, stage = 'knockout' } = {}) {
    const tournament = {
        _id: 'tournament-1',
        guildId: 'guild-1',
        tournamentKey: 'cup-s1',
        name: 'Cup S1',
        formatType: 'knockout',
        hasKnockout: true,
        teamCount,
        groupCount: 4,
        teamsPerGroup: 4,
        homeAway: true,
        currentPhase: 'registration',
        async save() { this.saved = true; }
    };
    const teams = makeTeams(teamCount);
    const calls = { deleted: null, inserted: null, replies: [] };
    const fixtureBuilder = loadFixtureBuilder();

    const command = requireWithMocks('../commands/tournament/generatestage', {
        'discord.js': fakeDiscord,
        '../../models/Tournament': {
            Fixture: {
                countDocuments: async query => query.status ? inProgressCount : existingCount,
                deleteMany: async query => { calls.deleted = query; },
                insertMany: async fixtures => { calls.inserted = fixtures; }
            },
            TournamentTeam: {
                find: () => ({
                    populate() { return this; },
                    sort: async () => teams
                })
            }
        },
        '../../utils/getTournament': {
            getDefaultTournament: async () => null,
            getTournamentByKey: async () => tournament
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/displayHelpers': {
            prettyPhase: phase => ({ roundof16: 'Round of 16' }[phase] || phase)
        },
        '../../utils/fixtureBuilder': fixtureBuilder,
        '../../utils/standingsHelpers': { sortTeams: entries => entries }
    });

    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        options: {
            getString: name => ({ key: 'cup-s1', stage })[name] ?? null,
            getBoolean: () => false
        },
        deferReply: async () => {},
        editReply: async payload => { calls.replies.push(payload); }
    };

    return { command, interaction, tournament, calls };
}

test('generatestage knockout also creates a Round of 16 for the straight format', async () => {
    const harness = loadGenerateStageHarness();
    await harness.command.slashExecute(harness.interaction);

    assert.equal(harness.calls.inserted.length, 8);
    assert.ok(harness.calls.inserted.every(fixture => fixture.phase === 'roundof16'));
    assert.equal(harness.tournament.currentPhase, 'knockout');
    assert.deepEqual(harness.tournament.knockoutRounds, ['roundof16', 'quarterfinal', 'semifinal', 'final']);
    assert.equal(harness.tournament.groupCount, 0);
    assert.equal(harness.tournament.homeAway, false);
    assert.equal(harness.tournament.saved, true);
});

test('generatestage does not create a league qualifier for a straight-knockout tournament', async () => {
    const harness = loadGenerateStageHarness({ stage: 'league' });
    await harness.command.slashExecute(harness.interaction);

    assert.equal(harness.calls.inserted, null);
    assert.match(harness.calls.replies[0].content, /no league or group stage/i);
});

function makeCanvasContext() {
    const context = {
        measureText: text => ({ width: String(text).length * 8 }),
        createLinearGradient: () => ({ addColorStop() {} })
    };
    return new Proxy(context, {
        get(target, key) {
            if (key in target) return target[key];
            return () => {};
        }
    });
}

function loadBracketRenderer(fixtures) {
    const calls = { query: null, canvasSize: null };
    const context = makeCanvasContext();
    const renderer = requireWithMocks('../utils/generateKnockoutBracketImage', {
        '@napi-rs/canvas': {
            createCanvas: (width, height) => {
                calls.canvasSize = { width, height };
                return { getContext: () => context, toBuffer: () => Buffer.from('png-data') };
            }
        },
        '../models/Tournament': {
            Fixture: {
                find: query => {
                    calls.query = query;
                    return {
                        sort() { return this; },
                        lean: async () => fixtures
                    };
                }
            }
        }
    });
    return { renderer, calls };
}

function makeRoundOf16Fixtures() {
    return Array.from({ length: 8 }, (_, index) => ({
        _id: `fixture-${index + 1}`,
        phase: 'roundof16',
        matchNumber: index + 1,
        roundLabel: `Round of 16 ${index + 1}`,
        homeTeam: `Home ${index + 1}`,
        awayTeam: `Away ${index + 1}`,
        leg: 1,
        status: 'Pending',
        result: { home: null, away: null, winner: '' }
    }));
}

test('bracket layout has eight Round-of-16 ties, blank later rounds, and a centered converging final', () => {
    const { renderer } = loadBracketRenderer(makeRoundOf16Fixtures());
    const rounds = renderer.buildBracketRounds(makeRoundOf16Fixtures());
    const layout = renderer.buildBracketLayout(rounds);

    assert.deepEqual(rounds.map(round => [round.phase, round.matches.length]), [
        ['roundof16', 8],
        ['quarterfinal', 4],
        ['semifinal', 2],
        ['final', 1]
    ]);
    assert.ok(rounds.slice(1).every(round => round.matches.every(match => match === null)));

    const [roundOf16, quarterfinal, semifinal, final] = layout.rounds;
    assert.ok(roundOf16.slots[0].x < quarterfinal.slots[0].x);
    assert.ok(quarterfinal.slots[0].x < semifinal.slots[0].x);
    assert.ok(semifinal.slots[0].x < final.slots[0].x);
    assert.equal(final.slots[0].x + (final.slots[0].cardWidth / 2), layout.width / 2);
    assert.equal(final.slots[0].y, (semifinal.slots[0].y + semifinal.slots[1].y) / 2);
    assert.ok(roundOf16.slots[7].x > quarterfinal.slots[3].x);
});

test('bracket renderer returns a PNG attachment and filters fixtures to knockout rounds', async () => {
    const fixtures = makeRoundOf16Fixtures();
    const { renderer, calls } = loadBracketRenderer(fixtures);
    const result = await renderer.generateKnockoutBracketImage({
        settings: { _id: 'tournament-1', name: 'Cup S1' },
        guildId: 'guild-1'
    });

    assert.deepEqual(calls.query, {
        guildId: 'guild-1',
        tournamentId: 'tournament-1',
        phase: { $in: ['roundof16', 'quarterfinal', 'semifinal', 'final'] }
    });
    assert.equal(result.fileName, 'knockout-bracket.png');
    assert.deepEqual(result.buffer, Buffer.from('png-data'));
    assert.ok(calls.canvasSize.width > calls.canvasSize.height);
});

test('standings keeps the bracket image but does not claim the persistent live-message reference', async () => {
    async function render(tournament) {
        const calls = { bracket: 0, standings: 0, payloads: [] };
        const liveSettings = new Map();
        const standingsMessage = {
            id: 'standings-message',
            channel: { id: 'standings-channel' },
            createMessageComponentCollector: () => ({ on() { return this; } })
        };
        const command = requireWithMocks('../commands/tournament/standings-hf', {
            'discord.js': fakeDiscord,
            '../../models/Tournament': { TournamentTeam: { find: () => ({ populate() { return this; }, lean: async () => [] }) } },
            '../../utils/getTournament': {
                getDefaultTournament: async () => tournament,
                getSelectableTournaments: async () => [tournament],
                getTournamentByKey: async () => tournament
            },
            '../../utils/generateStandingsImage': {
                generateStandingsImage: async () => {
                    calls.standings += 1;
                    return { buffer: Buffer.from('standings'), fileName: 'standings.png' };
                }
            },
            '../../utils/generateKnockoutBracketImage': {
                generateKnockoutBracketImage: async () => {
                    calls.bracket += 1;
                    return { buffer: Buffer.from('bracket'), fileName: 'knockout-bracket.png' };
                }
            },
            '../../utils/standingsHelpers': {
                sortTeams: entries => entries,
                compactName: value => value,
                getQualificationZone: () => 'neutral',
                truncate: value => value
            }
        });

        await command.slashExecute({
            guild: { id: 'guild-1' },
            user: { id: 'user-1' },
            client: { liveSettings },
            options: { getString: () => null },
            reply: async payload => { calls.payloads.push(payload); },
            fetchReply: async () => standingsMessage
        });
        return { ...calls, liveSettings };
    }

    const straight = await render({
        _id: 'straight', tournamentKey: 'cup', name: 'Cup', formatType: 'knockout', currentPhase: 'registration', groupCount: 0
    });
    assert.equal(straight.bracket, 1);
    assert.equal(straight.standings, 0);
    assert.equal(straight.payloads[0].files[0].name, 'knockout-bracket.png');
    assert.equal(straight.liveSettings.size, 0);

    const beforeKnockout = await render({
        _id: 'groups', tournamentKey: 'groups-cup', name: 'Groups Cup', formatType: 'groups_knockout', currentPhase: 'groups', groupCount: 2
    });
    assert.equal(beforeKnockout.bracket, 0);
    assert.equal(beforeKnockout.standings, 1);
    assert.equal(beforeKnockout.payloads[0].files[0].name, 'standings.png');
    assert.equal(beforeKnockout.liveSettings.size, 0);

    const duringKnockout = await render({
        _id: 'groups', tournamentKey: 'groups-cup', name: 'Groups Cup', formatType: 'groups_knockout', currentPhase: 'quarterfinal', groupCount: 2
    });
    assert.equal(duringKnockout.bracket, 1);
    assert.equal(duringKnockout.standings, 0);
    assert.equal(duringKnockout.payloads[0].files[0].name, 'knockout-bracket.png');
    assert.equal(duringKnockout.liveSettings.size, 0);

    const genericKnockoutPhase = await render({
        _id: 'groups', tournamentKey: 'groups-cup', name: 'Groups Cup', formatType: 'groups_knockout', currentPhase: 'knockout', groupCount: 2
    });
    assert.equal(genericKnockoutPhase.bracket, 1);
    assert.equal(genericKnockoutPhase.standings, 0);

    const completedKnockout = await render({
        _id: 'groups', tournamentKey: 'groups-cup', name: 'Groups Cup', formatType: 'groups_knockout', currentPhase: 'completed', groupCount: 2
    });
    assert.equal(completedKnockout.bracket, 1);
    assert.equal(completedKnockout.standings, 0);
});
