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

class FakeBuilder {
    setColor(value) { this.color = value; return this; }
    setTitle(value) { this.title = value; return this; }
    setDescription(value) { this.description = value; return this; }
    setFooter(value) { this.footer = value; return this; }
    addFields(fields) { this.fields = fields; return this; }
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
    setPlaceholder() { return this; }
    setMinValues() { return this; }
    setMaxValues() { return this; }
    addOptions() { return this; }
    addComponents() { return this; }
}

const FLAGS = {
    Administrator: 1n,
    ManageGuild: 2n,
    ManageRoles: 4n,
    ManageChannels: 8n,
    ManageMessages: 16n,
    ManageWebhooks: 32n,
    KickMembers: 64n,
    BanMembers: 128n,
    ModerateMembers: 256n,
    ManageEvents: 512n,
    ManageNicknames: 1024n,
    MentionEveryone: 2048n,
    ViewChannel: 4096n,
    SendMessages: 8192n,
    EmbedLinks: 16384n,
    AddReactions: 32768n
};

function loadSelfRoles({ panelModel = {}, grantModel = {} } = {}) {
    return requireWithMocks('../utils/selfRoles', {
        'discord.js': {
            ActionRowBuilder: FakeBuilder,
            ButtonBuilder: FakeBuilder,
            ButtonStyle: { Primary: 1, Secondary: 2, Success: 3 },
            StringSelectMenuBuilder: FakeBuilder,
            EmbedBuilder: FakeBuilder,
            PermissionFlagsBits: FLAGS,
            ChannelType: { GuildText: 0, GuildAnnouncement: 5 },
            escapeMarkdown: text => String(text)
        },
        '../models/SelfRoles': {
            SelfRolePanel: panelModel,
            SelfRoleGrant: grantModel
        },
        './selfRoleRules': require('../utils/selfRoleRules')
    });
}

function makeGuild({ roles = [], member } = {}) {
    const roleCache = new Map(roles.map(role => [role.id, role]));
    const botMember = {
        permissions: { has: permission => permission === FLAGS.ManageRoles },
        roles: { highest: { position: 100 } }
    };
    const guild = {
        id: 'guild-1',
        roles: { cache: roleCache, fetch: async id => roleCache.get(id) || null },
        members: {
            me: botMember,
            fetch: async id => String(id) === member.id ? member : null
        },
        channels: { cache: new Map(), fetch: async () => null }
    };
    member.guild = guild;
    return guild;
}

function makeMember(userId, startingRoleIds = []) {
    const roleCache = new Map(startingRoleIds.map(id => [id, { id }]));
    const addCalls = [];
    const removeCalls = [];
    const member = {
        id: userId,
        roles: {
            cache: roleCache,
            add: async (roleId, reason) => {
                addCalls.push({ roleId: String(roleId), reason });
                roleCache.set(String(roleId), { id: String(roleId) });
                return member;
            },
            remove: async (roleId, reason) => {
                removeCalls.push({ roleId: String(roleId), reason });
                roleCache.delete(String(roleId));
                return member;
            }
        },
        addCalls,
        removeCalls
    };
    return member;
}

function safeRole(id, position = 1, permissions = []) {
    return {
        id,
        name: id,
        position,
        managed: false,
        permissions: { has: flag => permissions.includes(flag) }
    };
}

test('reaction panel validation requires a unique emoji for every option', () => {
    const service = loadSelfRoles();
    const panel = {
        groups: [{
            name: 'Alerts',
            mode: 'multiple',
            minSelections: 0,
            maxSelections: 0,
            options: [
                { roleId: '1', label: 'News', emoji: '' },
                { roleId: '2', label: 'Events', emoji: '' }
            ]
        }]
    };

    assert.throws(() => service.validatePanelDefinition(panel, 'reactions'), /Add an emoji/);

    panel.groups[0].options[0].emoji = '🔔';
    panel.groups[0].options[1].emoji = '🔔';
    assert.throws(() => service.validatePanelDefinition(panel, 'reactions'), /unique emoji/);

    panel.groups[0].options = Array.from({ length: 21 }, (_, index) => ({
        roleId: `role-${index}`, label: `Role ${index}`, emoji: `emoji-${index}`
    }));
    assert.throws(() => service.validatePanelDefinition(panel, 'reactions'), /at most 20/);
});

