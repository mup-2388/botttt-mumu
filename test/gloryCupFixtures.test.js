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
    setMinValue() { return this; }
    addChoices() { return this; }
}

class FakeSlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addStringOption(configure) { configure(new FakeOption()); return this; }
    addBooleanOption(configure) { configure(new FakeOption()); return this; }
}

class FakeEmbedBuilder {
    setColor() { return this; }
    setTitle(title) { this.title = title; return this; }
    setDescription(description) { this.description = description; return this; }
    setTimestamp() { return this; }
}

const fakeDiscord = {
    SlashCommandBuilder: FakeSlashCommandBuilder,
    EmbedBuilder: FakeEmbedBuilder,
    PermissionFlagsBits: { SendMessages: 1 }
};

function loadFixtureBuilder() {
    return requireWithMocks('../utils/fixtureBuilder', {
        '../models/Tournament': {
            Fixture: {
                findOne: () => ({
                    sort() { return this; },
                    select: async () => null
                })
            }
        },
        './displayHelpers': { prettyPhase: phase => phase }
    });
}

function makeTeams(count) {
    return Array.from({ length: count }, (_, index) => ({
        _id: `tournament-team-${index + 1}`,
        teamId: { _id: `team-${index + 1}`, name: `Team ${index + 1}` },
        teamNameSnapshot: `Team ${index + 1}`
    }));
}

function assertExactlyOneFixturePerTeam(fixtures, teamCount) {
    assert.equal(fixtures.length, teamCount / 2);
    const appearances = new Map();
    for (const fixture of fixtures) {
        for (const id of [fixture.homeTournamentTeamId, fixture.awayTournamentTeamId]) {
            appearances.set(String(id), (appearances.get(String(id)) || 0) + 1);
        }
        assert.equal(fixture.phase, 'league');
        assert.equal(fixture.roundLabel, 'Matchday 1');
    }
    assert.equal(appearances.size, teamCount);
    for (const count of appearances.values()) assert.equal(count, 1);
}

test('Glory Cup qualifier pairs every team once and creates no return fixtures', () => {
    const { buildOneMatchPerTeamFixtures } = loadFixtureBuilder();
    const tournament = { _id: 'tournament-1', tournamentKey: 'glory-cup' };
    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
        const fixtures = buildOneMatchPerTeamFixtures({
            guildId: 'guild-1',
            tournament,
            teams: makeTeams(10).map(entry => ({
                tournamentTeamId: entry._id,
                teamId: entry.teamId._id,
                name: entry.teamId.name
            })),
            phase: 'league',
            roundLabel: 'Matchday 1',
            startMatchNumber: 1
        });

        assertExactlyOneFixturePerTeam(fixtures, 10);
        assert.deepEqual(fixtures.map(fixture => fixture.matchNumber), [1, 2, 3, 4, 5]);
        assert.ok(fixtures.every(fixture => fixture.status === 'Pending'));
    } finally {
        Math.random = originalRandom;
    }
});

function loadAutoFixturesHarness({ teamCount = 10, existingCount = 45, inProgressCount = 0 } = {}) {
    const tournament = {
        _id: 'tournament-1',
        guildId: 'guild-1',
        tournamentKey: 'glory-cup',
        name: 'Glory Cup',
        formatType: 'glory_cup',
        groupCount: 0,
        homeAway: true
    };
    const teams = makeTeams(teamCount);
    const calls = { delete: null, inserted: null, settings: null, replies: [] };
    const fixtureBuilder = loadFixtureBuilder();

    const command = requireWithMocks('../commands/tournament/autofixtures', {
        'discord.js': fakeDiscord,
        '../../models/Tournament': {
            Fixture: {
                countDocuments: async query => query.status ? inProgressCount : existingCount,
                deleteMany: async query => { calls.delete = query; },
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
            getString: () => 'glory-cup',
            getBoolean: () => true
        },
        deferReply: async () => {},
        editReply: async payload => { calls.replies.push(payload); }
    };

    return { command, interaction, calls, teams };
}

test('autofixtures --force replaces the existing Glory Cup schedule without touching registered teams', async () => {
    const harness = loadAutoFixturesHarness();
    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
        await harness.command.slashExecute(harness.interaction);
    } finally {
        Math.random = originalRandom;
    }

    assertExactlyOneFixturePerTeam(harness.calls.inserted, harness.teams.length);
    assert.deepEqual(harness.calls.delete, { guildId: 'guild-1', tournamentId: 'tournament-1' });
    assert.deepEqual(harness.calls.settings.filter, { guildId: 'guild-1', tournamentKey: 'glory-cup' });
    assert.equal(harness.calls.settings.update.$set.homeAway, false);
    assert.equal(harness.calls.settings.update.$set.currentPhase, 'league');
    assert.match(harness.calls.replies[0].embeds[0].description, /Replaced \*\*45\*\* old fixture\(s\)/);
    assert.match(harness.calls.replies[0].embeds[0].description, /one match per team/i);
});

test('autofixtures refuses to replace Glory Cup fixtures if a match is live or played', async () => {
    const harness = loadAutoFixturesHarness({ inProgressCount: 1 });
    await harness.command.slashExecute(harness.interaction);

    assert.equal(harness.calls.delete, null);
    assert.equal(harness.calls.inserted, null);
    assert.match(harness.calls.replies[0].content, /live or played/);
});

test('autofixtures leaves the old schedule intact when a Glory Cup has an odd team count', async () => {
    const harness = loadAutoFixturesHarness({ teamCount: 9 });
    await harness.command.slashExecute(harness.interaction);

    assert.equal(harness.calls.delete, null);
    assert.equal(harness.calls.inserted, null);
    assert.match(harness.calls.replies[0].content, /even number of active teams/);
});

test('generatestage league uses the one-match Glory Cup qualifier builder', async () => {
    const tournament = {
        _id: 'tournament-1',
        guildId: 'guild-1',
        tournamentKey: 'glory-cup',
        name: 'Glory Cup',
        formatType: 'glory_cup',
        homeAway: true,
        save: async function () { this.saved = true; }
    };
    const teams = makeTeams(10);
    let inserted = null;
    const fixtureBuilder = loadFixtureBuilder();
    const command = requireWithMocks('../commands/tournament/generatestage', {
        'discord.js': fakeDiscord,
        '../../models/Tournament': {
            Fixture: {
                countDocuments: async () => 0,
                insertMany: async fixtures => { inserted = fixtures; },
                findOne: () => ({
                    sort() { return this; },
                    select: async () => null
                })
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
        '../../utils/displayHelpers': { prettyPhase: phase => phase },
        '../../utils/fixtureBuilder': fixtureBuilder,
        '../../utils/standingsHelpers': { sortTeams: values => values }
    });
    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
        await command.slashExecute({
            guild: { id: 'guild-1' },
            user: { id: 'organizer-1' },
            options: {
                getString: name => ({ key: 'glory-cup', stage: 'league' })[name] ?? null,
                getBoolean: () => false
            },
            deferReply: async () => {},
            editReply: async () => {},
            reply: async () => {}
        });
    } finally {
        Math.random = originalRandom;
    }

    assertExactlyOneFixturePerTeam(inserted, teams.length);
    assert.equal(tournament.currentPhase, 'league');
    assert.equal(tournament.saved, true);
});
