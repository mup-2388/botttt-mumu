const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class FakeOption {
    setName(value) { this.name = value; return this; }
    setDescription(value) { this.description = value; return this; }
    setRequired(value) { this.required = value; return this; }
    setAutocomplete(value) { this.autocomplete = value; return this; }
    setMaxLength(value) { this.maxLength = value; return this; }
    setMinValue(value) { this.minValue = value; return this; }
    setMaxValue(value) { this.maxValue = value; return this; }
    addChoices(...values) { this.choices = values; return this; }
    addChannelTypes(...values) { this.channelTypes = values; return this; }
}

class FakeSubcommand extends FakeOption {
    constructor() { super(); this.options = []; }
    addStringOption(callback) { return this.addOption(callback); }
    addIntegerOption(callback) { return this.addOption(callback); }
    addRoleOption(callback) { return this.addOption(callback); }
    addChannelOption(callback) { return this.addOption(callback); }
    addBooleanOption(callback) { return this.addOption(callback); }
    addOption(callback) {
        const option = new FakeOption();
        callback(option);
        this.options.push(option);
        return this;
    }
}

class FakeSlashCommandBuilder extends FakeOption {
    constructor() { super(); this.options = []; }
    setName(value) { this.name = value; return this; }
    addSubcommand(callback) {
        const subcommand = new FakeSubcommand();
        callback(subcommand);
        this.options.push(subcommand);
        return this;
    }
    toJSON() { return { name: this.name, description: this.description, options: this.options }; }
}

