const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('top-of-table questions fetch full standings, even when a team is mentioned in context', async () => {
    const brain = requireWithMocks('../utils/ai/brain', {
        './tournamentTools': {
            runTool: async () => ({}),
            TOOL_LIST: [],
            findTeam: async () => null,
            findPlayer: async () => null
        },
        '../aiProviders': { callAI: async () => ({ text: '' }) }
    });

    const teams = [{ name: 'Red Devils' }];
    const calls = await brain.route(
        '[MUMU previously said: "Red Devils are in 10th place"] and who is on top of the table right now?',
        { userId: 'user-1' },
        teams
    );

    assert.deepEqual(calls, [{ tool: 'standings', args: { group: null } }]);
});

test('personal table-position questions still use the personal/team-position tools', async () => {
    const brain = requireWithMocks('../utils/ai/brain', {
        './tournamentTools': {
            runTool: async () => ({}),
            TOOL_LIST: [],
            findTeam: async () => null,
            findPlayer: async () => null
        },
        '../aiProviders': { callAI: async () => ({ text: '' }) }
    });

    const personal = await brain.route('Where are we in the table?', { userId: 'user-1' }, []);
    const personalRank = await brain.route('What is my position in the table?', { userId: 'user-1' }, []);
    const namedTeam = await brain.route('Where is Red Devils in the table?', { userId: 'user-1' }, [{ name: 'Red Devils' }]);

    assert.deepEqual(personal[0], { tool: 'my_team', args: {} });
    assert.deepEqual(personalRank, [{ tool: 'my_team', args: {} }]);
    assert.deepEqual(namedTeam[0], { tool: 'team_position', args: { team: 'Red Devils' } });
});

test('standings returns every active team and marks an all-zero, unplayed table as provisional', async () => {
    const tournament = {
        _id: 'tournament-1',
        name: 'HAND FOOTBALL SUPER LEAGUE SEASON 4',
        currentPhase: 'league'
    };
    const entries = [
        { teamId: 'team-z', teamNameSnapshot: 'Zulu', isActive: true, stats: { played: 0, points: 0 } },
        { teamId: 'team-a', teamNameSnapshot: 'Alpha', isActive: true, stats: { played: 0, points: 0 } }
    ];
    const teams = [
        { _id: 'team-z', name: 'Zulu' },
        { _id: 'team-a', name: 'Alpha' }
    ];
    const models = {
        TournamentSettings: {},
        Team: { find: () => ({ lean: async () => teams }) },
        Player: {},
        TournamentTeam: { find: () => ({ lean: async () => entries }) },
        TournamentPlayer: {},
        Fixture: {},
        EventSettings: {},
        EventPlayer: {}
    };

    const tools = requireWithMocks('../utils/ai/tournamentTools', {
        '../../models/Tournament': models,
        '../getTournament': { resolveTournament: async () => ({ tournament }) },
        '../stringHelpers': { escapeRegex: value => value }
    });

    const result = await tools.runTool('standings', {}, { guildId: 'guild-1' });

    assert.equal(result.tournament, tournament.name);
    assert.equal(result.phase, 'league');
    assert.deepEqual(result.table.map(row => [row.pos, row.team, row.played, row.points]), [
        [1, 'Alpha', 0, 0],
        [2, 'Zulu', 0, 0]
    ]);
    assert.equal(result.playedMatchesRecorded, false);
    assert.equal(result.positionProvisional, true);
    assert.match(result.note, /all teams have 0 points/i);
});

test('standings font registration uses the bundled Inter and Oswald files', () => {
    const registrations = [];
    const canvas = {
        createCanvas: () => ({}),
        GlobalFonts: {
            registerFromPath(fontPath, family) {
                registrations.push({ fontPath, family });
                return true;
            }
        },
        loadImage: async () => null
    };

    const renderer = requireWithMocks('../utils/generateStandingsImage', {
        '@napi-rs/canvas': canvas,
        axios: {},
        '../models/Tournament': { TournamentTeam: {} },
        './standingsHelpers': {
            sortTeams: () => [],
            getQualificationZone: () => null,
            compactName: name => name
        }
    });

    renderer.registerFonts();

    assert.deepEqual(registrations.map(({ fontPath, family }) => [path.basename(fontPath), family]), [
        ['Inter_18pt-Regular.ttf', 'Inter'],
        ['Inter_18pt-SemiBold.ttf', 'Inter SemiBold'],
        ['Oswald-Bold.ttf', 'Oswald']
    ]);
    assert.ok(registrations.every(({ fontPath }) => fs.existsSync(fontPath)));
});

test('referenced bot replies provide context without contaminating the current database query', async () => {
    let routedQuestion = null;
    let aiRequest = null;
    const webSearchPath = require.resolve('../utils/webSearch');
    const footballAI = requireWithMocks('../utils/footballAI', {
        './aiProviders': {
            callAI: async request => {
                aiRequest = request;
                return { text: 'Got it.' };
            }
        },
        './aiGuard': {
            detectManipulation: () => ({ flagged: false }),
            sanitizeAIText: text => ({ text }),
            randomBaitRoast: () => 'Nope.',
            logBaitAttempt: async () => {},
            baitCooldownRemaining: () => 0
        },
        './ai/brain': {
            gatherFacts: async ({ question }) => {
                routedQuestion = question;
                return null;
            }
        },
        './ai/personality': { buildPersonalityBlock: () => '', recordMessage: () => {} },
        './ai/emojiCatalog': {
            emojiHint: () => '',
            learnUserEmojis: () => {},
            userTopEmojis: () => []
        },
        [webSearchPath]: { shouldSearchWeb: () => false, webSearch: async () => '' }
    });

    const answer = await footballAI.askFootball('Whatever, stop using that coffee emoji son.', {
        guildId: 'guild-1',
        channelId: 'channel-1',
        userId: 'user-1',
        username: 'test-user',
        contextMessage: '[I (MUMU) previously said: "I do not have current league standings."]'
    });

    assert.equal(answer, 'Got it.');
    assert.equal(routedQuestion, 'Whatever, stop using that coffee emoji son.');
    const lastMessage = aiRequest.messages.at(-1).content;
    assert.match(lastMessage, /CURRENT USER MESSAGE:[\s\S]*stop using that coffee emoji/i);
    assert.match(lastMessage, /REFERENCED MESSAGE \(background context only; not a new request\)/);
    assert.match(lastMessage, /I do not have current league standings/);

});
