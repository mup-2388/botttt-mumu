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
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    setRequired(required) { this.required = required; return this; }
}

class FakeSlashCommandBuilder {
    constructor() { this.options = []; }
    setName(name) { this.name = name; return this; }
    setDescription(description) { this.description = description; return this; }
    addBooleanOption(configure) {
        const option = configure(new FakeOption());
        this.options.push(option);
        return this;
    }
}

class FakeEmbedBuilder {
    setColor(color) { this.color = color; return this; }
    setTitle(title) { this.title = title; return this; }
    setDescription(description) { this.description = description; return this; }
    addFields(...fields) { this.fields = fields.flat(); return this; }
    setFooter(footer) { this.footer = footer; return this; }
    setTimestamp() { return this; }
}

function queryResult(value) {
    return {
        select() { return this; },
        sort() { return this; },
        lean: async () => value
    };
}

function makeCommand({
    teams,
    players,
    activeTournaments = [{ _id: 'tournament-1' }],
    playerCount = players.filter(player => player.teamId).length,
    tournamentTeamCount = 2,
    fixtureCount = 3,
    archiveFailureFor = null,
    teamFailureFor = null
}) {
    const replies = [];
    const mutations = {
        archiveBatches: [],
        playerDeletes: [],
        tournamentTeamUpdates: [],
        fixtureUpdates: [],
        teamDeletes: [],
        preservedModelsTouched: []
    };

    const models = {
        Team: {
            find: filter => {
                assert.deepEqual(filter, { guildId: 'guild-1' });
                return queryResult(teams);
            },
            deleteOne: async filter => {
                mutations.teamDeletes.push(filter);
                const team = teams.find(candidate => candidate._id === filter._id);
                if (team?.name === teamFailureFor) throw new Error('team delete unavailable');
                return { deletedCount: team ? 1 : 0 };
            }
        },
        Player: {
            countDocuments: async filter => {
                assert.deepEqual(filter, {
                    guildId: 'guild-1',
                    teamId: { $in: teams.map(team => team._id) }
                });
                return playerCount;
            },
            find: filter => {
                assert.equal(filter.guildId, 'guild-1');
                return queryResult(players.filter(player => player.teamId === filter.teamId));
            },
            deleteMany: async filter => {
                mutations.playerDeletes.push(filter);
                return { deletedCount: filter._id.$in.length };
            }
        },
        PlayerArchive: {
            bulkWrite: async operations => {
                mutations.archiveBatches.push(operations);
                const teamName = operations[0]?.updateOne?.update?.$setOnInsert?.formerTeamName;
                if (teamName === archiveFailureFor) throw new Error('archive unavailable');
                return { upsertedCount: operations.length };
            }
        },
        TournamentSettings: {
            find: filter => {
                assert.deepEqual(filter, {
                    guildId: 'guild-1',
                    currentPhase: { $ne: 'completed' }
                });
                return queryResult(activeTournaments);
            }
        },
        TournamentTeam: {
            countDocuments: async () => tournamentTeamCount,
            updateMany: async filter => {
                mutations.tournamentTeamUpdates.push(filter);
                return { modifiedCount: 1 };
            }
        },
        Fixture: {
            countDocuments: async () => fixtureCount,
            updateMany: async filter => {
                mutations.fixtureUpdates.push(filter);
                return { modifiedCount: 1 };
            }
        },
        // These models are intentionally observed: bulk cleanup must preserve
        // tournament/event player history and UserProfile data as-is.
        TournamentPlayer: {
            updateMany: async () => mutations.preservedModelsTouched.push('TournamentPlayer')
        },
        EventPlayer: {
            updateMany: async () => mutations.preservedModelsTouched.push('EventPlayer')
        },
        UserProfile: {
            updateMany: async () => mutations.preservedModelsTouched.push('UserProfile')
        }
    };

    const command = requireWithMocks('../commands/tournament/delete-all-teams', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1n },
            EmbedBuilder: FakeEmbedBuilder,
            escapeMarkdown: value => String(value)
        },
        '../../models/Tournament': models,
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/getTournament': { getDefaultTournament: async () => null },
        '../../utils/optionalStep': { optionalStep: async (_label, step, fallback) => {
            try { return await step(); } catch { return fallback; }
        } }
    });

    return { command, replies, mutations };
}

const teams = [
    { _id: 'team-1', name: 'Falcons', captainID: 'captain-1' },
    { _id: 'team-2', name: 'Wolves', captainID: 'captain-2' }
];

const players = [
    {
        _id: 'player-1',
        guildId: 'guild-1',
        name: 'Player One',
        discordID: 'discord-1',
        teamId: 'team-1',
        stats: { played: 9, goals: 4 }
    },
    {
        _id: 'player-2',
        guildId: 'guild-1',
        name: 'Player Two',
        discordID: 'discord-2',
        teamId: 'team-1',
        stats: { played: 3, goals: 2 }
    },
    {
        _id: 'player-3',
        guildId: 'guild-1',
        name: 'Player Three',
        discordID: 'discord-3',
        teamId: 'team-2',
        stats: { played: 12, goals: 7 }
    },
    {
        _id: 'free-agent',
        guildId: 'guild-1',
        name: 'Existing Free Agent',
        discordID: 'discord-free',
        teamId: null,
        stats: { played: 0, goals: 0 }
    }
];

