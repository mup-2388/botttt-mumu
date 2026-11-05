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
}

class FakeSlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addBooleanOption(configure) {
        configure(new FakeOption());
        return this;
    }
}

function makeFixture(fields) {
    const fixture = {
        _id: fields._id,
        guildId: 'guild-1',
        tournamentId: 'tournament-1',
        phase: 'league',
        roundLabel: 'Matchday 14',
        matchNumber: 1,
        homeTeam: 'Kohli Ki Toli',
        awayTeam: 'Falcons',
        homeTeamId: 'team-kkt',
        awayTeamId: 'team-falcons',
        homeTournamentTeamId: null,
        awayTournamentTeamId: null,
        status: 'Pending',
        result: null,
        reserved: { isReserved: false, until: null },
        notes: '',
        saveCount: 0,
        ...fields,
        save: async function () { this.saveCount++; }
    };
    return fixture;
}

function makeTeamEntry({ id, teamId, name, stats = {} }) {
    return {
        _id: id,
        teamId,
        teamNameSnapshot: name,
        stats: {
            played: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            gf: 0,
            ga: 0,
            points: 0,
            ...stats
        },
        saveCount: 0,
        save: async function () { this.saveCount++; }
    };
}

function makeHarness() {
    const fixtures = [
        makeFixture({
            _id: 'fixture-old-kkt',
            matchNumber: 140,
            homeTeam: 'kOhLi kI tOlI',
            awayTeam: 'Falcons',
            status: 'Played',
            result: { home: 2, away: 1, extraTimeHome: 0, extraTimeAway: 0, penaltiesHome: null, penaltiesAway: null, winner: 'kOhLi kI tOlI' },
            notes: 'Walkover: earlier special note'
        }),
        makeFixture({
            _id: 'fixture-pending-mu',
            matchNumber: 141,
            roundLabel: 'matchday #15',
            homeTeam: 'Wolves',
            awayTeam: 'MANCHESTER UNDIVIDED',
            homeTeamId: 'team-wolves',
            awayTeamId: 'team-mu',
            status: 'Pending',
            result: null,
            reserved: { isReserved: true, until: new Date('2026-12-20T15:00:00Z') }
        }),
        makeFixture({
            _id: 'fixture-before-cutoff',
            matchNumber: 139,
            roundLabel: 'Matchday 13',
            homeTeam: 'Kohli Ki Toli',
            awayTeam: 'Eagles',
            homeTeamId: 'team-kkt',
            awayTeamId: 'team-eagles',
            status: 'Played',
            result: { home: 4, away: 1, winner: 'Kohli Ki Toli' }
        }),
        makeFixture({
            _id: 'fixture-between-withdrawn',
            matchNumber: 142,
            homeTeam: 'Kohli Ki Toli',
            awayTeam: 'Manchester Undivided',
            homeTeamId: 'team-kkt',
            awayTeamId: 'team-mu',
            status: 'Played',
            result: { home: 2, away: 2, winner: '' }
        }),
        makeFixture({
            _id: 'fixture-group-md16',
            matchNumber: 143,
            phase: 'group',
            roundLabel: 'gRoUp A mAtChDaY 16',
            homeTeam: 'Manchester Undivided',
            awayTeam: 'Falcons',
            homeTeamId: 'team-mu',
            awayTeamId: 'team-falcons',
            status: 'Live',
            result: null
        }),
        makeFixture({
            _id: 'fixture-cancelled-kkt',
            matchNumber: 144,
            homeTeam: 'Eagles',
            awayTeam: 'Kohli Ki Toli',
            homeTeamId: 'team-eagles',
            awayTeamId: 'team-kkt',
            status: 'Cancelled',
            result: null
        }),
        makeFixture({
            _id: 'fixture-unrelated',
            matchNumber: 145,
            homeTeam: 'Falcons',
            awayTeam: 'Wolves',
            homeTeamId: 'team-falcons',
            awayTeamId: 'team-wolves',
            status: 'Pending'
        })
    ];

    const teamEntries = [
        makeTeamEntry({
            id: 'entry-kkt', teamId: 'team-kkt', name: 'KOHLI KI TOLI',
            stats: { played: 1, wins: 1, gf: 2, ga: 1, points: 3 }
        }),
        makeTeamEntry({
            id: 'entry-falcons', teamId: 'team-falcons', name: 'Falcons',
            stats: { played: 1, losses: 1, gf: 1, ga: 2 }
        }),
        makeTeamEntry({ id: 'entry-wolves', teamId: 'team-wolves', name: 'Wolves' }),
        makeTeamEntry({ id: 'entry-mu', teamId: 'team-mu', name: 'Manchester Undivided' }),
        makeTeamEntry({ id: 'entry-eagles', teamId: 'team-eagles', name: 'Eagles' })
    ];
    const findQueries = [];
    const command = requireWithMocks('../commands/tournament/withdrawnresults', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1n }
        },
        '../../models/Tournament': {
            Fixture: {
                find: query => {
                    findQueries.push(query);
                    return {
                        select() { return this; },
                        sort: async () => fixtures
                    };
                }
            },
            TournamentTeam: {
                find: async () => teamEntries
            }
        },
        '../../utils/getTournament': {
            getDefaultTournament: async () => ({
                _id: 'tournament-1',
                name: 'Test Cup',
                pointsWin: 3,
                pointsDraw: 1,
                pointsLoss: 0
            })
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/matchdayAnnouncement': {
            matchdayNumber: fixture => {
                const match = String(fixture?.roundLabel || '').match(/\bmatchday\s*#?\s*(\d+)\b/i);
                return match ? Number(match[1]) : null;
            }
        }
    });

    return { command, fixtures, teamEntries, findQueries };
}

