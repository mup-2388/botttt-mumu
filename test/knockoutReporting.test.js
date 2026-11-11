const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const knockoutResults = require('../utils/knockoutResults');

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
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
}

class FakeEmbedBuilder {
    setColor(color) { this.color = color; return this; }
    setTitle(title) { this.title = title; return this; }
    setDescription(description) { this.description = description; return this; }
    setTimestamp() { return this; }
}

class FakeTextInputBuilder {
    constructor() { this.data = {}; }
    setCustomId(value) { this.data.customId = value; return this; }
    setLabel(value) { this.data.label = value; return this; }
    setStyle(value) { this.data.style = value; return this; }
    setRequired(value) { this.data.required = value; return this; }
    setMaxLength(value) { this.data.maxLength = value; return this; }
    setPlaceholder(value) { this.data.placeholder = value; return this; }
}

class FakeActionRowBuilder {
    addComponents(...components) { this.data = { components }; return this; }
}

class FakeModalBuilder {
    setCustomId(value) { this.data = { customId: value }; return this; }
    setTitle(value) { this.data.title = value; return this; }
    addComponents(...components) { this.data.components = components; return this; }
}

function makeRoundOf16Fixtures({ allPlayed = true, tieWithPens = false } = {}) {
    return Array.from({ length: 8 }, (_, index) => {
        const fixtureNumber = index + 1;
        const isPenaltyTie = tieWithPens && fixtureNumber === 1;
        return {
            _id: `fixture-${fixtureNumber}`,
            guildId: 'guild-1',
            tournamentId: 'tournament-1',
            tournamentKey: 'cup-s1',
            phase: 'roundof16',
            roundLabel: 'Round of 16',
            matchNumber: fixtureNumber,
            leg: 1,
            status: allPlayed || fixtureNumber < 8 ? 'Played' : 'Pending',
            homeTeam: `Home ${fixtureNumber}`,
            awayTeam: `Away ${fixtureNumber}`,
            homeTeamId: `home-team-${fixtureNumber}`,
            awayTeamId: `away-team-${fixtureNumber}`,
            homeTournamentTeamId: `home-entry-${fixtureNumber}`,
            awayTournamentTeamId: `away-entry-${fixtureNumber}`,
            result: isPenaltyTie
                ? { home: 1, away: 1, penaltiesHome: 5, penaltiesAway: 3, winner: 'Home 1' }
                : { home: 2, away: 0, penaltiesHome: null, penaltiesAway: null, winner: `Home ${fixtureNumber}` }
        };
    });
}

function loadProgressionHarness({ fixtures, teamCount = 16, rounds = ['roundof16', 'quarterfinal', 'semifinal', 'final'] }) {
    const calls = { inserted: [], deleted: null, saves: 0 };
    const tournament = {
        _id: 'tournament-1',
        tournamentKey: 'cup-s1',
        formatType: 'knockout',
        teamCount,
        knockoutRounds: rounds,
        currentPhase: 'knockout',
        finalNeutralVenue: true,
        async save() { calls.saves += 1; }
    };

    const Fixture = {
        find(query) {
            return {
                sort() { return this; },
                lean: async () => fixtures.filter(fixture => {
                    if (query.phase?.$in) return query.phase.$in.includes(fixture.phase);
                    return fixture.phase === query.phase;
                })
            };
        },
        countDocuments: async query => fixtures.filter(fixture => fixture.phase === query.phase).length,
        findOne() {
            return {
                sort() { return this; },
                select: async () => fixtures.reduce((latest, fixture) =>
                    !latest || fixture.matchNumber > latest.matchNumber ? fixture : latest, null)
            };
        },
        insertMany: async created => {
            calls.inserted.push(...created);
            fixtures.push(...created);
            return created;
        },
        deleteMany: async query => {
            calls.deleted = query;
            const remove = fixture => query.phase?.$in?.includes(fixture.phase);
            const oldLength = fixtures.length;
            for (let index = fixtures.length - 1; index >= 0; index--) {
                if (remove(fixtures[index])) fixtures.splice(index, 1);
            }
            return { deletedCount: oldLength - fixtures.length };
        }
    };

    const progression = requireWithMocks('../utils/straightKnockoutProgression', {
        '../models/Tournament': { Fixture },
        './knockoutResults': knockoutResults
    });
    return { progression, tournament, fixtures, calls };
}

