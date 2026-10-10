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