test('published reaction embeds preserve admin-written copy and contain no interactive components', () => {
    const service = loadSelfRoles();
    const panel = {
        title: 'Choose **your** roles',
        description: 'React below to opt in.\\nNo pings: @everyone.',
        color: 0,
        groups: [{
            name: 'Interests',
            options: [{
                roleId: 'role-1', label: 'Gaming', emoji: '🎮',
                description: 'Updates for **games** and tournaments.'
            }]
        }]
    };
    const payload = service.publicPanelPayload(panel);

    assert.deepEqual(payload.components, []);
    assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [] });
    assert.equal(payload.embeds[0].title, panel.title);
    assert.equal(payload.embeds[0].description, panel.description);
    assert.equal(payload.embeds[0].color, 0);
    assert.equal(payload.embeds[1].fields[0].value, 'Updates for **games** and tournaments.');
    assert.equal(payload.embeds[1].fields[0].name, 'Interests • 🎮 Gaming');
});

test('reaction emoji parsing rejects plain text and accepts Unicode or server custom emoji', () => {
    const service = loadSelfRoles();
    const emoji = { id: '123456789012345678', toString: () => '<:community:123456789012345678>' };
    const guild = { emojis: { cache: new Map([[emoji.id, emoji]]) } };

    assert.equal(service.getEmojiDescriptor('⭐', guild).key, '⭐');
    assert.equal(service.getEmojiDescriptor('<:community:123456789012345678>', guild).key, emoji.id);
    assert.throws(() => service.getEmojiDescriptor('not-an-emoji', guild), /one complete Unicode emoji/);
});

test('role preferences remain informational and direct members to panel reactions', async () => {
    const panels = [{
        key: 'community', title: 'Community', status: 'published',
        groups: [{ name: 'Interests', options: [{ roleId: 'role-1', label: 'Gaming' }] }]
    }];
    const panelModel = {
        find: () => ({
            sort() { return this; },
            limit() { return this; },
            lean: async () => panels
        })
    };
    const service = loadSelfRoles({ panelModel });
    const payload = await service.buildRolePrefsPayload(
        { id: 'guild-1' },
        { roles: { cache: new Map([['role-1', {}]]) } }
    );

    assert.deepEqual(payload.components, []);
    assert.match(payload.content, /react with the matching emoji/i);
    assert.match(payload.embeds[0].description, /Gaming/);
});

test('self-role assignment writes a timed grant and adds the role to the member', async () => {
    const roleId = '111111111111111111';
    const member = makeMember('user-1');
    const guild = makeGuild({ roles: [safeRole(roleId)], member });
    const savedGrants = [];
    const service = loadSelfRoles({
        grantModel: {
            exists: async () => false,
            updateOne: async (filter, update, options) => savedGrants.push({ filter, update, options })
        }
    });
    const group = {
        key: 'interests',
        name: 'Interests',
        mode: 'multiple',
        minSelections: 0,
        maxSelections: 0,
        options: [{ roleId, label: 'Football', bundleRoleIds: [], durationMs: 60 * 60 * 1000 }]
    };
    const panel = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', key: 'community', groups: [group], auditChannelId: '' };
    const now = Date.now();

    const result = await service.applyGroupSelection({
        guild,
        member,
        panel,
        group,
        visibleRoleIds: [roleId],
        selectedRoleIds: [roleId],
        client: {},
        source: 'components'
    });

    assert.equal(result.ok, true);
    assert.equal(member.roles.cache.has(roleId), true);
    assert.equal(member.addCalls.length, 1);
    assert.equal(savedGrants.length, 1);
    assert.equal(savedGrants[0].filter.roleId, roleId);
    assert.equal(savedGrants[0].update.$set.status, 'active');
    assert.equal(savedGrants[0].update.$set.removeOnExpire, true);
    assert.ok(savedGrants[0].update.$set.expiresAt instanceof Date);
    assert.ok(savedGrants[0].update.$set.expiresAt.getTime() >= now + 60 * 60 * 1000 - 1000);
});

