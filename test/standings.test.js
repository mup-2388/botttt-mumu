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

async function withRequireMocks(parentModulePath, mocks, callback) {
    const resolvedPath = require.resolve(parentModulePath);
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (parent?.filename === resolvedPath && Object.prototype.hasOwnProperty.call(mocks, request)) {
            return mocks[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return await callback();
    } finally {
        Module._load = originalLoad;
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

test('top-four chance questions deterministically fetch the live table and the asking user\'s team', async () => {
    const brain = requireWithMocks('../utils/ai/brain', {
        './tournamentTools': {
            runTool: async () => ({}),
            TOOL_LIST: [],
            findTeam: async () => null,
            findPlayer: async () => null
        },
        '../aiProviders': { callAI: async () => ({ text: '' }) }
    });

    const calls = await brain.route(
        'Is there any chance for our team to get at least in top 4 of this tournament?',
        { userId: 'user-1' },
        []
    );

    assert.deepEqual(calls, [
        { tool: 'standings', args: { group: null } },
        { tool: 'my_team', args: {} }
    ]);
});

test('top-four fact gathering uses live standings, resolves the user team, and checks its fixtures', async () => {
    const executed = [];
    const toolResults = {
        standings: {
            tournament: 'Current League',
            table: [
                { pos: 1, team: 'Harbor FC', points: 18 },
                { pos: 4, team: 'Northside', points: 9 },
                { pos: 7, team: 'River Town', points: 5 }
            ]
        },
        my_team: { team: 'River Town', position: 7, points: 5 },
        team_schedule: { team: 'River Town', remainingMatches: 3, upcoming: [{ opponent: 'Harbor FC' }] }
    };
    const brain = requireWithMocks('../utils/ai/brain', {
        './tournamentTools': {
            runTool: async (tool, args, ctx) => {
                executed.push({ tool, args, ctx });
                return toolResults[tool] || { error: `missing fixture for ${tool}` };
            },
            TOOL_LIST: [],
            findTeam: async () => null,
            findPlayer: async () => null
        },
        '../aiProviders': {
            callAI: async () => { throw new Error('the deterministic top-four route should not invoke the planner'); }
        }
    });

    const facts = await withRequireMocks('../utils/ai/brain', {
        '../../models/Tournament': {
            Team: {
                find: () => ({ select: () => ({ lean: async () => [] }) })
            }
        }
    }, () => brain.gatherFacts({
        question: 'Is there any chance for our team to get at least in top 4 of this tournament?',
        guildId: 'guild-live-top-four',
        userId: 'user-1'
    }));

    assert.deepEqual(executed.map(call => [call.tool, call.args]), [
        ['standings', { group: null }],
        ['my_team', {}],
        ['team_schedule', { team: 'River Town' }]
    ]);
    assert.deepEqual(facts.tools, ['standings', 'my_team', 'team_schedule']);
    assert.match(facts.factBlock, /LIVE TOURNAMENT FACTS/);
    assert.match(facts.factBlock, /River Town/);
    assert.match(facts.factBlock, /"remainingMatches":3/);
});

test('a standings correction follow-up re-queries the server database instead of repeating an empty-table claim', async () => {
    const executed = [];
    const brain = requireWithMocks('../utils/ai/brain', {
        './tournamentTools': {
            runTool: async (tool, args) => {
                executed.push({ tool, args });
                if (tool === 'standings') return { tournament: 'Current League', table: [{ pos: 1, team: 'Northside', points: 8 }] };
                if (tool === 'my_team') return { team: 'River Town', position: 4, points: 3 };
                return { error: 'unexpected tool' };
            },
            TOOL_LIST: [],
            findTeam: async () => null,
            findPlayer: async () => null
        },
        '../aiProviders': {
            callAI: async () => { throw new Error('a correction follow-up should use deterministic database tools'); }
        }
    });

    const facts = await withRequireMocks('../utils/ai/brain', {
        '../../models/Tournament': {
            Team: {
                find: () => ({ select: () => ({ lean: async () => [] }) })
            }
        }
    }, () => brain.gatherFacts({
        question: 'Look at our database again, son.',
        contextMessage: '[I (MUMU) previously said: "I do not have current league standings."]',
        guildId: 'guild-standings-retry',
        userId: 'user-1'
    }));

    assert.deepEqual(executed.map(call => call.tool), ['standings', 'my_team']);
    assert.match(facts.factBlock, /Northside/);
    assert.match(facts.factBlock, /River Town/);
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
    let standingsQuery = null;
    const models = {
        TournamentSettings: {},
        Team: { find: () => ({ lean: async () => teams }) },
        Player: {},
        TournamentTeam: {
            find: query => {
                standingsQuery = query;
                return { lean: async () => entries };
            }
        },
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
    assert.deepEqual(standingsQuery, {
        guildId: 'guild-1',
        tournamentId: tournament._id,
        isActive: true
    });
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

test('brief correction replies retain local standings context from earlier turns', async () => {
    const factRequests = [];
    const webSearchPath = require.resolve('../utils/webSearch');
    const footballAI = requireWithMocks('../utils/footballAI', {
        './aiProviders': { callAI: async () => ({ text: 'I could not find the table.' }) },
        './aiGuard': {
            detectManipulation: () => ({ flagged: false }),
            sanitizeAIText: text => ({ text }),
            randomBaitRoast: () => 'Nope.',
            logBaitAttempt: async () => {},
            baitCooldownRemaining: () => 0
        },
        './ai/brain': {
            gatherFacts: async ({ question, contextMessage }) => {
                factRequests.push({ question, contextMessage });
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

    const common = { guildId: 'guild-history', channelId: 'channel-history', userId: 'user-history', username: 'test-user' };
    await footballAI.askFootball('Is there any chance for our team to get top 4 in this tournament?', common);
    await footballAI.askFootball('What?', { ...common, contextMessage: '[I (MUMU) said: "I could not find the table."]' });
    await footballAI.askFootball('Look again, son.', { ...common, contextMessage: '[I (MUMU) said: "What?"]' });

    assert.equal(factRequests.length, 3);
    assert.match(factRequests[1].contextMessage, /server's tournament standings/i);
    assert.match(factRequests[2].contextMessage, /server's tournament standings/i);
});

test('private tournament questions use database facts instead of public web search', async () => {
    let webSearchCalls = 0;
    let aiRequest = null;
    const webSearchPath = require.resolve('../utils/webSearch');
    const footballAI = requireWithMocks('../utils/footballAI', {
        './aiProviders': {
            callAI: async request => {
                aiRequest = request;
                return { text: 'Here is the current server-table answer.' };
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
            gatherFacts: async () => ({
                factBlock: 'LIVE TOURNAMENT FACTS: standings → {"tournament":"Current League","table":[{"pos":1,"team":"Harbor FC","points":18}]}',
                tools: ['standings', 'my_team', 'team_schedule']
            })
        },
        './ai/personality': { buildPersonalityBlock: () => '', recordMessage: () => {} },
        './ai/emojiCatalog': {
            emojiHint: () => '',
            learnUserEmojis: () => {},
            userTopEmojis: () => []
        },
        [webSearchPath]: {
            shouldSearchWeb: () => true,
            webSearch: async () => {
                webSearchCalls++;
                return 'Public standings unrelated to this Discord tournament.';
            }
        }
    });

    const answer = await footballAI.askFootball(
        'Is there any chance for our team to get into the top 4 of this tournament right now?',
        { guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', username: 'test-user' }
    );

    assert.equal(answer, 'Here is the current server-table answer.');
    assert.equal(webSearchCalls, 0);
    assert.match(aiRequest.systemPrompt, /LIVE TOURNAMENT FACTS/);
    assert.doesNotMatch(JSON.stringify(aiRequest.messages), /Public standings unrelated/);
});

test('referenced bot replies provide context without contaminating the current database query', async () => {
    let routedQuestion = null;
    let routedContext = null;
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
            gatherFacts: async ({ question, contextMessage }) => {
                routedQuestion = question;
                routedContext = contextMessage;
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
    assert.equal(routedContext, '[I (MUMU) previously said: "I do not have current league standings."]');
    const lastMessage = aiRequest.messages.at(-1).content;
    assert.match(lastMessage, /CURRENT USER MESSAGE:[\s\S]*stop using that coffee emoji/i);
    assert.match(lastMessage, /REFERENCED MESSAGE \(background context only; not a new request\)/);
    assert.match(lastMessage, /I do not have current league standings/);

});