test('knockout score validation requires a decisive shootout for a full-time draw', () => {
    const validate = knockoutResults.validateReportedScore;
    assert.match(validate({ phase: 'roundof16', homeScore: 1, awayScore: 1 }), /needs both penalty scores/i);
    assert.match(validate({ phase: 'roundof16', homeScore: 1, awayScore: 1, penaltiesHome: 4 }), /both penalty scores/i);
    assert.match(validate({ phase: 'roundof16', homeScore: 1, awayScore: 1, penaltiesHome: 4, penaltiesAway: 4 }), /must be different/i);
    assert.equal(validate({ phase: 'roundof16', homeScore: 1, awayScore: 1, penaltiesHome: 5, penaltiesAway: 3 }), null);
    assert.equal(validate({ phase: 'roundof16', homeScore: 2, awayScore: 1 }), null);
    assert.match(validate({ phase: 'roundof16', homeScore: 2, awayScore: 1, penaltiesHome: 5, penaltiesAway: 3 }), /only enter penalty scores/i);
});

test('league and group draws stay valid without shootouts and reject penalty fields', () => {
    const validate = knockoutResults.validateReportedScore;
    assert.equal(validate({ phase: 'league', homeScore: 0, awayScore: 0 }), null);
    assert.equal(validate({ phase: 'group', homeScore: 2, awayScore: 2 }), null);
    assert.match(validate({ phase: 'league', homeScore: 1, awayScore: 1, penaltiesHome: 5, penaltiesAway: 4 }), /only be reported for knockout/i);
});

test('winner resolution trusts the full-time result, then penalties for a tie', () => {
    assert.equal(knockoutResults.getFixtureWinnerSide({
        homeTeam: 'Home FC', awayTeam: 'Away FC',
        result: { home: 2, away: 1, winner: 'Away FC' }
    }), 'home');
    assert.equal(knockoutResults.getFixtureWinnerSide({
        homeTeam: 'Home FC', awayTeam: 'Away FC',
        result: { home: 1, away: 1, penaltiesHome: 4, penaltiesAway: 5, winner: 'Home FC' }
    }), 'away');
    assert.equal(knockoutResults.getFixtureWinnerSide({
        homeTeam: 'Home FC', awayTeam: 'Away FC', result: { home: 1, away: 1 }
    }), null);
});

test('a completed Round of 16 automatically creates the correctly paired quarter-finals', async () => {
    const fixtures = makeRoundOf16Fixtures({ tieWithPens: true });
    const harness = loadProgressionHarness({ fixtures });

    const result = await harness.progression.autoAdvanceStraightKnockout({
        guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16'
    });

    assert.equal(result.progressed, true);
    assert.equal(result.nextPhase, 'quarterfinal');
    assert.equal(harness.calls.inserted.length, 4);
    assert.deepEqual(harness.calls.inserted.map(fixture => [fixture.homeTeam, fixture.awayTeam]), [
        ['Home 1', 'Home 2'],
        ['Home 3', 'Home 4'],
        ['Home 5', 'Home 6'],
        ['Home 7', 'Home 8']
    ]);
    assert.deepEqual(harness.calls.inserted.map(fixture => fixture.matchNumber), [9, 10, 11, 12]);
    assert.deepEqual(harness.calls.inserted.map(fixture => fixture.bracket.slot), ['1', '2', '3', '4']);
    assert.deepEqual(harness.calls.inserted[0].homeTournamentTeamId, 'home-entry-1');
    assert.equal(harness.tournament.currentPhase, 'quarterfinal');
    assert.equal(harness.calls.saves, 1);
});