test('a pre-existing bundled role is retained after its self-role bundle is deselected', async () => {
    const primaryRoleId = '333333333333333333';
    const manuallyHeldBundleRoleId = '444444444444444444';
    const member = makeMember('user-3', [manuallyHeldBundleRoleId]);
    const guild = makeGuild({
        roles: [safeRole(primaryRoleId), safeRole(manuallyHeldBundleRoleId)],
        member
    });
    const grants = [];
    const matches = (grant, filter) => {
        if (filter.roleId && grant.roleId !== String(filter.roleId)) return false;
        if (filter.status && grant.status !== filter.status) return false;
        if (filter._id?.$ne && grant._id === filter._id.$ne) return false;
        return true;
    };
    const grantModel = {
        exists: async filter => grants.some(grant => matches(grant, filter)),
        findOne: async filter => grants.find(grant =>
            grant.guildId === filter.guildId &&
            grant.userId === filter.userId &&
            grant.roleId === String(filter.roleId) &&
            grant.panelId === filter.panelId &&
            grant.groupKey === filter.groupKey &&
            grant.optionRoleId === String(filter.optionRoleId)
        ) || null,
        updateOne: async (filter, update) => {
            let grant = filter._id
                ? grants.find(item => item._id === filter._id)
                : grants.find(item =>
                    item.guildId === filter.guildId && item.userId === filter.userId &&
                    item.roleId === String(filter.roleId) && item.panelId === filter.panelId &&
                    item.groupKey === filter.groupKey && item.optionRoleId === String(filter.optionRoleId)
                );
            if (!grant) {
                grant = { ...filter, _id: `grant-${grants.length + 1}` };
                grants.push(grant);
            }
            Object.assign(grant, update.$set || {});
            return {};
        }
    };
    const service = loadSelfRoles({ grantModel });
    const group = {
        key: 'bundle',
        name: 'Bundle',
        mode: 'multiple',
        minSelections: 0,
        maxSelections: 0,
        options: [{ roleId: primaryRoleId, label: 'Primary', bundleRoleIds: [manuallyHeldBundleRoleId], durationMs: 0 }]
    };
    const panel = { _id: 'cccccccccccccccccccccccc', key: 'bundle-panel', groups: [group], auditChannelId: '' };

    const added = await service.applyGroupSelection({
        guild, member, panel, group,
        visibleRoleIds: [primaryRoleId],
        selectedRoleIds: [primaryRoleId],
        client: {}, source: 'components'
    });
    assert.equal(added.ok, true);
    const bundleGrant = grants.find(grant => grant.roleId === manuallyHeldBundleRoleId);
    assert.equal(bundleGrant.removeOnExpire, false);

    const removed = await service.applyGroupSelection({
        guild, member, panel, group,
        visibleRoleIds: [primaryRoleId],
        selectedRoleIds: [],
        client: {}, source: 'components'
    });
    assert.equal(removed.ok, true);
    assert.equal(member.roles.cache.has(primaryRoleId), false);
    assert.equal(member.roles.cache.has(manuallyHeldBundleRoleId), true);
});

test('dangerous and above-bot roles are rejected before a panel can grant them', async () => {
    const dangerousRole = safeRole('dangerous', 1, [FLAGS.Administrator]);
    const highRole = safeRole('high', 100);
    const member = makeMember('user-1');
    const guild = makeGuild({ roles: [dangerousRole, highRole], member });
    const service = loadSelfRoles();

    await assert.rejects(service.validateAssignableRole(guild, 'dangerous'), /sensitive permission/);
    await assert.rejects(service.validateAssignableRole(guild, 'high'), /above/);
});

