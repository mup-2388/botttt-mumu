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

class SlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addStringOption(callback) {
        const option = {
            setName() { return this; },
            setDescription() { return this; },
            setRequired() { return this; }
        };
        callback(option);
        return this;
    }
}

const emojiCatalog = require('../utils/ai/emojiCatalog');
const { slotEmoji } = require('../utils/ai/emojiSlots');
const { sanitizeAIText } = require('../utils/aiGuard');

const BLOCKED_ID = '1486727534576930846';
const OTHER_EFOOTBALL_ID = '155000000000000001';
const GOAL_ID = '155000000000000002';

test('eFootball emoji is excluded from catalog, goal slots, AI hints, and user favorites', () => {
    const guild = {
        id: 'guild-1',
        name: 'Test League',
        emojis: {
            cache: new Map([
                ['blocked-id', { id: BLOCKED_ID, name: 'footballg', animated: true }],
                ['blocked-name', { id: OTHER_EFOOTBALL_ID, name: 'eFootball2026', animated: false }],
                ['goal', { id: GOAL_ID, name: 'goal', animated: false }]
            ])
        }
    };

    const indexed = emojiCatalog.initEmojiCatalog({
        guilds: { cache: new Map([[guild.id, guild]]) }
    });

    assert.equal(indexed, 1);
    assert.deepEqual(emojiCatalog.emojisFor(guild.id).map(emoji => emoji.ref), [`<:goal:${GOAL_ID}>`]);
    assert.equal(slotEmoji('goals', guild.id), `<:goal:${GOAL_ID}>`);
    assert.doesNotMatch(emojiCatalog.emojiHint('football goals', guild.id), /footballg|eFootball|1486727534576930846/);

    emojiCatalog.learnUserEmojis(
        guild.id,
        'user-1',
        `<a:footballg:${BLOCKED_ID}> <:eFootball2026:${OTHER_EFOOTBALL_ID}> <:goal:${GOAL_ID}>`
    );

    assert.deepEqual(emojiCatalog.userTopEmojis(guild.id, 'user-1', 10), [`<:goal:${GOAL_ID}>`]);
    assert.deepEqual(emojiCatalog.guildFavourites(guild.id, 10), [`<:goal:${GOAL_ID}>`]);
});

test('AI output sanitization removes blocked eFootball emoji markup but keeps unrelated emojis', () => {
    const result = sanitizeAIText(
        `Score: <a:footballg:${BLOCKED_ID}> <:eFootball2026:${OTHER_EFOOTBALL_ID}> <:goal:${GOAL_ID}>`,
        { maxUserPings: 0 }
    );

    assert.doesNotMatch(result.text, /footballg|eFootball|1486727534576930846/);
    assert.match(result.text, new RegExp(`<:goal:${GOAL_ID}>`));
});

test('.nm match scores are shown without flanking goal/eFootball emojis', () => {
    const command = requireWithMocks('../commands/tournament/nextmatch', {
        'discord.js': {
            EmbedBuilder: class {},
            SlashCommandBuilder,
            ActionRowBuilder: class {},
            ButtonBuilder: class {},
            ButtonStyle: {},
            StringSelectMenuBuilder: class {}
        },
        '../../models/Tournament': { Fixture: {}, Team: {}, Player: {}, TournamentTeam: {} },
        '../../utils/getTournament': {},
        '../../utils/displayHelpers': { prettyPhase: phase => phase || 'League' },
        '../../utils/ai/emojiSlots': {
            slotEmoji: () => `<a:footballg:${BLOCKED_ID}>`,
            vsLine: (home, away) => `${home} vs ${away}`
        },
        '../../utils/reservedMatches': { isReserved: () => false, reservedBadge: () => '' },
        '../../utils/tournamentContext': { resolveUserTeam: async () => null },
        '../../utils/stringHelpers': { escapeRegex: value => value }
    });

    const line = command.buildFixtureLine({
        guildId: 'guild-1',
        homeTeam: 'Falcons',
        awayTeam: 'Tigers',
        status: 'Played',
        phase: 'final',
        roundLabel: 'Final',
        result: { home: 2, away: 1 }
    }, 1, 'Falcons');

    assert.match(line, /2-1/);
    assert.doesNotMatch(line, /footballg|1486727534576930846|⚽/i);
});