test('out-of-order quarter-final reports still feed the correct bracket semi-final slots', async () => {
    const fixtures = [
        { phase: 'quarterfinal', matchNumber: 9, leg: 1, status: 'Played', bracket: { slot: '3' }, homeTeam: 'Slot 3 Home', awayTeam: 'Slot 3 Away', homeTeamId: 's3h', awayTeamId: 's3a', homeTournamentTeamId: 's3he', awayTournamentTeamId: 's3ae', result: { home: 1, away: 0, winner: 'Slot 3 Home' } },
        { phase: 'quarterfinal', matchNumber: 10, leg: 1, status: 'Played', bracket: { slot: '1' }, homeTeam: 'Slot 1 Home', awayTeam: 'Slot 1 Away', homeTeamId: 's1h', awayTeamId: 's1a', homeTournamentTeamId: 's1he', awayTournamentTeamId: 's1ae', result: { home: 1, away: 0, winner: 'Slot 1 Home' } },
        { phase: 'quarterfinal', matchNumber: 11, leg: 1, status: 'Played', bracket: { slot: '2' }, homeTeam: 'Slot 2 Home', awayTeam: 'Slot 2 Away', homeTeamId: 's2h', awayTeamId: 's2a', homeTournamentTeamId: 's2he', awayTournamentTeamId: 's2ae', result: { home: 1, away: 0, winner: 'Slot 2 Home' } },
        { phase: 'quarterfinal', matchNumber: 12, leg: 1, status: 'Played', bracket: { slot: '4' }, homeTeam: 'Slot 4 Home', awayTeam: 'Slot 4 Away', homeTeamId: 's4h', awayTeamId: 's4a', homeTournamentTeamId: 's4he', awayTournamentTeamId: 's4ae', result: { home: 1, away: 0, winner: 'Slot 4 Home' } }
    ];
    const harness = loadProgressionHarness({ fixtures });

    const result = await harness.progression.autoAdvanceStraightKnockout({
        guildId: 'guild-1', tournament: harness.tournament, phase: 'quarterfinal'
    });

    assert.equal(result.nextPhase, 'semifinal');
    assert.deepEqual(harness.calls.inserted.map(fixture => [fixture.homeTeam, fixture.awayTeam]), [
        ['Slot 1 Home', 'Slot 2 Home'],
        ['Slot 3 Home', 'Slot 4 Home']
    ]);
    assert.equal(harness.tournament.currentPhase, 'semifinal');
});

test('automatic progression blocks incomplete current-round bracket slots instead of mispairing winners', async () => {
    const fixtures = makeRoundOf16Fixtures();
    fixtures[0].bracket = { slot: '1' };
    const harness = loadProgressionHarness({ fixtures });

    const result = await harness.progression.autoAdvanceStraightKnockout({
        guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16'
    });

    assert.equal(result.blocked, true);
    assert.match(result.reason, /incomplete or duplicate slot assignments/i);
    assert.equal(harness.calls.inserted.length, 0);
});

test('automatic progression refuses to advance into a partial unnumbered legacy round', async () => {
    const fixtures = makeRoundOf16Fixtures();
    fixtures.push({ phase: 'quarterfinal', matchNumber: 9, status: 'Pending' });
    const harness = loadProgressionHarness({ fixtures });

    const result = await harness.progression.autoAdvanceStraightKnockout({
        guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16'
    });

    assert.equal(result.blocked, true);
    assert.match(result.reason, /existing Quarter Final round is incomplete/i);
    assert.equal(harness.calls.inserted.length, 0);
    assert.equal(harness.tournament.currentPhase, 'knockout');
});

test('the first completed pair of Round-of-16 matches creates its quarter-final immediately', async () => {
    const fixtures = makeRoundOf16Fixtures();
    for (const fixture of fixtures.slice(2)) fixture.status = 'Pending';
    const harness = loadProgressionHarness({ fixtures });

    const result = await harness.progression.autoAdvanceStraightKnockout({
        guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16'
    });

    assert.equal(result.progressed, true);
    assert.equal(result.waiting, true);
    assert.equal(result.pendingFixtures, 6);
    assert.equal(result.fixtures.length, 1);
    assert.equal(result.fixtures[0].bracket.slot, '1');
    assert.deepEqual([result.fixtures[0].homeTeam, result.fixtures[0].awayTeam], ['Home 1', 'Home 2']);
    assert.equal(harness.tournament.currentPhase, 'knockout');
});

