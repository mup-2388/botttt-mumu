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
    setName(value) { this.name = value; return this; }
    setDescription(value) { this.description = value; return this; }
    setRequired(value) { this.required = value; return this; }
    addChoices(...choices) { this.choices = choices.flat(); return this; }
}

class FakeSlashCommandBuilder {
    constructor() { this.options = []; }
    setName(value) { this.name = value; return this; }
    setDescription(value) { this.description = value; return this; }
    addStringOption(configure) {
        const option = new FakeOption();
        configure(option);
        this.options.push(option);
        return this;
    }
    addBooleanOption(configure) {
        const option = new FakeOption();
        configure(option);
        this.options.push(option);
        return this;
    }
}

class FakeEmbedBuilder {
    constructor() { this.fields = []; }
    setColor(value) { this.color = value; return this; }
    setTitle(value) { this.title = value; return this; }
    setDescription(value) { this.description = value; return this; }
    setFooter(value) { this.footer = value; return this; }
    addFields(...fields) { this.fields.push(...fields.flat()); return this; }
    setTimestamp() { return this; }
}

function fakeDiscord() {
    return {
        SlashCommandBuilder: FakeSlashCommandBuilder,
        PermissionFlagsBits: { SendMessages: 1n, ManageRoles: 2n },
        EmbedBuilder: FakeEmbedBuilder
    };
}

test('teamrolecolors persists a server-specific off setting and explains color preservation', async () => {
    const updates = [];
    const command = requireWithMocks('../commands/tournament/teamrolecolors', {
        'discord.js': fakeDiscord(),
        '../../models/Tournament': {
            ServerConfig: {
                findOneAndUpdate: async (...args) => { updates.push(args); }
            }
        },
        '../../utils/isOrganizer': { isOrganizer: async () => true }
    });
    const replies = [];
    const message = {
        guild: { id: 'guild-1' },
        author: { id: 'organizer-1' },
        reply: async payload => { replies.push(payload); return payload; }
    };

    await command.execute(message, ['off']);

    assert.deepEqual(updates[0][0], { guildId: 'guild-1' });
    assert.deepEqual(updates[0][1], { $set: { teamRoleColorsEnabled: false } });
    assert.equal(updates[0][2].upsert, true);
    assert.match(replies[0].embeds[0].description, /`\/setcolor` is blocked/);
    assert.match(replies[0].embeds[0].description, /Existing Discord role colors are preserved/);
    assert.equal(command.data.options[0].choices.find(choice => choice.value === 'off').name, 'Disable color changes');
});

test('setcolor exits without resolving or saving a team when server color changes are disabled', async () => {
    let resolveCalls = 0;
    const replies = [];
    const command = requireWithMocks('../commands/tournament/setcolor', {
        'discord.js': fakeDiscord(),
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../models/Tournament': {
            ServerConfig: {
                findOne: filter => ({
                    lean: async () => {
                        assert.deepEqual(filter, { guildId: 'guild-2' });
                        return { teamRoleColorsEnabled: false };
                    }
                })
            }
        },
        '../../utils/teamResolver': {
            resolveManagedTeamInTournament: async () => {
                resolveCalls++;
                throw new Error('team resolver should not run when colors are disabled');
            }
        },
        '../../utils/getTournament': {
            extractTournamentFromArgs: async () => ({}),
            resolveTournament: async () => ({ tournament: null })
        },
        '../../utils/tournamentContext': { parseTeamTokenInTournament: async () => ({}) }
    });

    await command.runSetColor({
        guild: { id: 'guild-2' },
        userId: 'captain-1',
        organizer: false,
        teamName: 'Falcons',
        colorInput: '#FF0000',
        reply: async payload => { replies.push(payload); return payload; }
    });

    assert.equal(resolveCalls, 0);
    assert.match(replies[0].content, /color changes are disabled/);
    assert.match(replies[0].content, /Existing role colors are being preserved/);
});

test('teamrolessync preserves role colors while still adding missing team members', async () => {
    const edits = [];
    const roleColor = 0x123456;
    let setColorCalls = 0;
    let addCalls = 0;
    const role = {
        name: 'Falcons',
        color: roleColor,
        position: 1,
        members: [],
        setColor: async () => {
            setColorCalls++;
            throw new Error('role color must not be changed');
        }
    };
    const member = {
        id: 'discord-player-1',
        user: { bot: false },
        roles: {
            highest: { position: 2 },
            add: async addedRole => {
                assert.equal(addedRole, role);
                addCalls++;
            },
            remove: async () => {}
        }
    };
    const playerQuery = {
        select() { return this; },
        lean: async () => [{ discordID: 'discord-player-1' }]
    };
    const rosterQuery = {
        select() { return this; },
        lean: async () => []
    };
    const command = requireWithMocks('../commands/tournament/teamrolessync', {
        'discord.js': {
            ...fakeDiscord(),
            ActionRowBuilder: class {},
            StringSelectMenuBuilder: class {},
            ButtonBuilder: class {},
            ButtonStyle: {},
            ComponentType: {},
            MessageFlags: {},
            Colors: {}
        },
        '../../models/Tournament': {
            Team: { find: () => ({ lean: async () => [{ _id: 'team-1', name: 'Falcons', color: '#FF0000' }] }) },
            Player: {
                find: filter => {
                    if (filter?._id) return { select() { return this; }, lean: async () => [] };
                    return playerQuery;
                }
            },
            TournamentPlayer: { find: () => rosterQuery },
            ServerConfig: {
                findOne: () => ({ lean: async () => ({ teamRoleColorsEnabled: false }) })
            }
        },
        '../../utils/isOrganizer': { OWNER_IDS: [], isOrganizer: async () => true }
    });

    const guild = {
        id: 'guild-3',
        ownerId: 'guild-owner',
        members: {
            me: {
                roles: { highest: { position: 10 } },
                permissions: { has: () => true }
            },
            fetch: async id => id === member.id ? member : null
        },
        roles: { cache: { find: predicate => predicate(role) ? role : undefined } }
    };
    const progressMessage = {
        edit: async payload => { edits.push(payload); return payload; }
    };

    await command.runSync({
        guild,
        reply: async () => progressMessage
    });

    assert.equal(setColorCalls, 0, 'disabled sync must not call Discord role.setColor');
    assert.equal(role.color, roleColor, 'the existing Discord role color remains unchanged');
    assert.equal(addCalls, 1, 'membership sync still adds the missing member');
    const finalEmbed = edits.at(-1).embeds[0];
    assert.match(finalEmbed.fields.find(field => field.name === 'Team-role colors').value, /left untouched/);
    assert.match(finalEmbed.description, /\+1 added/);
});