test('withdrawnresults resets Matchday 14+ fixtures case-insensitively and updates standings without announcements', async () => {
    const harness = makeHarness();
    const replies = [];

    await harness.command.runWithdrawnResults({
        guild: { id: 'guild-1' },
        reply: async payload => {
            replies.push(payload);
            return payload;
        }
    });

    const byId = new Map(harness.fixtures.map(fixture => [fixture._id, fixture]));
    assert.deepEqual(harness.findQueries[0], { guildId: 'guild-1', tournamentId: 'tournament-1' });

    const oldKktResult = byId.get('fixture-old-kkt');
    assert.equal(oldKktResult.status, 'Played');
    assert.deepEqual(oldKktResult.result, {
        home: 0,
        away: 3,
        extraTimeHome: null,
        extraTimeAway: null,
        penaltiesHome: null,
        penaltiesAway: null,
        winner: 'Falcons'
    });
    assert.equal(oldKktResult.notes, '', 'previous walkover notes should not remain');

    const pendingMuResult = byId.get('fixture-pending-mu');
    assert.equal(pendingMuResult.status, 'Played');
    assert.equal(pendingMuResult.result.home, 3);
    assert.equal(pendingMuResult.result.away, 0);
    assert.equal(pendingMuResult.result.winner, 'Wolves');
    assert.equal(pendingMuResult.reserved.isReserved, false);
    assert.equal(pendingMuResult.reserved.until, null);

    const groupResult = byId.get('fixture-group-md16');
    assert.deepEqual([groupResult.result.home, groupResult.result.away, groupResult.result.winner], [0, 3, 'Falcons']);

    const cancelledResult = byId.get('fixture-cancelled-kkt');
    assert.deepEqual([cancelledResult.status, cancelledResult.result.home, cancelledResult.result.away, cancelledResult.result.winner], [
        'Played', 3, 0, 'Eagles'
    ]);

    assert.deepEqual(
        [byId.get('fixture-before-cutoff').status, byId.get('fixture-before-cutoff').result.home],
        ['Played', 4],
        'Matchday 13 must remain untouched'
    );
    assert.deepEqual(
        [byId.get('fixture-between-withdrawn').result.home, byId.get('fixture-between-withdrawn').result.away],
        [2, 2],
        'a match between both withdrawn teams should not award either side a win'
    );
    assert.equal(byId.get('fixture-unrelated').status, 'Pending');

    const stats = new Map(harness.teamEntries.map(entry => [entry.teamNameSnapshot.toLowerCase(), entry.stats]));
    assert.deepEqual(
        [stats.get('kohli ki toli').played, stats.get('kohli ki toli').wins, stats.get('kohli ki toli').losses, stats.get('kohli ki toli').gf, stats.get('kohli ki toli').ga, stats.get('kohli ki toli').points],
        [2, 0, 2, 0, 6, 0]
    );
    assert.deepEqual(
        [stats.get('falcons').played, stats.get('falcons').wins, stats.get('falcons').losses, stats.get('falcons').gf, stats.get('falcons').ga, stats.get('falcons').points],
        [2, 2, 0, 6, 0, 6]
    );
    assert.deepEqual(
        [stats.get('wolves').played, stats.get('wolves').wins, stats.get('wolves').gf, stats.get('wolves').ga, stats.get('wolves').points],
        [1, 1, 3, 0, 3]
    );
    assert.deepEqual(
        [stats.get('manchester undivided').played, stats.get('manchester undivided').losses, stats.get('manchester undivided').gf, stats.get('manchester undivided').ga],
        [2, 2, 0, 6]
    );
    assert.deepEqual(
        [stats.get('eagles').played, stats.get('eagles').wins, stats.get('eagles').gf, stats.get('eagles').points],
        [1, 1, 3, 3]
    );
    assert.match(replies.at(-1).content, /Updated 4 fixture results/);
    assert.match(replies.at(-1).content, /1 fixture between the withdrawn teams left unchanged/);

    const saveCounts = harness.fixtures.map(fixture => fixture.saveCount);
    const teamSaveCounts = harness.teamEntries.map(entry => entry.saveCount);
    await harness.command.runWithdrawnResults({
        guild: { id: 'guild-1' },
        reply: async payload => payload
    });
    assert.deepEqual(harness.fixtures.map(fixture => fixture.saveCount), saveCounts, 'a repeated run should not re-save unchanged results');
    assert.deepEqual(harness.teamEntries.map(entry => entry.saveCount), teamSaveCounts, 'a repeated run should not double-apply standings');
});

test('withdrawnresults requires explicit confirmation before writing', async () => {
    const harness = makeHarness();
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1' },
        reply: async payload => payload
    };

    await harness.command.execute(message, []);

    assert.equal(harness.findQueries.length, 0);
    assert.equal(harness.fixtures.every(fixture => fixture.saveCount === 0), true);
});

test('slash /withdrawnresults applies the same confirmed database update', async () => {
    const harness = makeHarness();
    let deferred = false;
    const replies = [];
    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        options: { getBoolean: () => true },
        deferReply: async options => { deferred = options.ephemeral; },
        editReply: async payload => {
            replies.push(payload);
            return payload;
        }
    };

    await harness.command.slashExecute(interaction);

    assert.equal(deferred, true);
    assert.equal(harness.fixtures.filter(fixture => fixture.saveCount > 0).length, 4);
    assert.match(replies.at(-1).content, /Updated 4 fixture results/);
});
