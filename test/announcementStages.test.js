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

test('announcement fallbacks and prompts match schedule, reminder, and kickoff stages', async () => {
    const prompts = [];
    const fakeFs = {
        readFileSync: () => '[]',
        mkdirSync: () => {},
        writeFileSync: () => {}
    };
    const { buildMatchAnnouncement } = requireWithMocks('../utils/ai/announcements', {
        fs: fakeFs,
        '../aiProviders': {
            callAI: async request => {
                prompts.push(request);
                return { text: '' };
            }
        },
        './tournamentTools': { runTool: async () => null },
        '../istTime': {
            formatIst: () => '12 Oct, 9:00 PM IST',
            discordFull: () => '<t:1000:F>',
            discordRelative: () => '<t:1000:R>'
        },
        './emojiCatalog': { emojiHint: () => '' },
        './emojiSlots': {
            slotHint: () => '',
            slotEmoji: () => '',
            vsLine: (home, away) => `${home} vs ${away}`
        }
    });

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
        const common = {
            guildId: 'guild-1',
            tournament: { name: 'Default League', tournamentKey: 'default' },
            fixture: { matchNumber: 12 },
            homeTeam: 'Falcons',
            awayTeam: 'Tigers',
            scheduledAt: new Date('2026-10-12T15:30:00.000Z')
        };

        const scheduled = await buildMatchAnnouncement({ ...common, announcementType: 'scheduled' });
        const reminder = await buildMatchAnnouncement({ ...common, announcementType: 'reminder' });
        const kickoff = await buildMatchAnnouncement({ ...common, announcementType: 'kickoff' });

        assert.match(scheduled, /locked in/i);
        assert.match(reminder, /one minute/i);
        assert.match(kickoff, /Two teams/i);
        assert.match(scheduled, /12 Oct, 9:00 PM IST/);
        assert.match(reminder, /12 Oct, 9:00 PM IST/);
        assert.match(kickoff, /12 Oct, 9:00 PM IST/);
        assert.match(prompts[0].systemPrompt, /just scheduled this match/i);
        assert.match(prompts[1].systemPrompt, /one-minute warning/i);
        assert.match(prompts[2].systemPrompt, /kickoff time has arrived/i);
        assert.equal(prompts.length, 3);
        assert.doesNotMatch(`${scheduled}\n${reminder}\n${kickoff}`, /@everyone|@here/);
    } finally {
        Math.random = originalRandom;
    }
});