test('expiry worker removes a due role once and marks its grant expired', async () => {
    const roleId = '222222222222222222';
    const member = makeMember('user-2', [roleId]);
    const guild = makeGuild({ roles: [safeRole(roleId)], member });
    const grant = {
        _id: 'grant-1',
        guildId: guild.id,
        userId: member.id,
        roleId,
        panelId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        expiresAt: new Date('2025-01-01T00:00:00Z')
    };
    let status = 'active';
    let findQuery;
    let finalUpdate;
    const service = loadSelfRoles({
        panelModel: { findById: async () => null },
        grantModel: {
            find: query => {
                findQuery = query;
                return {
                    sort() { return this; },
                    limit() { return this; },
                    lean: async () => [grant]
                };
            },
            findOneAndUpdate: async (query, update) => {
                if (status !== 'active' || query._id !== grant._id) return null;
                status = update.$set.status;
                return grant;
            },
            exists: async () => false,
            updateOne: async (filter, update) => {
                finalUpdate = update;
                status = update.$set.status;
                return {};
            }
        }
    });

    const processed = await service.expireTimedRoles({
        guilds: { cache: new Map([[guild.id, guild]]), fetch: async () => guild }
    }, new Date('2026-01-01T00:00:00Z'));

    assert.equal(processed, 1);
    assert.equal(member.roles.cache.has(roleId), false);
    assert.equal(member.removeCalls.length, 1);
    assert.equal(findQuery.status, 'active');
    assert.equal(status, 'expired');
    assert.equal(finalUpdate.$set.status, 'expired');
});

test('clone creates a separate draft copy and preserves the advanced panel rules', async () => {
    const source = {
        _id: 'dddddddddddddddddddddddd',
        guildId: 'guild-1',
        key: 'source',
        title: 'Source panel',
        description: 'Pick carefully',
        color: 123,
        requiredRoleIds: ['verified'],
        deniedRoleIds: ['muted'],
        groups: [],
        toObject() {
            return {
                groups: [{
                    key: 'alerts', name: 'Alerts', mode: 'multiple', minSelections: 0, maxSelections: 3,
                    requiredRoleIds: ['verified'], deniedRoleIds: [],
                    options: [{
                        roleId: '555555555555555555', label: 'News', description: 'News only', emoji: '🔔',
                        bundleRoleIds: ['666666666666666666'], requiredRoleIds: ['verified'],
                        deniedRoleIds: ['muted'], excludesRoleIds: [], durationMs: 86_400_000
                    }]
                }]
            };
        }
    };
    const saved = [];
    class FakePanel {
        constructor(values) { Object.assign(this, values, { _id: 'eeeeeeeeeeeeeeeeeeeeeeee' }); }
        async save() { saved.push(this); }
    }
    FakePanel.findOne = async query => query.key === source.key ? source : null;
    const service = loadSelfRoles({ panelModel: FakePanel });

    const message = await service.runAdminAction({
        action: 'clone',
        guild: { id: 'guild-1' },
        userId: 'admin-1',
        options: { sourceKey: 'source', key: 'copy', title: 'Copied panel' }
    });

    assert.match(message, /Cloned/);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].key, 'copy');
    assert.equal(saved[0].title, 'Copied panel');
    assert.equal(saved[0].status, 'draft');
    assert.equal(saved[0].mode, 'reactions');
    assert.equal(saved[0].messageId, '');
    assert.equal(saved[0].groups[0].options[0].durationMs, 86_400_000);
    assert.deepEqual(saved[0].groups[0].options[0].bundleRoleIds, ['666666666666666666']);
    assert.deepEqual(saved[0].requiredRoleIds, ['verified']);
});