test('knockout advancement waits for each pair and is idempotent under concurrent reports', async () => {
    const fixtures = makeRoundOf16Fixtures({ allPlayed: false });
    const harness = loadProgressionHarness({ fixtures });

    const waiting = await harness.progression.autoAdvanceStraightKnockout({
        guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16'
    });
    assert.equal(waiting.progressed, true);
    assert.equal(waiting.waiting, true);
    assert.equal(waiting.pendingFixtures, 1);
    assert.equal(waiting.fixtures.length, 3);
    assert.deepEqual(waiting.fixtures.map(fixture => fixture.bracket.slot), ['1', '2', '3']);

    fixtures[7].status = 'Played';
    fixtures[7].result = { home: 1, away: 0, winner: 'Home 8' };
    const [first, second] = await Promise.all([
        harness.progression.autoAdvanceStraightKnockout({ guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16' }),
        harness.progression.autoAdvanceStraightKnockout({ guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16' })
    ]);

    assert.equal(harness.calls.inserted.length, 4);
    assert.ok(first.progressed || first.alreadyAdvanced);
    assert.ok(second.progressed || second.alreadyAdvanced);
});

test('partial bracket image slots remain in their original seeded positions even when match numbers differ', () => {
    const context = new Proxy({
        measureText: text => ({ width: String(text).length * 8 }),
        createLinearGradient: () => ({ addColorStop() {} })
    }, { get(target, key) { return key in target ? target[key] : () => {}; } });
    const renderer = requireWithMocks('../utils/generateKnockoutBracketImage', {
        '@napi-rs/canvas': { createCanvas: () => ({ getContext: () => context, toBuffer: () => Buffer.from('png') }) },
        '../models/Tournament': { Fixture: { find: () => ({ sort() { return this; }, lean: async () => [] }) } }
    });
    const partialQuarterFinals = [
        { _id: 'late-slot', phase: 'quarterfinal', matchNumber: 9, bracket: { slot: '3' }, homeTeam: 'Slot 3 Home', awayTeam: 'Slot 3 Away', result: {} },
        { _id: 'early-slot', phase: 'quarterfinal', matchNumber: 10, bracket: { slot: '1' }, homeTeam: 'Slot 1 Home', awayTeam: 'Slot 1 Away', result: {} }
    ];

    const round = renderer.buildBracketRounds(partialQuarterFinals)[0];
    assert.equal(round.matches[0].homeTeam, 'Slot 1 Home');
    assert.equal(round.matches[1], null);
    assert.equal(round.matches[2].homeTeam, 'Slot 3 Home');
    assert.equal(round.matches[3], null);
});

test('undoing an earlier result removes only unscheduled pending knockout rounds', async () => {
    const fixtures = makeRoundOf16Fixtures();
    fixtures.push({
        phase: 'quarterfinal', matchNumber: 9, status: 'Pending', scheduledAt: null,
        reserved: { isReserved: false }, channelPlan: { state: 'pending' }, bracket: { slot: '1' }
    });
    const harness = loadProgressionHarness({ fixtures });

    const result = await harness.progression.rollbackStraightKnockoutAfterUndo({
        guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16'
    });
    assert.equal(result.ok, true);
    assert.equal(result.removedFixtures, 1);
    assert.equal(harness.fixtures.some(fixture => fixture.phase === 'quarterfinal'), false);
    assert.equal(harness.tournament.currentPhase, 'roundof16');
});

test('undo refuses to discard a scheduled downstream knockout fixture', async () => {
    const fixtures = makeRoundOf16Fixtures();
    fixtures.push({
        phase: 'quarterfinal', matchNumber: 9, status: 'Pending', scheduledAt: new Date(),
        reserved: { isReserved: false }, channelPlan: { state: 'pending' }, bracket: { slot: '1' }
    });
    const harness = loadProgressionHarness({ fixtures });

    const result = await harness.progression.rollbackStraightKnockoutAfterUndo({
        guildId: 'guild-1', tournament: harness.tournament, phase: 'roundof16'
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /has been played, cancelled, reserved, or scheduled/i);
    assert.equal(harness.fixtures.some(fixture => fixture.phase === 'quarterfinal'), true);
    assert.equal(harness.calls.deleted, null);
});

test('report modal includes optional penalty fields only for knockout fixtures', () => {
    const fixture = {
        _id: 'fixture-1', matchNumber: 1, phase: 'roundof16',
        homeTeam: 'Home FC', awayTeam: 'Away FC'
    };
    const command = loadReportProcessor({
        fixture,
        tournament: { _id: 'tournament-1', tournamentKey: 'cup-s1', formatType: 'knockout' },
        calls: { advancement: [], imageRefresh: 0 }
    });

    const knockoutModal = command.buildScoreModal(fixture, 'score-modal');
    const knockoutInputs = knockoutModal.data.components.flatMap(row => row.data.components);
    assert.deepEqual(knockoutInputs.map(input => input.data.customId), [
        'home_score', 'away_score', 'home_penalties', 'away_penalties'
    ]);
    assert.equal(knockoutInputs[2].data.required, false);
    assert.equal(knockoutInputs[3].data.required, false);

    const leagueModal = command.buildScoreModal({ ...fixture, phase: 'league' }, 'league-modal');
    const leagueInputs = leagueModal.data.components.flatMap(row => row.data.components);
    assert.deepEqual(leagueInputs.map(input => input.data.customId), ['home_score', 'away_score']);
});

test('report saves full-time and penalty scores separately and refreshes the linked bracket image', async () => {
    const fixture = {
        _id: 'fixture-1',
        guildId: 'guild-1',
        tournamentId: 'tournament-1',
        phase: 'roundof16',
        matchNumber: 1,
        roundLabel: 'Round of 16',
        homeTeam: 'Home FC',
        awayTeam: 'Away FC',
        result: {},
        async save() { this.saveCount = (this.saveCount || 0) + 1; }
    };
    const tournament = { _id: 'tournament-1', tournamentKey: 'cup-s1', name: 'Cup S1', formatType: 'knockout' };
    const calls = { advancement: [], imageRefresh: 0 };
    const command = loadReportProcessor({ fixture, tournament, calls, advancement: {
        progressed: true, waiting: true, fixtures: [{}, {}], pendingFixtures: 6,
        fromPhase: 'roundof16', nextPhase: 'quarterfinal'
    } });

    const result = await command.processFixtureReport({
        client: { liveSettings: new Map() },
        guild: { id: 'guild-1' },
        tournament,
        fixtureId: fixture._id,
        homeScore: 1,
        awayScore: 1,
        penaltiesHome: 5,
        penaltiesAway: 3
    });

    assert.equal(fixture.result.home, 1);
    assert.equal(fixture.result.away, 1);
    assert.equal(fixture.result.extraTimeHome, null);
    assert.equal(fixture.result.extraTimeAway, null);
    assert.equal(fixture.result.penaltiesHome, 5);
    assert.equal(fixture.result.penaltiesAway, 3);
    assert.equal(fixture.result.winner, 'Home FC');
    assert.equal(calls.advancement.length, 1);
    assert.equal(calls.advancement[0].phase, 'roundof16');
    assert.equal(calls.imageRefresh, 1);
    assert.match(result.embed.description, /Penalties: \*\*5-3\*\*/);
    assert.match(result.embed.description, /Winner: \*\*Home FC\*\*/);
    assert.match(result.embed.description, /Automatically advanced winners/i);
    assert.match(result.embed.description, /6 .*roundof16.* remain/i);
});

test('bracket image summary keeps full-time goals and shootout scores separate, including reversed final-leg teams', () => {
    const context = new Proxy({
        measureText: text => ({ width: String(text).length * 8 }),
        createLinearGradient: () => ({ addColorStop() {} })
    }, { get(target, key) { return key in target ? target[key] : () => {}; } });
    const renderer = requireWithMocks('../utils/generateKnockoutBracketImage', {
        '@napi-rs/canvas': { createCanvas: () => ({ getContext: () => context, toBuffer: () => Buffer.from('png') }) },
        '../models/Tournament': { Fixture: { find: () => ({ sort() { return this; }, lean: async () => [] }) } }
    });
    const leg1 = {
        _id: 'leg-1', matchNumber: 1, leg: 1, aggregateTieKey: 'tie-1',
        homeTeam: 'Team A', awayTeam: 'Team B', homeTeamId: 'a', awayTeamId: 'b',
        result: { home: 1, away: 0 }
    };
    const leg2 = {
        _id: 'leg-2', matchNumber: 2, leg: 2, aggregateTieKey: 'tie-1',
        homeTeam: 'Team B', awayTeam: 'Team A', homeTeamId: 'b', awayTeamId: 'a',
        result: { home: 1, away: 0, penaltiesHome: 3, penaltiesAway: 5, winner: 'Team A' }
    };

    const tie = renderer.summarizeTie([leg1, leg2]);
    assert.equal(tie.homeScore, 1);
    assert.equal(tie.awayScore, 1);
    assert.equal(tie.homePenalties, 5);
    assert.equal(tie.awayPenalties, 3);
    assert.equal(tie.winner, 'Team A');
    assert.equal(renderer.formatBracketScore(tie.homeScore, tie.homePenalties), '- 1 (5)');
    assert.equal(renderer.formatBracketScore(tie.awayScore, tie.awayPenalties), '- 1 (3)');
    assert.equal(renderer.formatBracketScore(null), '—');
});

test('report rejects an unresolved knockout draw before changing or saving the fixture', async () => {
    const fixture = {
        _id: 'fixture-1', guildId: 'guild-1', tournamentId: 'tournament-1',
        phase: 'roundof16', homeTeam: 'Home FC', awayTeam: 'Away FC', status: 'Pending', result: {},
        async save() { this.saved = true; }
    };
    const tournament = { _id: 'tournament-1', tournamentKey: 'cup-s1', formatType: 'knockout' };
    const calls = { advancement: [], imageRefresh: 0 };
    const command = loadReportProcessor({ fixture, tournament, calls });

    await assert.rejects(command.processFixtureReport({
        client: {}, guild: { id: 'guild-1' }, tournament, fixtureId: fixture._id,
        homeScore: 1, awayScore: 1
    }), /needs both penalty scores/i);
    assert.equal(fixture.saved, undefined);
    assert.equal(fixture.status, 'Pending');
    assert.equal(calls.advancement.length, 0);
});

function loadReportProcessor({ fixture, tournament, calls, advancement = { skipped: true } }) {
    return requireWithMocks('../commands/tournament/report', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1 },
            EmbedBuilder: FakeEmbedBuilder,
            ActionRowBuilder: FakeActionRowBuilder,
            ButtonBuilder: class {},
            ButtonStyle: {},
            StringSelectMenuBuilder: class {},
            ModalBuilder: FakeModalBuilder,
            TextInputBuilder: FakeTextInputBuilder,
            TextInputStyle: { Short: 1 }
        },
        '../../models/Tournament': {
            Fixture: { findOne: async () => fixture },
            TournamentTeam: {
                findOne: async () => ({ _id: 'entry', stats: {}, save: async () => {} }),
                updateOne: async () => ({ modifiedCount: 1 })
            }
        },
        '../../utils/getTournament': {
            getDefaultTournament: async () => tournament,
            getSelectableTournaments: async () => [tournament],
            getTournamentByKey: async () => tournament
        },
        '../../utils/updateStandings': { updateAllLiveStandings: async () => {} },
        '../../utils/updateTopStats': { updateLiveTopStats: async () => {} },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/displayHelpers': { prettyPhase: phase => phase },
        './master-schedule': { refreshLiveMasterSchedules: async () => {} },
        './sendbracket': { refreshLiveBracket: async () => {} },
        './bracketimage': {
            refreshLiveBracketImage: async () => { calls.imageRefresh += 1; }
        },
        '../../utils/straightKnockoutProgression': {
            autoAdvanceStraightKnockout: async input => {
                calls.advancement.push(input);
                return advancement;
            }
        },
        '../../utils/knockoutResults': knockoutResults,
        '../../utils/ai/emojiSlots': { slotEmoji: () => '⚽', vsLine: (home, away) => `${home} vs ${away}` },
        '../../utils/reservedMatches': {
            markReserved: async () => ({ ok: true }), reservedBadge: () => '', isReserved: () => false
        },
        '../../utils/istTime': {
            parseScheduleTime: () => ({ ok: true, date: new Date() }),
            discordFull: () => '', discordRelative: () => ''
        }
    });
}