test('delete-all-teams previews exact scope, then archives/removes team players without making free agents', async () => {
    const { command, replies, mutations } = makeCommand({ teams, players });

    assert.equal(command.name, 'delete-all-teams');
    assert.equal(command.hidden, true, 'destructive slash command should not displace visible commands at the global cap');
    assert.equal(command.data.options[0].name, 'confirm');
    assert.equal(command.data.options[0].required, true);

    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1', tag: 'Organizer' },
        reply: async payload => {
            replies.push(payload);
            return payload;
        }
    };

    await command.execute(message, []);

    assert.equal(mutations.archiveBatches.length, 0, 'preview must not archive or mutate anything');
    assert.equal(mutations.playerDeletes.length, 0);
    assert.equal(mutations.teamDeletes.length, 0);
    assert.match(replies[0].embeds[0].title, /PREVIEW/);
    assert.match(replies[0].embeds[0].description, /Global teams in this server: \*\*2\*\*/);
    assert.match(replies[0].embeds[0].description, /Global player profiles to remove: \*\*3\*\*/);
    assert.match(replies[0].embeds[0].description, /Active tournament-team entries to deactivate: \*\*2\*\*/);
    assert.match(replies[0].embeds[0].description, /Unplayed fixtures to cancel: \*\*3\*\*/);
    assert.match(replies[0].embeds[0].fields[0].value, /will \*\*not\*\* become free agents/i);
    assert.match(replies[0].embeds[0].fields[1].value, /tournament\/event player rows and stats.*played fixtures/i);

    await command.execute(message, ['confirm']);

    assert.equal(mutations.archiveBatches.length, 2);
    assert.equal(mutations.archiveBatches.flat().length, 3, 'only players attached to the deleted teams should be archived');
    const archiveOperations = mutations.archiveBatches.flat();
    assert.deepEqual(
        archiveOperations.map(operation => operation.updateOne.update.$setOnInsert.originalPlayerId).sort(),
        ['player-1', 'player-2', 'player-3']
    );
    assert.deepEqual(
        archiveOperations.find(operation => operation.updateOne.update.$setOnInsert.originalPlayerId === 'player-1')
            .updateOne.update.$setOnInsert.stats,
        { played: 9, goals: 4 },
        'the original Player stats must be preserved before the live record is removed'
    );
    assert.deepEqual(mutations.playerDeletes.map(filter => filter._id.$in).flat().sort(), [

        'player-1', 'player-2', 'player-3'
    ]);
    assert.deepEqual(mutations.teamDeletes.map(filter => filter._id), ['team-1', 'team-2']);
    assert.equal(mutations.tournamentTeamUpdates.length, 2);
    assert.equal(mutations.fixtureUpdates.length, 2);
    assert.equal(mutations.preservedModelsTouched.length, 0);

    const result = replies[1].embeds[0];
    assert.match(result.title, /SERVER TEAMS REMOVED/);
    assert.match(result.description, /Global Player records removed: \*\*3\*\*/);
    assert.match(result.description, /Player stat snapshots preserved: \*\*3\*\*/);
    assert.match(result.description, /not\*\* converted to free agents/);
    assert.match(result.description, /all-time profiles, trophies, awards, and played results were left intact/);
});

test('slash delete-all-teams previews on false and requires true to run cleanup', async () => {
    const { command, replies, mutations } = makeCommand({
        teams: [teams[0]],
        players: [],
        activeTournaments: [],
        playerCount: 0,
        tournamentTeamCount: 0,
        fixtureCount: 0
    });
    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1', tag: 'Organizer' },
        options: { getBoolean: () => false },
        deferReply: async function () { this.deferred = true; },
        editReply: async payload => {
            replies.push(payload);
            return payload;
        },
        deferred: false,
        replied: false
    };

    await command.slashExecute(interaction);
    assert.equal(mutations.teamDeletes.length, 0);
    assert.match(replies[0].embeds[0].title, /PREVIEW/);

    interaction.options.getBoolean = () => true;
    await command.slashExecute(interaction);
    assert.deepEqual(mutations.teamDeletes.map(filter => filter._id), ['team-1']);
    assert.match(replies[1].embeds[0].title, /SERVER TEAMS REMOVED/);
});

test('delete-all-teams stops before removing a team player if archival fails', async () => {
    const { command, replies, mutations } = makeCommand({
        teams,
        players,
        archiveFailureFor: 'Wolves'
    });
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1', tag: 'Organizer' },
        reply: async payload => {
            replies.push(payload);
            return payload;
        }
    };

    await command.execute(message, ['confirm']);

    assert.deepEqual(mutations.teamDeletes.map(filter => filter._id), ['team-1']);
    assert.deepEqual(mutations.playerDeletes.map(filter => filter._id.$in), [['player-1', 'player-2']]);
    assert.equal(mutations.archiveBatches.length, 2);
    assert.match(replies[0].embeds[0].title, /PARTIALLY COMPLETED/);
    assert.match(replies[0].embeds[0].description, /\*\*1\*\* of \*\*2\*\*/);
    assert.match(replies[0].embeds[0].description, /Wolves/);
});
