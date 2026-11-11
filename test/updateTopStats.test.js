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

class FakeEmbedBuilder {
    constructor() { this.fields = []; }
    setColor(value) { this.color = value; return this; }
    setTitle(value) { this.title = value; return this; }
    setDescription(value) { this.description = value; return this; }
    setFooter(value) { this.footer = value; return this; }
    setTimestamp() { return this; }
    addFields(...fields) { this.fields.push(...fields.flat()); return this; }
}

test('live top stats adds a full-width G+A leaderboard without unbalancing the six-field grid', async () => {
    const players = [
        {
            playerNameSnapshot: 'Goal Scorer',
            playerId: { name: 'Goal Scorer' },
            stats: { goals: 5, assists: 0, played: 4 }
        },
        {
            playerNameSnapshot: 'Assist Leader',
            playerId: { name: 'Assist Leader' },
            stats: { goals: 0, assists: 5, played: 2 }
        },
        {
            playerNameSnapshot: 'Two-Way Player',
            playerId: { name: 'Two-Way Player' },
            stats: { goals: 3, assists: 3, played: 3 }
        },
        {
            playerNameSnapshot: 'No Contributions',
            playerId: { name: 'No Contributions' },
            stats: { goals: 0, assists: 0, played: 6 }
        }
    ];
    const live = {
        tournamentKey: 'hfsl-s4',
        channelId: 'channel-1',
        messageId: 'message-1'
    };
    let savedPayload;
    let tournamentFilter;
    const message = {
        edit: async payload => { savedPayload = payload; }
    };
    const channel = {
        messages: { fetch: async id => id === live.messageId ? message : null }
    };

    const { updateLiveTopStats } = requireWithMocks('../utils/updateTopStats', {
        'discord.js': { EmbedBuilder: FakeEmbedBuilder },
        '../models/Tournament': {
            TournamentPlayer: {
                find: filter => {
                    tournamentFilter = filter;
                    return {
                        populate() { return this; },
                        lean: async () => players
                    };
                }
            },
            TournamentSettings: {
                findOne: async filter => {
                    assert.deepEqual(filter, { guildId: 'guild-1', tournamentKey: live.tournamentKey });
                    return { _id: 'tournament-1', name: 'Hand Football Super League Season 4', tournamentKey: live.tournamentKey };
                }
            }
        },
        '../models/LiveMessage': {
            find: async filter => {
                assert.deepEqual(filter, { guildId: 'guild-1', type: 'topstats' });
                return [live];
            }
        }
    });
    const client = { channels: { fetch: async id => id === live.channelId ? channel : null } };

    assert.equal(await updateLiveTopStats(client, 'guild-1'), true);
    assert.deepEqual(tournamentFilter, {
        guildId: 'guild-1',
        tournamentId: 'tournament-1',
        isActive: true
    });

    const embed = savedPayload.embeds[0];
    assert.equal(embed.title, '🏆 LIVE TOP STATS');
    assert.equal(embed.fields.length, 7);
    assert.deepEqual(embed.fields.slice(0, 6).map(field => field.inline), [true, true, true, true, true, true]);

    const gaField = embed.fields[6];
    assert.equal(gaField.name, '🔥 G+A');
    assert.equal(gaField.inline, false, 'G+A spans a full row instead of sitting alone in a three-column row');
    assert.match(gaField.value, /Two-Way Player — \*\*6\*\*/);
    assert.ok(gaField.value.indexOf('Assist Leader — **5**') < gaField.value.indexOf('Goal Scorer — **5**'));
    assert.doesNotMatch(gaField.value, /No Contributions/);
});
