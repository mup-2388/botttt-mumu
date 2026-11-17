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

function makeCommand({ teams, deleteTeam }) {
    const replies = [];
    const command = requireWithMocks('../commands/tournament/delete-all-teams', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1n },
            EmbedBuilder: FakeEmbedBuilder,
            escapeMarkdown: value => String(value)
        },
        '../../models/Tournament': {
            Team: {
                find: filter => {
                    assert.deepEqual(filter, { guildId: 'guild-1' });
                    return {
                        select() { return this; },
                        sort() { return this; },
                        lean: async () => teams
                    };
                }
            },
            Player: {
                countDocuments: async filter => {
                    assert.deepEqual(filter, {
                        guildId: 'guild-1',
                        teamId: { $in: teams.map(team => team._id) }
                    });
                    return 4;
                }
            }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        './delete-team': { runDeleteTeam: deleteTeam }
    });

    return { command, replies };
}

test('delete-all-teams previews without mutation, then deletes each current-server team through the safe single-team flow', async () => {
    const teams = [
        { _id: 'team-1', name: 'Falcons' },
        { _id: 'team-2', name: 'Wolves' }
    ];
    const deletedTeams = [];
    const { command, replies } = makeCommand({
        teams,
        deleteTeam: async ({ guild, teamName, reply }) => {
            assert.equal(guild.id, 'guild-1');
            assert.equal(typeof reply, 'function');
            deletedTeams.push(teamName);
            return null;
        }
    });

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

    assert.equal(deletedTeams.length, 0, 'preview must be read-only');
    assert.match(replies[0].embeds[0].title, /PREVIEW/);
    assert.match(replies[0].embeds[0].description, /Teams in this server: \*\*2\*\*/);
    assert.match(replies[0].embeds[0].description, /Players to detach as free agents: \*\*4\*\*/);
    assert.match(replies[0].embeds[0].fields[0].value, /player stats.*awards are preserved/i);

    await command.execute(message, ['confirm']);

    assert.deepEqual(deletedTeams, ['Falcons', 'Wolves']);
    assert.match(replies[1].embeds[0].title, /SERVER TEAMS REMOVED/);
    assert.match(replies[1].embeds[0].description, /Player records deleted: \*\*0\*\*/);
    assert.match(replies[1].embeds[0].description, /awards were not deleted/i);
});

test('slash delete-all-teams requires an explicit true value before invoking deletion', async () => {
    const teams = [{ _id: 'team-1', name: 'Falcons' }];
    const deletedTeams = [];
    const { command, replies } = makeCommand({
        teams,
        deleteTeam: async ({ teamName }) => { deletedTeams.push(teamName); }
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
    assert.deepEqual(deletedTeams, []);
    assert.match(replies[0].embeds[0].title, /PREVIEW/);

    interaction.options.getBoolean = () => true;
    await command.slashExecute(interaction);
    assert.deepEqual(deletedTeams, ['Falcons']);
    assert.match(replies[1].embeds[0].title, /SERVER TEAMS REMOVED/);
});

test('delete-all-teams reports partial progress and stops if one team cleanup fails', async () => {
    const teams = [
        { _id: 'team-1', name: 'Falcons' },
        { _id: 'team-2', name: 'Wolves' },
        { _id: 'team-3', name: 'Tigers' }
    ];
    const attemptedTeams = [];
    const { command, replies } = makeCommand({
        teams,
        deleteTeam: async ({ teamName }) => {
            attemptedTeams.push(teamName);
            if (teamName === 'Wolves') throw new Error('database unavailable');
        }
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

    assert.deepEqual(attemptedTeams, ['Falcons', 'Wolves']);
    assert.match(replies[0].embeds[0].title, /PARTIALLY COMPLETED/);
    assert.match(replies[0].embeds[0].description, /\*\*1\*\* of \*\*3\*\*/);
    assert.match(replies[0].embeds[0].description, /Wolves/);
});
