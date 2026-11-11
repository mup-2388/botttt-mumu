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
    constructor() {
        this.choices = [];
    }

    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    setRequired(required) { this.required = required; return this; }
    setMinValue(value) { this.minValue = value; return this; }
    addChoices(...choices) { this.choices.push(...choices); return this; }
}

class FakeSlashCommandBuilder {
    constructor() {
        this.options = [];
    }

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
    setColor() { return this; }
    setTitle() { return this; }
    setDescription() { return this; }
    setTimestamp() { return this; }
    addFields() { return this; }
}

const fakeDiscord = {
    SlashCommandBuilder: FakeSlashCommandBuilder,
    EmbedBuilder: FakeEmbedBuilder,
    PermissionFlagsBits: { SendMessages: 1 }
};

test('Glory Cup rejects separate UCL places so the top-eight playoff zone stays clear', async () => {
    let databaseUpdated = false;
    let response;
    const command = requireWithMocks('../commands/tournament/setuclqualification', {
        'discord.js': fakeDiscord,
        '../../models/Tournament': {
            TournamentSettings: {
                findOneAndUpdate: async () => { databaseUpdated = true; }
            }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/getTournament': {
            resolveTournament: async () => ({ tournament: { _id: 'glory-cup-id', formatType: 'glory_cup' } }),
            extractTournamentFromArgs: async () => ({})
        }
    });

    await command.slashExecute({
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        options: {
            getString: () => 'glory-cup',
            getInteger: () => 4
        },
        deferReply: async () => {},
        editReply: async payload => { response = payload; }
    });

    assert.match(response.content, /does not use UCL spots/);
    assert.equal(databaseUpdated, false);
});

test('settournament configures Glory Cup as a one-match-per-team qualifier with an eight-team playoff', async () => {
    let updateCall;
    let syncedTournament;
    let replied;
    const settings = {
        _id: 'glory-cup-id',
        guildId: 'guild-1',
        tournamentKey: 'glory-cup',
        name: 'Glory Cup',
        formatType: 'glory_cup',
        schedulingMode: 'auto',
        teamCount: 12,
        groupCount: 0,
        teamsPerGroup: 0,
        homeAway: false,
        qualificationSpotsPerGroup: 8,
        uclQualificationSpots: 0,
        hasKnockout: true,
        knockoutRounds: ['quarterfinal', 'semifinal', 'final'],
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
                    return settings;
                }
            }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/tournamentSync': {
            syncAllTeamsToTournament: async (_guildId, tournament) => {
                syncedTournament = tournament;
                return { syncedTeams: 12, syncedPlayers: 96 };
            }
        }
    });

    const formatOption = command.data.options.find(option => option.name === 'format');
    assert.ok(formatOption.choices.some(choice => choice.value === 'glory_cup'));

    const values = {
        key: 'glory-cup',
        format: 'glory_cup',
        mode: 'auto',
        name: null,
        knockoutrounds: null,
        twoleggedrounds: null,
        currentphase: null
    };
    const integers = { teams: 12, groups: 4, teamspergroup: 3 };
    const booleans = {
        homeaway: true,
        hasknockout: false,
        finalneutralvenue: true,
        registrationopen: true,
        manualregistration: false
    };
    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        options: {
            getString: name => values[name] ?? null,
            getInteger: name => integers[name] ?? null,
            getBoolean: name => booleans[name] ?? null,
            getRole: () => null
        },
        deferReply: async () => {},
        editReply: async payload => { replied = payload; }
    };

    await command.slashExecute(interaction);

    assert.deepEqual(updateCall.filter, { guildId: 'guild-1', tournamentKey: 'glory-cup' });
    assert.equal(updateCall.update.$set.name, 'Glory Cup');
    assert.equal(updateCall.update.$set.formatType, 'glory_cup');
    assert.equal(updateCall.update.$set.groupCount, 0);
    assert.equal(updateCall.update.$set.teamsPerGroup, 0);
    assert.equal(updateCall.update.$set.homeAway, false);
    assert.equal(updateCall.update.$set.teamCount, 12);
    assert.equal(updateCall.update.$set.qualificationSpotsPerGroup, 8);
    assert.equal(updateCall.update.$set.uclQualificationSpots, 0);
    assert.equal(updateCall.update.$set.hasKnockout, true);
    assert.deepEqual(updateCall.update.$set.knockoutRounds, ['quarterfinal', 'semifinal', 'final']);
    assert.equal(updateCall.update.$set.manualRegistration, false);
    assert.equal(syncedTournament, settings);
    assert.match(replied.content, /Glory Cup — One-Match Qualifier \+ Top 8 Playoffs/);
    assert.match(replied.content, /One match per team/);
    assert.match(replied.content, /Top 8 advance to the quarterfinals/);
});

