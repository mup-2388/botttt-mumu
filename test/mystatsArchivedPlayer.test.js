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
    addUserOption(configure) { configure(new FakeOption()); return this; }
}

function loadCommand({ currentPlayer = null, archivedPlayer = null } = {}) {
    const calls = { current: [], archive: [] };
    const command = requireWithMocks('../commands/tournament/mystats', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            EmbedBuilder: class {},
            ActionRowBuilder: class {},
            StringSelectMenuBuilder: class {},
            ButtonBuilder: class {},
            ButtonStyle: {}
        },
        '../../models/Tournament': {
            Player: {
                findOne: query => {
                    calls.current.push(query);
                    return { populate: async field => {
                        assert.equal(field, 'teamId');
                        return currentPlayer;
                    } };
                }
            },
            PlayerArchive: {
                findOne: query => {
                    calls.archive.push(query);
                    return {
                        sort(sort) {
                            assert.deepEqual(sort, { archivedAt: -1 });
                            return this;
                        },
                        lean: async () => archivedPlayer
                    };
                }
            }
        },
        '../../utils/getTournament': {},
        '../../utils/getEvent': {},
        '../../utils/stringHelpers': {},
        '../../utils/displayHelpers': {}
    });

    return { command, calls };
}

test('mystats resolves a removed player from the non-operational archive using the historical player ID', async () => {
    const archivedPlayer = {
        guildId: 'guild-1',
        originalPlayerId: 'player-old-id',
        name: 'Archived Player',
        discordID: 'user-1',
        discordUsername: 'archived',
        formerTeamName: 'Old Team',
        stats: { played: 10, goals: 6 }
    };
    const { command, calls } = loadCommand({ archivedPlayer });

    const player = await command.findStatsPlayer('guild-1', 'user-1');

    assert.deepEqual(calls.current, [{ guildId: 'guild-1', discordID: 'user-1' }]);
    assert.deepEqual(calls.archive, [{ guildId: 'guild-1', discordID: 'user-1' }]);
    assert.equal(player._id, 'player-old-id');
    assert.equal(player.name, 'Archived Player');
    assert.equal(player.discordID, 'user-1');
    assert.equal(player.teamId, null, 'archived identities do not re-enter live team/player operations');
    assert.deepEqual(player.stats, { played: 10, goals: 6 });
    assert.equal(player.isArchived, true);
});

test('mystats prefers a live Player record and does not fall back to an archive', async () => {
    const currentPlayer = { _id: 'player-current', name: 'Current Player' };
    const { command, calls } = loadCommand({
        currentPlayer,
        archivedPlayer: { originalPlayerId: 'player-old' }
    });

    const player = await command.findStatsPlayer('guild-1', 'user-1');

    assert.equal(player, currentPlayer);
    assert.equal(calls.archive.length, 0);
});

test('mystats still returns no profile when neither a live nor archived player exists', async () => {
    const { command } = loadCommand();
    assert.equal(await command.findStatsPlayer('guild-1', 'user-1'), null);
});