function requireCommand(file, mocks) {
    const resolvedPath = require.resolve(file);
    const originalLoad = Module._load;
    delete require.cache[resolvedPath];
    Module._load = function (request, parent, isMain) {
        if (parent?.filename === resolvedPath && Object.hasOwn(mocks, request)) return mocks[request];
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return require(resolvedPath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[resolvedPath];
    }
}

const discord = {
    SlashCommandBuilder: FakeSlashCommandBuilder,
    PermissionFlagsBits: { ManageRoles: 1n },
    ChannelType: { GuildText: 0, GuildAnnouncement: 5 }
};

test('selfroles slash command exposes setup, advanced rules, publishing, and lifecycle actions', () => {
    const command = requireCommand('../commands/roles/selfroles', {
        'discord.js': discord,
        '../../utils/selfRoles': { runAdminAction: async () => '', getPanelByKey: async () => null },
        '../../models/SelfRoles': { SelfRolePanel: { find: async () => [] } },
        '../../utils/selfRoleRules': require('../utils/selfRoleRules')
    });
    const names = command.data.options.map(option => option.name);
    assert.deepEqual(names, [
        'create', 'group', 'role', 'remove-role', 'remove-group', 'access', 'clear-access',
        'audit', 'publish', 'preview', 'edit', 'clone', 'pause', 'resume', 'delete', 'list'
    ]);
    const publish = command.data.options.find(option => option.name === 'publish');
    const preview = command.data.options.find(option => option.name === 'preview');
    assert.ok(!publish.options.some(option => option.name === 'mode'));
    assert.ok(!preview.options.some(option => option.name === 'mode'));
    assert.match(command.description, /reaction/i);

    const role = command.data.options.find(option => option.name === 'role');
    assert.ok(role.options.some(option => option.name === 'duration'));
    assert.ok(role.options.some(option => option.name === 'exclude_role'));
    assert.equal(role.options.filter(option => option.name.startsWith('bundle_role')).length, 4);
    for (const subcommand of command.data.options) {
        let optionalSeen = false;
        for (const option of subcommand.options) {
            if (!option.required) optionalSeen = true;
            else assert.equal(optionalSeen, false, `${subcommand.name}.${option.name} must precede optional options`);
        }
    }
});

test('roleprefs is a separate slash command and role option parsing handles durations and bundles', () => {
    const rolePrefs = requireCommand('../commands/roles/roleprefs', {
        'discord.js': discord,
        '../../utils/selfRoles': { buildRolePrefsPayload: async () => ({}) }
    });
    assert.equal(rolePrefs.data.name, 'roleprefs');

    const command = requireCommand('../commands/roles/selfroles', {
        'discord.js': discord,
        '../../utils/selfRoles': { runAdminAction: async () => '', getPanelByKey: async () => null },
        '../../models/SelfRoles': { SelfRolePanel: { find: async () => [] } },
        '../../utils/selfRoleRules': require('../utils/selfRoleRules')
    });
    const roles = {
        role: { id: 'role-1' },
        bundle_role: { id: 'bundle-1' },
        bundle_role_three: { id: 'bundle-3' }
    };
    const values = { panel: 'community', group: 'interests', label: 'Football', duration: '12h' };
    const interaction = {
        options: {
            getString: name => values[name] ?? null,
            getRole: name => roles[name] ?? null
        }
    };
    const parsed = command.parseSlashOptions(interaction, 'role');
    assert.equal(parsed.panelKey, 'community');
    assert.equal(parsed.durationMs, 12 * 60 * 60 * 1000);
    assert.deepEqual(parsed.bundleRoleIds, ['bundle-1', 'bundle-3']);
});

function makeWizardHarness(replies) {
    const role = { id: '111111111111111111', name: 'Gaming' };
    const channel = {
        id: 'channel-1',
        guildId: 'guild-1',
        name: 'roles',
        type: 0,
        send: async payload => sent.push(payload),
        awaitMessages: async options => {
            assert.equal(options.max, 1);
            assert.equal(options.time, 180_000);
            const response = replies.shift();
            if (response === 'timeout') throw new Error('time');
            if (!response) throw new Error('no fake response available');
            const reply = typeof response === 'string' ? response : response.content;
            const message = {
                content: reply,
                author: { id: 'moderator-1' },
                channelId: 'channel-1',
                mentions: {
                    roles: {
                        first: () => reply === '<@&111111111111111111>' ? role : null,
                        values: () => []
                    },
                    channels: { first: () => null }
                }
            };
            assert.equal(options.filter(message), true);
            return { first: () => message };
        }
    };
    const sent = [];
    const actions = [];
    const panelDefinitions = [];
    const selfRoles = {
        getPanelByKey: async () => null,
        runAdminAction: async action => { actions.push(action); return `completed ${action.action}`; },
        validateAssignableRole: async () => role,
        validatePanelDefinition: (panel, mode) => panelDefinitions.push({ panel, mode }),
        getEmojiDescriptor: emoji => ({ key: emoji, reactionValue: emoji, display: emoji })
    };
    const command = requireCommand('../commands/roles/selfroles', {
        'discord.js': discord,
        '../../utils/selfRoles': selfRoles,
        '../../models/SelfRoles': { SelfRolePanel: { find: async () => [] } },
        '../../utils/selfRoleRules': require('../utils/selfRoleRules')
    });
    const guild = {
        id: 'guild-1',
        roles: { cache: new Map([[role.id, role]]) },
        channels: { cache: new Map([[channel.id, channel]]) }
    };
    const message = {
        guild,
        channel,
        author: { id: 'moderator-1' },
        member: { permissions: { has: permission => permission === discord.PermissionFlagsBits.ManageRoles } },
        client: {},
        reply: async content => sent.push(content)
    };
    return { command, message, sent, actions, panelDefinitions, role, channel };
}

test('bare .selfroles guides setup and saves custom reaction-role wording before publishing', async () => {
    const replies = [
        'Community roles',
        'React to opt in for community updates.',
        '#123ABC',
        'here',
        'Interests',
        'single',
        '<@&111111111111111111>',
        '🎮',
        'Gaming',
        'A custom explanation for this role.',
        '12h',
        '-',
        'no',
        'publish'
    ];
    const { command, message, sent, actions, panelDefinitions, channel } = makeWizardHarness(replies);
    await command.execute(message, []);

    assert.deepEqual(actions.map(action => action.action), ['create', 'group', 'role', 'edit', 'publish']);
    assert.equal(actions[0].options.title, 'Community roles');
    assert.equal(actions[0].options.description, 'React to opt in for community updates.');
    assert.equal(actions[1].options.mode, 'single');
    assert.equal(actions[2].options.description, 'A custom explanation for this role.');
    assert.equal(actions[2].options.emoji, '🎮');
    assert.equal(actions[2].options.durationMs, 12 * 60 * 60 * 1000);
    assert.equal(actions[4].options.channel, channel);
    assert.equal(actions[3].options.color, '#123abc');
    assert.equal(panelDefinitions[0].mode, 'reactions');
    assert.ok(sent.some(payload => typeof payload === 'object' && payload.allowedMentions?.parse?.length === 0));
    assert.match(sent.at(-1).content, /completed publish/);
});

test('guided setup can be cancelled or time out without saving a partial panel', async () => {
    const cancelled = makeWizardHarness(['Community roles', 'cancel']);
    await cancelled.command.execute(cancelled.message, []);
    assert.deepEqual(cancelled.actions, []);
    assert.match(cancelled.sent.at(-1).content, /cancelled/i);

    const timedOut = makeWizardHarness(['timeout']);
    await timedOut.command.execute(timedOut.message, []);
    assert.deepEqual(timedOut.actions, []);
    assert.match(timedOut.sent.at(-1).content, /timed out/i);
});