function loadGenerateStageHarness({
    teamCount = 10,
    qualifierFixtureCount = Math.floor(teamCount / 2),
    playedQualifierCount = Math.floor(teamCount / 2)
} = {}) {
    const tournament = {
        _id: 'glory-cup-id',
        guildId: 'guild-1',
        tournamentKey: 'glory-cup',
        name: 'Glory Cup',
        formatType: 'glory_cup',
        teamCount,
        groupCount: 0,
        hasKnockout: true,
        qualificationSpotsPerGroup: 8,
        knockoutRounds: ['quarterfinal', 'semifinal', 'final'],
        twoLeggedRounds: [],
        finalNeutralVenue: true,
        currentPhase: 'league',
        save: async function () { this.saved = true; }
    };
    const teams = Array.from({ length: teamCount }, (_, index) => {
        const rank = index + 1;
        return {
            _id: `entry-${rank}`,
            teamId: { _id: `team-${rank}`, name: `Team ${String(rank).padStart(2, '0')}` },
            teamNameSnapshot: `Team ${String(rank).padStart(2, '0')}`,
            // Old global group keys must not affect the Glory Cup's flat table.
            groupKey: rank % 2 ? 'A' : 'B',
            stats: {
                played: 10,
                points: 100 - rank,
                gf: 40 - rank,
                ga: 10
            }
        };
    });
    let insertedFixtures = null;
    let generatedPairs = null;
    const replies = [];

    const command = requireWithMocks('../commands/tournament/generatestage', {
        'discord.js': fakeDiscord,
        '../../models/Tournament': {
            Fixture: {
                countDocuments: async query => {
                    if (query.phase === 'league' && query.status === 'Played') return playedQualifierCount;
                    if (query.phase === 'league') return qualifierFixtureCount;
                    return 0;
                },
                insertMany: async fixtures => { insertedFixtures = fixtures; }
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
        '../../utils/fixtureBuilder': {
            buildRoundRobinFixtures: () => [],
            buildKnockoutFixtures: ({ phase, pairs, startMatchNumber }) => {
                generatedPairs = pairs.map(([home, away]) => [home.name, away.name]);
                return pairs.map(([home, away], index) => ({
                    phase,
                    matchNumber: startMatchNumber + index,
                    homeTeam: home.name,
                    awayTeam: away.name
                }));
            },
            getNextMatchNumber: async () => 200
        }
    });

    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        options: {
            getString: name => ({ key: 'glory-cup', stage: 'knockout' })[name] ?? null,
            getBoolean: () => false
        },
        deferReply: async () => {},
        editReply: async payload => { replies.push(payload); }
    };

    return {
        command,
        interaction,
        tournament,
        teams,
        replies,
        get insertedFixtures() { return insertedFixtures; },
        get generatedPairs() { return generatedPairs; }
    };
}

test('Glory Cup takes the standings top eight and creates seeded quarterfinals', async () => {
    const harness = loadGenerateStageHarness();
    await harness.command.slashExecute(harness.interaction);

    assert.deepEqual(harness.generatedPairs, [
        ['Team 01', 'Team 08'],
        ['Team 04', 'Team 05'],
        ['Team 02', 'Team 07'],
        ['Team 03', 'Team 06']
    ]);
    assert.equal(harness.insertedFixtures.length, 4);
    assert.ok(harness.insertedFixtures.every(fixture => fixture.phase === 'quarterfinal'));
    assert.equal(harness.tournament.currentPhase, 'knockout');
    assert.equal(harness.tournament.saved, true);
    assert.equal(harness.replies.length, 1);
});

test('Glory Cup refuses to create knockouts until every qualifier fixture has been played', async () => {
    const harness = loadGenerateStageHarness({ playedQualifierCount: 4 });
    await harness.command.slashExecute(harness.interaction);

    assert.equal(harness.insertedFixtures, null);
    assert.match(harness.replies.at(-1).content, /until every active team has played its single qualifier match/);
    assert.equal(harness.tournament.currentPhase, 'league');
});

test('Glory Cup refuses to create playoffs unless eight active teams qualify', async () => {
    const harness = loadGenerateStageHarness({ teamCount: 7 });
    await harness.command.slashExecute(harness.interaction);

    assert.equal(harness.insertedFixtures, null);
    assert.match(harness.replies.at(-1).content, /Glory Cup knockouts require 8 active teams/);
    assert.equal(harness.tournament.currentPhase, 'league');
});

test('Glory Cup standings mark exactly places one through eight as qualifying', () => {
    const { getQualificationZone } = require('../utils/standingsHelpers');
    const settings = {
        formatType: 'glory_cup',
        hasKnockout: true,
        qualificationSpotsPerGroup: 8,
        uclQualificationSpots: 0
    };

    for (let position = 1; position <= 8; position++) {
        assert.equal(getQualificationZone({ position, settings, groupKey: null }), 'qualification');
    }
    assert.equal(getQualificationZone({ position: 9, settings, groupKey: null }), 'neutral');
});

test('Glory Cup live-table text explicitly explains the top-eight qualification zone', async () => {
    const settings = {
        _id: 'glory-cup-id',
        tournamentKey: 'glory-cup',
        name: 'Glory Cup',
        emoji: '🏆',
        formatType: 'glory_cup',
        hasKnockout: true,
        qualificationSpotsPerGroup: 8,
        uclQualificationSpots: 0
    };
    const liveData = { _id: 'live-1', channelId: 'channel-1', messageId: 'message-1' };
    const teams = Array.from({ length: 9 }, (_, index) => ({
        teamNameSnapshot: `Team ${index + 1}`,
        stats: { played: 1, points: 9 - index, gf: 9 - index, ga: 0 }
    }));
    let editedPayload;
    const message = {
        edit: async payload => { editedPayload = payload; },
        delete: async () => {}
    };
    const channel = {
        messages: { fetch: async () => message },
        send: async () => ({ id: 'replacement-message' })
    };
    const liveMessageModel = {
        findOne: async () => liveData,
        updateOne: async () => ({ modifiedCount: 1 })
    };

    const standings = requireWithMocks('../utils/updateStandings', {
        'discord.js': { AttachmentBuilder: class {} },
        '../models/Tournament': {
            TournamentSettings: { findOne: async () => settings },
            TournamentTeam: {
                find: () => ({
                    populate() { return this; },
                    lean: async () => teams
                })
            }
        },
        '../models/LiveMessage': liveMessageModel,
        './generateStandingsImage': {
            generateStandingsImage: async () => { throw new Error('force text fallback'); }
        }
    });

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        await standings.updateLiveStandings(
            { channels: { fetch: async () => channel } },
            'guild-1',
            'glory-cup'
        );
    } finally {
        console.error = originalConsoleError;
    }

    assert.match(editedPayload.content, /↑ Top 8 qualify for knockouts\./);
    assert.match(editedPayload.content, /GLORY CUP LIVE STANDINGS/);
});
