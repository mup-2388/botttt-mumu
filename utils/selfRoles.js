const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    ChannelType,
    escapeMarkdown
} = require('discord.js');

const { SelfRolePanel, SelfRoleGrant } = require('../models/SelfRoles');
const { calculateSelection, checkRoleGates, normalizeKey } = require('./selfRoleRules');

const OPTIONS_PER_PAGE = 25;
const MAX_GROUPS = 25;
const MAX_REACTIONS_PER_PANEL = 20;
const MAX_BUNDLED_ROLES = 4;
const LOCKS = new Map();
let expiryTimer = null;
let expiryTickActive = false;

const BLOCKED_SELFROLE_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageEvents,
    PermissionFlagsBits.ManageNicknames,
    PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.ManageEmojisAndStickers,
    PermissionFlagsBits.ManageGuildExpressions,
    PermissionFlagsBits.ManageExpressions,
    PermissionFlagsBits.ManageSoundboard,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.MentionEveryone
].filter(Boolean);

function isComponentMode(mode) {
    return mode === 'components' || mode === 'both';
}

function isReactionMode(mode) {
    return mode === 'reactions' || mode === 'both';
}

function safeText(value, maxLength = 100) {
    return escapeMarkdown(String(value || ''))
        .replace(/@/g, '@\u200b')
        .replace(/</g, '‹')
        .replace(/>/g, '›')
        .slice(0, maxLength);
}

function formatPanelMode(mode) {
    if (mode === 'reactions') return 'Emoji reactions';
    if (mode === 'both') return 'Buttons, dropdowns, and reactions';
    return 'Buttons and dropdowns';
}

function formatGroupMode(group) {
    if (group.mode === 'single') return 'choose one';
    const configuredMax = Number(group.maxSelections) || 0;
    if (!configuredMax) return 'choose any number';
    const max = group.options?.length ? Math.min(configuredMax, group.options.length) : configuredMax;
    return `choose up to ${max}`;
}

function makePanelEmbed(panel, mode = panel.mode || 'components') {
    const embed = new EmbedBuilder()
        .setColor(Number(panel.color) || 0x5865F2)
        .setTitle(safeText(panel.title, 256))
        .setDescription(safeText(panel.description || '', 1500) || 'Choose the roles that match your interests.')
        .setFooter({ text: `Self roles • ${formatPanelMode(mode)}` });

    if (panel.groups?.length) {
        const groupText = isReactionMode(mode)
            ? panel.groups.map(group => {
                const choices = (group.options || []).map(option =>
                    `${option.emoji || '•'} **${safeText(option.label, 80)}**`
                ).join('\n');
                return `**${safeText(group.name, 80)}**\n${choices}`;
            }).join('\n\n')
            : panel.groups
                .slice(0, MAX_GROUPS)
                .map(group => `• **${safeText(group.name, 80)}** — ${formatGroupMode(group)} (${group.options?.length || 0})`)
                .join('\n');
        const current = embed.data.description || '';
        const heading = isReactionMode(mode) ? '**React with the emoji shown to toggle a role**' : '**Available role groups**';
        const combined = `${current}${current ? '\n\n' : ''}${heading}\n${groupText}`;
        embed.setDescription(combined.slice(0, 4000));
    }

    return embed;
}

function makePublicComponents(panel) {
    if (!isComponentMode(panel.mode)) return [];

    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`sr:open:${String(panel._id)}`)
            .setLabel('Choose / update roles')
            .setStyle(ButtonStyle.Primary)
    )];
}

function publicPanelPayload(panel) {
    return {
        embeds: [makePanelEmbed(panel)],
        components: makePublicComponents(panel),
        allowedMentions: { parse: [], users: [], roles: [] }
    };
}

function getMemberRoleIds(member) {
    return new Set(member?.roles?.cache ? [...member.roles.cache.keys()].map(String) : []);
}

function hasSelfRole(member, panel) {
    const roleIds = getMemberRoleIds(member);
    return (panel.groups || []).some(group =>
        (group.options || []).some(option => roleIds.has(String(option.roleId)))
    );
}

function makeGroupSelector(panel, member, userId) {
    const roles = getMemberRoleIds(member);
    const panelGateError = checkRoleGates(panel, roles, 'This role panel');
    if (panelGateError && !hasSelfRole(member, panel)) {
        return { content: panelGateError, allowedMentions: { parse: [] } };
    }

    const groups = (panel.groups || []).filter(group => {
        const gateError = checkRoleGates(group, roles, 'This role group');
        const alreadyHasRole = (group.options || []).some(option => roles.has(String(option.roleId)));
        return !gateError || alreadyHasRole;
    });

    if (!groups.length) {
        return { content: 'There are no role groups available to you in this panel.', allowedMentions: { parse: [] } };
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`sr:group:${String(panel._id)}:${userId}`)
        .setPlaceholder('Choose a role category')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(groups.slice(0, MAX_GROUPS).map(group => ({
            label: safeText(group.name, 100),
            value: group.key,
            description: safeText(`${group.options?.length || 0} roles • ${formatGroupMode(group)}`, 100)
        })));

    const embed = new EmbedBuilder()
        .setColor(Number(panel.color) || 0x5865F2)
        .setTitle(safeText(panel.title, 256))
        .setDescription('Choose a category to view and update your roles. Your changes are private.');

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)],
        allowedMentions: { parse: [], users: [], roles: [] }
    };
}

function makeRolePicker(panel, group, member, userId, page = 0, notice = '') {
    const allOptions = group.options || [];
    const pageCount = Math.max(1, Math.ceil(allOptions.length / OPTIONS_PER_PAGE));
    const safePage = Math.max(0, Math.min(Number(page) || 0, pageCount - 1));
    const pageOptions = allOptions.slice(safePage * OPTIONS_PER_PAGE, (safePage + 1) * OPTIONS_PER_PAGE);
    const memberRoles = getMemberRoleIds(member);

    if (!pageOptions.length) {
        return { content: 'This role group has no options yet.', components: [], allowedMentions: { parse: [] } };
    }

    const selectedOnPage = pageOptions
        .filter(option => memberRoles.has(String(option.roleId)))
        .map(option => String(option.roleId));
    const defaultSelection = new Set(group.mode === 'single' ? selectedOnPage.slice(0, 1) : selectedOnPage);
    const configuredMenuMax = Number(group.maxSelections) || allOptions.length;
    const menuMaxValues = group.mode === 'single'
        ? 1
        : Math.max(1, Math.min(pageOptions.length, Math.max(configuredMenuMax, selectedOnPage.length)));

    const optionChoices = pageOptions.map(option => {
        const label = safeText(option.label || option.roleId, 100) || String(option.roleId);
        const requirementText = option.requiredRoleIds?.length
            ? 'Requires another role'
            : option.deniedRoleIds?.length
                ? 'Unavailable with a restricted role'
                : option.durationMs > 0
                    ? `Expires after ${formatDuration(option.durationMs)}`
                    : safeText(option.description || 'Select to keep this role active', 100);
        return {
            label,
            value: String(option.roleId),
            description: safeText(requirementText || 'Select to keep this role active', 100),
            default: defaultSelection.has(String(option.roleId))
        };
    });

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`sr:pick:${String(panel._id)}:${group.key}:${safePage}:${userId}`)
        .setPlaceholder(`Update ${safeText(group.name, 70)} roles`)
        .setMinValues(0)
        .setMaxValues(menuMaxValues)
        .addOptions(optionChoices);

    const navigation = [];
    navigation.push(new ButtonBuilder()
        .setCustomId(`sr:nav:${String(panel._id)}:${group.key}:${safePage}:${userId}:back`)
        .setLabel('Categories')
        .setStyle(ButtonStyle.Secondary));
    if (safePage > 0) {
        navigation.push(new ButtonBuilder()
            .setCustomId(`sr:nav:${String(panel._id)}:${group.key}:${safePage}:${userId}:prev`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary));
    }
    if (safePage < pageCount - 1) {
        navigation.push(new ButtonBuilder()
            .setCustomId(`sr:nav:${String(panel._id)}:${group.key}:${safePage}:${userId}:next`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary));
    }
    navigation.push(new ButtonBuilder()
        .setCustomId(`sr:nav:${String(panel._id)}:${group.key}:${safePage}:${userId}:done`)
        .setLabel('Done')
        .setStyle(ButtonStyle.Success));

    const currentlySelected = allOptions.filter(option => memberRoles.has(String(option.roleId))).length;
    const maxAllowed = Math.min(Number(group.maxSelections) || allOptions.length, allOptions.length);
    const constraints = group.mode === 'single'
        ? 'Choose one, or clear your choice.'
        : `Choose up to ${maxAllowed} role(s); ${currentlySelected} currently selected.`;
    const pageInfo = pageCount > 1 ? `\nPage **${safePage + 1}/${pageCount}**` : '';
    const body = `${safeText(panel.description || 'Select the roles you want to have.', 900)}\n\n**${safeText(group.name, 80)}** — ${constraints}${pageInfo}${notice ? `\n\n${safeText(notice, 400)}` : ''}`;

    const embed = new EmbedBuilder()
        .setColor(Number(panel.color) || 0x5865F2)
        .setTitle(safeText(panel.title, 256))
        .setDescription(body.slice(0, 4000));

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(navigation)
        ],
        allowedMentions: { parse: [], users: [], roles: [] }
    };
}

function formatDuration(durationMs) {
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (durationMs % day === 0) return `${durationMs / day} day(s)`;
    if (durationMs % hour === 0) return `${durationMs / hour} hour(s)`;
    if (durationMs % minute === 0) return `${durationMs / minute} minute(s)`;
    return `${Math.round(durationMs / 1000)} second(s)`;
}

function panelIdIsValid(panelId) {
    return /^[a-f\d]{24}$/i.test(String(panelId || ''));
}

async function getPanelById(guildId, panelId) {
    if (!guildId || !panelIdIsValid(panelId)) return null;
    return SelfRolePanel.findOne({ _id: panelId, guildId, status: { $ne: 'deleted' } });
}

async function getPanelByKey(guildId, key) {
    const normalized = normalizeKey(key);
    if (!guildId || !normalized) return null;
    return SelfRolePanel.findOne({ guildId: String(guildId), key: normalized, status: { $ne: 'deleted' } });
}

async function getRole(guild, roleId) {
    const id = String(roleId || '');
    let role = guild.roles?.cache?.get(id) || null;
    if (!role && guild.roles?.fetch) role = await guild.roles.fetch(id).catch(() => null);
    return role;
}

async function getBotMember(guild) {
    if (guild.members?.me) return guild.members.me;
    if (guild.members?.fetchMe) return guild.members.fetchMe().catch(() => null);
    return null;
}

async function validateAssignableRole(guild, roleId) {
    const role = await getRole(guild, roleId);
    if (!role) throw new Error(`Role \`${roleId}\` is not in this server anymore.`);
    if (role.id === guild.id || role.name === '@everyone') {
        throw new Error('The @everyone role cannot be self-assigned.');
    }
    if (role.managed) throw new Error(`**${safeText(role.name)}** is managed by an integration and cannot be self-assigned.`);

    const protectedPermission = BLOCKED_SELFROLE_PERMISSIONS.find(permission => role.permissions?.has?.(permission));
    if (protectedPermission) {
        throw new Error(`**${safeText(role.name)}** has a sensitive permission and cannot be offered as a self-role.`);
    }

    const botMember = await getBotMember(guild);
    if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
        throw new Error('I need the **Manage Roles** permission before I can assign self-roles.');
    }
    if (!botMember.roles?.highest || role.position >= botMember.roles.highest.position) {
        throw new Error(`Move my highest role above **${safeText(role.name)}** before offering it as a self-role.`);
    }

    return role;
}

async function validateManageableRole(guild, roleId) {
    const role = await getRole(guild, roleId);
    if (!role) return null;
    if (role.managed) throw new Error(`I can no longer manage **${safeText(role.name)}** because an integration owns it.`);
    const botMember = await getBotMember(guild);
    if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
        throw new Error('I need the **Manage Roles** permission to update self-roles.');
    }
    if (!botMember.roles?.highest || role.position >= botMember.roles.highest.position) {
        throw new Error(`I can no longer manage **${safeText(role.name)}**; move my highest role above it.`);
    }
    return role;
}

function getEmojiDescriptor(input, guild) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const customMatch = raw.match(/^<a?:([A-Za-z0-9_]{2,32}):(\d{17,20})>$/);
    if (customMatch) {
        const emoji = guild.emojis?.cache?.get(customMatch[2]);
        if (!emoji) throw new Error('That custom emoji is not available in this server.');
        return { key: emoji.id, reactionValue: emoji.toString(), display: emoji.toString() };
    }

    if (raw.length > 32 || /<[@#]/.test(raw)) {
        throw new Error('Provide a Unicode emoji or a custom emoji from this server.');
    }
    return { key: raw, reactionValue: raw, display: raw };
}

function storedEmojiKey(raw) {
    const customMatch = String(raw || '').match(/^<a?:[A-Za-z0-9_]{2,32}:(\d{17,20})>$/);
    return customMatch ? customMatch[1] : String(raw || '');
}

function getReactionKey(emoji) {
    return String(emoji?.id || emoji?.name || '');
}

function validatePanelDefinition(panel, mode) {
    if (!panel.groups?.length) throw new Error('Add at least one role group before publishing.');
    if (panel.groups.length > MAX_GROUPS) throw new Error(`A panel can have at most ${MAX_GROUPS} groups.`);

    let reactionCount = 0;
    const usedEmojiKeys = new Set();

    for (const group of panel.groups) {
        const count = group.options?.length || 0;
        if (!count) throw new Error(`Add at least one role to the **${safeText(group.name)}** group.`);
        if (group.minSelections > count) throw new Error(`The minimum for **${safeText(group.name)}** is greater than its role count.`);
        if (group.maxSelections > 0 && group.maxSelections < group.minSelections) {
            throw new Error(`The maximum for **${safeText(group.name)}** cannot be smaller than its minimum.`);
        }
        if (group.mode === 'single' && group.minSelections > 1) {
            throw new Error(`A single-choice group cannot require more than one role.`);
        }
        if (isReactionMode(mode) && group.minSelections > 0) {
            throw new Error('Reaction panels cannot enforce minimum picks because members can remove reactions at any time. Set minimum picks to zero.');
        }

        for (const option of group.options || []) {
            if (!option.roleId || !option.label) throw new Error(`The **${safeText(group.name)}** group has an incomplete role option.`);
            if (isReactionMode(mode)) {
                if (!option.emoji) throw new Error(`Add an emoji to **${safeText(option.label)}** before publishing a reaction panel.`);
                const emojiKey = storedEmojiKey(option.emoji);
                if (usedEmojiKeys.has(emojiKey)) throw new Error('Every reaction option in a panel needs a unique emoji.');
                usedEmojiKeys.add(emojiKey);
                reactionCount++;
            }
        }
    }

    if (isReactionMode(mode) && reactionCount > MAX_REACTIONS_PER_PANEL) {
        throw new Error(`Reaction panels support at most ${MAX_REACTIONS_PER_PANEL} role options per message.`);
    }
}

async function validatePanelRoles(guild, panel) {
    const roleIds = new Set();
    for (const group of panel.groups || []) {
        for (const option of group.options || []) {
            roleIds.add(String(option.roleId));
            for (const roleId of option.bundleRoleIds || []) roleIds.add(String(roleId));
        }
    }
    for (const roleId of roleIds) await validateAssignableRole(guild, roleId);
}

async function runAdminAction({ action, guild, userId, options = {}, client }) {
    if (!guild) throw new Error('This command can only be used in a server.');
    switch (action) {
        case 'create': return createPanel(guild, userId, options);
        case 'clone': return clonePanel(guild, userId, options);
        case 'group': return upsertGroup(guild, userId, options);
        case 'role': return addRoleOption(guild, userId, options);
        case 'remove-role': return removeRoleOption(guild, userId, options);
        case 'remove-group': return removeGroup(guild, userId, options);
        case 'access': return setPanelAccess(guild, userId, options);
        case 'clear-access': return clearPanelAccess(guild, userId, options);
        case 'audit': return setAuditChannel(guild, userId, options);
        case 'publish': return publishPanel({ guild, userId, options, client });
        case 'preview': return previewPanel(guild, options);
        case 'edit': return editPanel(guild, userId, options);
        case 'pause': return setPanelStatus(guild, userId, options, 'paused');
        case 'resume': return setPanelStatus(guild, userId, options, 'published');
        case 'delete': return deletePanel({ guild, userId, options });
        case 'list': return listPanels(guild);
        default: throw new Error('Unknown self-role action.');
    }
}

async function createPanel(guild, userId, { key, title, description = '' }) {
    const normalizedKey = normalizeKey(key);
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalizedKey)) {
        throw new Error('Panel keys must be 2–32 characters using letters, numbers, dashes, or underscores.');
    }
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle || cleanTitle.length > 256) throw new Error('Provide a title between 1 and 256 characters.');
    if (String(description).length > 1500) throw new Error('Panel descriptions are limited to 1,500 characters.');

    let panel = await SelfRolePanel.findOne({ guildId: guild.id, key: normalizedKey });
    if (panel && panel.status !== 'deleted') throw new Error(`A self-role panel named \`${normalizedKey}\` already exists.`);

    if (!panel) {
        panel = new SelfRolePanel({
            guildId: guild.id,
            key: normalizedKey,
            title: cleanTitle,
            description: String(description || '').trim(),
            createdBy: String(userId),
            updatedBy: String(userId)
        });
    } else {
        Object.assign(panel, {
            title: cleanTitle,
            description: String(description || '').trim(),
            color: 0x5865F2,
            status: 'draft',
            mode: 'components',
            channelId: '',
            messageId: '',
            auditChannelId: '',
            requiredRoleIds: [],
            deniedRoleIds: [],
            groups: [],
            createdBy: String(userId),
            updatedBy: String(userId)
        });
    }
    await panel.save();
    return `✅ Created draft self-role panel **${cleanTitle}** (key: \`${normalizedKey}\`). Add groups and roles, then publish it.`;
}

async function clonePanel(guild, userId, { sourceKey, key, title }) {
    const source = await requirePanel(guild.id, sourceKey);
    const normalizedKey = normalizeKey(key);
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalizedKey)) {
        throw new Error('Panel keys must be 2–32 characters using letters, numbers, dashes, or underscores.');
    }
    const existing = await SelfRolePanel.findOne({ guildId: guild.id, key: normalizedKey });
    if (existing && existing.status !== 'deleted') throw new Error(`A self-role panel named \`${normalizedKey}\` already exists.`);

    const sourceObject = source.toObject();
    const clonedGroups = (sourceObject.groups || []).map(group => ({
        key: group.key,
        name: group.name,
        mode: group.mode,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        requiredRoleIds: group.requiredRoleIds || [],
        deniedRoleIds: group.deniedRoleIds || [],
        options: (group.options || []).map(option => ({
            roleId: option.roleId,
            label: option.label,
            description: option.description || '',
            emoji: option.emoji || '',
            bundleRoleIds: option.bundleRoleIds || [],
            requiredRoleIds: option.requiredRoleIds || [],
            deniedRoleIds: option.deniedRoleIds || [],
            excludesRoleIds: option.excludesRoleIds || [],
            durationMs: option.durationMs || 0
        }))
    }));

    const values = {
        guildId: guild.id,
        key: normalizedKey,
        title: String(title || `${source.title} (copy)`).slice(0, 256),
        description: source.description || '',
        color: source.color || 0x5865F2,
        status: 'draft',
        mode: 'components',
        channelId: '',
        messageId: '',
        auditChannelId: '',
        requiredRoleIds: source.requiredRoleIds || [],
        deniedRoleIds: source.deniedRoleIds || [],
        groups: clonedGroups,
        createdBy: String(userId),
        updatedBy: String(userId)
    };

    const panel = existing || new SelfRolePanel(values);
    if (existing) Object.assign(panel, values);
    await panel.save();
    return `✅ Cloned **${safeText(source.title, 80)}** as a draft named \`${normalizedKey}\`. Publish it to create a new panel message.`;
}

async function upsertGroup(guild, userId, options) {
    const panel = await requirePanel(guild.id, options.panelKey);
    const groupKey = normalizeKey(options.groupName, 32);
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(groupKey)) {
        throw new Error('Group names must resolve to 1–32 letters, numbers, dashes, or underscores.');
    }
    const mode = options.mode || 'multiple';
    if (!['single', 'multiple'].includes(mode)) throw new Error('Group mode must be `single` or `multiple`.');

    const existing = panel.groups.find(group => group.key === groupKey);
    const minSelections = options.minSelections ?? existing?.minSelections ?? 0;
    const maxSelections = options.maxSelections ?? existing?.maxSelections ?? 0;
    if (!Number.isInteger(minSelections) || minSelections < 0 || minSelections > 25) {
        throw new Error('Minimum selections must be between 0 and 25.');
    }
    if (!Number.isInteger(maxSelections) || maxSelections < 0 || maxSelections > 100) {
        throw new Error('Maximum selections must be between 0 and 100; use 0 for no extra limit.');
    }
    if (mode === 'single' && (minSelections > 1 || maxSelections > 1)) {
        throw new Error('Single-choice groups can have a maximum of one and a minimum of zero or one.');
    }

    const requiredRoleIds = options.requiredRoleId !== undefined
        ? (options.requiredRoleId ? [String(options.requiredRoleId)] : [])
        : (existing?.requiredRoleIds || []);
    const deniedRoleIds = options.deniedRoleId !== undefined
        ? (options.deniedRoleId ? [String(options.deniedRoleId)] : [])
        : (existing?.deniedRoleIds || []);

    if (existing) {
        existing.name = String(options.groupName).trim().slice(0, 80);
        existing.mode = mode;
        existing.minSelections = minSelections;
        existing.maxSelections = maxSelections;
        existing.requiredRoleIds = requiredRoleIds;
        existing.deniedRoleIds = deniedRoleIds;
    } else {
        if (panel.groups.length >= MAX_GROUPS) throw new Error(`A panel can have at most ${MAX_GROUPS} groups.`);
        panel.groups.push({
            key: groupKey,
            name: String(options.groupName).trim().slice(0, 80),
            mode,
            minSelections,
            maxSelections,
            requiredRoleIds,
            deniedRoleIds,
            options: []
        });
    }

    panel.updatedBy = String(userId);
    await panel.save();
    return `${existing ? '✅ Updated' : '✅ Added'} group **${safeText(options.groupName, 80)}** in panel \`${panel.key}\` (${mode}, min ${minSelections}, max ${maxSelections || 'unlimited'}).`;
}

async function addRoleOption(guild, userId, options) {
    const panel = await requirePanel(guild.id, options.panelKey);
    const group = panel.groups.find(item => item.key === normalizeKey(options.groupName, 32));
    if (!group) throw new Error(`Group \`${normalizeKey(options.groupName)}\` was not found in panel \`${panel.key}\`.`);

    const role = await validateAssignableRole(guild, options.roleId);
    const label = String(options.label || role.name).trim().slice(0, 100);
    const description = String(options.description || '').trim().slice(0, 100);
    if (!label) throw new Error('Role option label cannot be empty.');
    if (panel.groups.some(candidate => candidate.options.some(option => String(option.roleId) === String(role.id)))) {
        throw new Error(`**${safeText(role.name)}** is already an option in this panel.`);
    }

    const bundleRoleIds = [...new Set((options.bundleRoleIds || []).map(String).filter(Boolean))];
    if (bundleRoleIds.length > MAX_BUNDLED_ROLES) {
        throw new Error(`An option can grant at most ${MAX_BUNDLED_ROLES} additional roles.`);
    }
    if (bundleRoleIds.includes(String(role.id))) throw new Error('A role cannot bundle itself.');
    for (const bundleId of bundleRoleIds) {
        await validateAssignableRole(guild, bundleId);
        if (panel.groups.some(candidate => candidate.options.some(option =>
            String(option.roleId) === bundleId || (option.bundleRoleIds || []).map(String).includes(bundleId)))) {
            throw new Error(`Bundled role ${bundleId} is already used by another option in this panel.`);
        }
    }
    if (panel.groups.some(candidate => candidate.options.some(option =>
        (option.bundleRoleIds || []).map(String).includes(String(role.id))))) {
        throw new Error(`**${safeText(role.name)}** is already bundled by another option in this panel.`);
    }

    const requiredRoleIds = options.requiredRoleId ? [String(options.requiredRoleId)] : [];
    const deniedRoleIds = options.deniedRoleId ? [String(options.deniedRoleId)] : [];
    const excludesRoleIds = options.excludeRoleId ? [String(options.excludeRoleId)] : [];
    const grantIds = new Set([String(role.id), ...bundleRoleIds]);
    const selfReference = [...requiredRoleIds, ...deniedRoleIds, ...excludesRoleIds].some(id => grantIds.has(id));
    if (selfReference) throw new Error('A role option cannot require, deny, or exclude itself or one of its bundled roles.');

    let emoji = '';
    if (options.emoji) {
        const descriptor = getEmojiDescriptor(options.emoji, guild);
        emoji = descriptor.display;
    }

    const durationMs = Number(options.durationMs) || 0;
    if (durationMs < 0 || (durationMs > 0 && durationMs < 60_000) || durationMs > 90 * 24 * 60 * 60 * 1000) {
        throw new Error('Timed self-roles must last at least 1 minute and expire within 90 days.');
    }

    group.options.push({
        roleId: String(role.id),
        label,
        description,
        emoji,
        bundleRoleIds,
        requiredRoleIds,
        deniedRoleIds,
        excludesRoleIds,
        durationMs
    });
    panel.updatedBy = String(userId);
    await panel.save();

    const durationText = durationMs ? `, expires after ${formatDuration(durationMs)}` : '';
    return `✅ Added **${safeText(label)}** to **${safeText(group.name)}**${bundleRoleIds.length ? ` (+${bundleRoleIds.length} bundled role(s))` : ''}${durationText}.`;
}

async function removeRoleOption(guild, userId, { panelKey, roleId }) {
    const panel = await requirePanel(guild.id, panelKey);
    let removed = null;
    let removedGroupKey = '';
    for (const group of panel.groups) {
        const index = group.options.findIndex(option => String(option.roleId) === String(roleId));
        if (index !== -1) {
            removed = group.options.splice(index, 1)[0];
            removedGroupKey = group.key;
            break;
        }
    }
    if (!removed) throw new Error('That role is not an option in this panel.');
    await SelfRoleGrant.updateMany({
        guildId: guild.id,
        panelId: panel._id,
        groupKey: removedGroupKey,
        optionRoleId: String(removed.roleId),
        status: 'active',
        expiresAt: null
    }, { $set: { status: 'revoked' } });
    panel.updatedBy = String(userId);
    await panel.save();
    return `✅ Removed **${safeText(removed.label)}** from panel \`${panel.key}\`. Publish again to update the live panel.`;
}

async function removeGroup(guild, userId, { panelKey, groupName }) {
    const panel = await requirePanel(guild.id, panelKey);
    const key = normalizeKey(groupName, 32);
    const index = panel.groups.findIndex(group => group.key === key);
    if (index === -1) throw new Error(`Group \`${key}\` was not found.`);
    const [removed] = panel.groups.splice(index, 1);
    await SelfRoleGrant.updateMany({
        guildId: guild.id,
        panelId: panel._id,
        groupKey: removed.key,
        status: 'active',
        expiresAt: null
    }, { $set: { status: 'revoked' } });
    panel.updatedBy = String(userId);
    await panel.save();
    return `✅ Removed group **${safeText(removed.name)}** from panel \`${panel.key}\`. Existing member roles are not removed.`;
}

async function setPanelAccess(guild, userId, { panelKey, requiredRoleId, deniedRoleId }) {
    const panel = await requirePanel(guild.id, panelKey);
    panel.requiredRoleIds = requiredRoleId ? [String(requiredRoleId)] : [];
    panel.deniedRoleIds = deniedRoleId ? [String(deniedRoleId)] : [];
    panel.updatedBy = String(userId);
    await panel.save();
    return `✅ Updated access rules for panel \`${panel.key}\`. A required role is an any-of gate; a denied role blocks new selections.`;
}

async function clearPanelAccess(guild, userId, { panelKey }) {
    const panel = await requirePanel(guild.id, panelKey);
    panel.requiredRoleIds = [];
    panel.deniedRoleIds = [];
    panel.updatedBy = String(userId);
    await panel.save();
    return `✅ Cleared panel access gates for \`${panel.key}\`.`;
}

async function setAuditChannel(guild, userId, { panelKey, channel }) {
    const panel = await requirePanel(guild.id, panelKey);
    if (channel && (channel.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))) {
        throw new Error('Choose a text or announcement channel in this server.');
    }
    if (channel) {
        const botMember = await getBotMember(guild);
        const permissions = botMember ? channel.permissionsFor?.(botMember) : null;
        const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
        if (required.some(permission => permission && !permissions?.has?.(permission))) {
            throw new Error('I need view, send-message, and embed permissions in the audit channel.');
        }
    }
    panel.auditChannelId = channel?.id || '';
    panel.updatedBy = String(userId);
    await panel.save();
    return channel
        ? `✅ Self-role audit logs for \`${panel.key}\` will go to <#${channel.id}>.`
        : `✅ Disabled the self-role audit log for \`${panel.key}\`.`;
}

async function editPanel(guild, userId, { panelKey, title, description }) {
    const panel = await requirePanel(guild.id, panelKey);
    if (title !== undefined) {
        const cleanTitle = String(title).trim();
        if (!cleanTitle || cleanTitle.length > 256) throw new Error('Title must be between 1 and 256 characters.');
        panel.title = cleanTitle;
    }
    if (description !== undefined) {
        if (String(description).length > 1500) throw new Error('Description is limited to 1,500 characters.');
        panel.description = String(description).trim();
    }
    if (title === undefined && description === undefined) throw new Error('Provide a title or description to edit.');
    panel.updatedBy = String(userId);
    await panel.save();
    return `✅ Updated panel \`${panel.key}\`. Run publish to refresh its live message.`;
}

async function setPanelStatus(guild, userId, { panelKey }, status) {
    const panel = await requirePanel(guild.id, panelKey);
    if (status === 'published' && !panel.messageId) throw new Error('Publish this panel before resuming it.');
    panel.status = status;
    panel.updatedBy = String(userId);
    await panel.save();
    return status === 'paused'
        ? `⏸️ Paused panel \`${panel.key}\`. Existing roles remain; new selections are ignored.`
        : `✅ Resumed panel \`${panel.key}\`.`;
}

async function deletePanel({ guild, userId, options }) {
    const panel = await requirePanel(guild.id, options.panelKey);
    await SelfRoleGrant.updateMany({
        guildId: guild.id,
        panelId: panel._id,
        status: 'active',
        expiresAt: null
    }, { $set: { status: 'revoked' } });
    panel.status = 'deleted';
    panel.updatedBy = String(userId);
    const channelId = panel.channelId;
    const messageId = panel.messageId;
    panel.messageId = '';
    await panel.save();

    if (channelId && messageId) {
        const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
        const message = channel?.messages?.fetch ? await channel.messages.fetch(messageId).catch(() => null) : null;
        if (message) await message.delete().catch(() => null);
    }

    return `✅ Deleted panel \`${panel.key}\`. Roles members already chose stay on their accounts; timed roles still expire as configured.`;
}

async function listPanels(guild) {
    const panels = await SelfRolePanel.find({ guildId: guild.id, status: { $ne: 'deleted' } })
        .sort({ key: 1 })
        .lean();
    if (!panels.length) return 'No self-role panels exist yet. Use `/selfroles create` to start one.';

    const rows = panels.slice(0, 30).map(panel => {
        const roleCount = (panel.groups || []).reduce((sum, group) => sum + (group.options?.length || 0), 0);
        return `• **${safeText(panel.title, 80)}** — \`${panel.key}\` · ${panel.status} · ${panel.groups?.length || 0} group(s), ${roleCount} role(s)`;
    });
    if (panels.length > rows.length) rows.push(`…and ${panels.length - rows.length} more.`);
    return rows.join('\n');
}

async function previewPanel(guild, { panelKey, mode }) {
    const panel = await requirePanel(guild.id, panelKey);
    const previewMode = mode || panel.mode;
    if (!['components', 'reactions', 'both'].includes(previewMode)) throw new Error('Choose components, reactions, or both.');
    return {
        embeds: [makePanelEmbed(panel, previewMode)],
        components: [],
        allowedMentions: { parse: [], users: [], roles: [] }
    };
}

async function requirePanel(guildId, panelKey) {
    const panel = await getPanelByKey(guildId, panelKey);
    if (!panel) throw new Error(`Self-role panel \`${normalizeKey(panelKey)}\` was not found.`);
    return panel;
}

async function publishPanel({ guild, userId, options, client }) {
    const panel = await requirePanel(guild.id, options.panelKey);
    const mode = options.mode || 'components';
    if (!['components', 'reactions', 'both'].includes(mode)) throw new Error('Choose components, reactions, or both.');
    validatePanelDefinition(panel, mode);
    await validatePanelRoles(guild, panel);

    const channel = options.channel || (panel.channelId
        ? guild.channels.cache.get(panel.channelId) || await guild.channels.fetch(panel.channelId).catch(() => null)
        : null);
    if (!channel) throw new Error('Choose a text channel for the panel.');
    if (channel.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
        throw new Error('Self-role panels must be posted in a text or announcement channel in this server.');
    }

    const botMember = await getBotMember(guild);
    if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
        throw new Error('I need **Manage Roles** to publish an assignable role panel.');
    }
    const channelPermissions = channel.permissionsFor?.(botMember);
    const requiredPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (isReactionMode(mode)) {
        requiredPermissions.push(
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.ManageMessages
        );
    }
    const missingPermission = requiredPermissions.find(permission => permission && !channelPermissions?.has?.(permission));
    if (missingPermission) throw new Error('I am missing a required channel permission (view/send/embed, plus read-history/add-reactions/manage-messages for reaction panels).');

    const newMessage = await channel.send({
        ...publicPanelPayload({ ...panel.toObject(), _id: panel._id, mode }),
        allowedMentions: { parse: [], users: [], roles: [] }
    });

    try {
        if (isReactionMode(mode)) {
            for (const group of panel.groups) {
                for (const option of group.options) {
                    const descriptor = getEmojiDescriptor(option.emoji, guild);
                    await newMessage.react(descriptor.reactionValue);
                }
            }
        }
    } catch (error) {
        await newMessage.delete().catch(() => null);
        throw new Error(`Could not add the configured reactions: ${error.message || error}`);
    }

    const oldChannelId = panel.channelId;
    const oldMessageId = panel.messageId;
    panel.channelId = channel.id;
    panel.messageId = newMessage.id;
    panel.mode = mode;
    panel.status = 'published';
    panel.updatedBy = String(userId);

    try {
        await panel.save();
    } catch (error) {
        await newMessage.delete().catch(() => null);
        throw error;
    }

    if (oldMessageId && (oldMessageId !== newMessage.id || oldChannelId !== channel.id)) {
        const oldChannel = guild.channels.cache.get(oldChannelId) || await guild.channels.fetch(oldChannelId).catch(() => null);
        const oldMessage = oldChannel?.messages?.fetch ? await oldChannel.messages.fetch(oldMessageId).catch(() => null) : null;
        if (oldMessage) await oldMessage.delete().catch(() => null);
    }

    await logAudit({
        client,
        guild,
        panel,
        action: 'Panel published',
        details: `Mode: ${formatPanelMode(mode)} · Channel: <#${channel.id}>`,
        actorId: userId
    });

    return `✅ Published **${safeText(panel.title, 100)}** in <#${channel.id}> using ${formatPanelMode(mode)}.`;
}

async function getMember(guild, userId) {
    return guild.members?.cache?.get(String(userId)) || await guild.members.fetch(String(userId)).catch(() => null);
}

async function applyGroupSelection({ guild, member, panel, group, visibleRoleIds, selectedRoleIds, client, source = 'components' }) {
    const lockKey = `${guild.id}:${member.id}:${String(panel._id)}:${group.key}`;
    return withLock(lockKey, async () => {
        const freshMember = await getMember(guild, member.id) || member;
        const currentRoleIds = getMemberRoleIds(freshMember);
        const result = calculateSelection({
            panel,
            group,
            memberRoleIds: currentRoleIds,
            visibleRoleIds,
            selectedRoleIds
        });
        if (!result.ok) return result;
        if (!result.addedRoleIds.length && !result.removedRoleIds.length) {
            return { ok: true, addedCount: 0, removedCount: 0, notice: 'No changes were needed.' };
        }

        const addedOptions = result.addedRoleIds.map(roleId => group.options.find(option => String(option.roleId) === roleId)).filter(Boolean);
        const removedOptions = result.removedRoleIds.map(roleId => group.options.find(option => String(option.roleId) === roleId)).filter(Boolean);
        const rolesToAdd = [...new Set(addedOptions.flatMap(option => [String(option.roleId), ...(option.bundleRoleIds || []).map(String)]))];
        const rolesToRemove = [...new Set(removedOptions.flatMap(option => [String(option.roleId), ...(option.bundleRoleIds || []).map(String)]))];

        for (const roleId of rolesToAdd) await validateAssignableRole(guild, roleId);
        const manageableRoleIds = new Set();
        for (const roleId of rolesToRemove) {
            if (await validateManageableRole(guild, roleId)) manageableRoleIds.add(roleId);
        }

        const newlyAdded = [];
        try {
            for (const roleId of rolesToAdd) {
                if (!currentRoleIds.has(roleId)) {
                    await freshMember.roles.add(roleId, `Self-role selection in ${panel.key}`);
                    newlyAdded.push(roleId);
                }
            }

            const now = new Date();
            for (const option of addedOptions) {
                const expiresAt = Number(option.durationMs) > 0
                    ? new Date(now.getTime() + Number(option.durationMs))
                    : null;
                const targetRoleIds = [String(option.roleId), ...(option.bundleRoleIds || []).map(String)];
                for (const roleId of targetRoleIds) {
                    const existingActiveGrant = await SelfRoleGrant.exists({
                        guildId: guild.id,
                        userId: freshMember.id,
                        roleId,
                        status: 'active'
                    });
                    const removeOnExpire = !currentRoleIds.has(roleId) || Boolean(existingActiveGrant);
                    await SelfRoleGrant.updateOne(
                        {
                            guildId: guild.id,
                            userId: freshMember.id,
                            roleId,
                            panelId: panel._id,
                            groupKey: group.key,
                            optionRoleId: String(option.roleId)
                        },
                        {
                            $set: { expiresAt, status: 'active', lastError: '', grantedAt: now, removeOnExpire },
                            $setOnInsert: { guildId: guild.id, userId: freshMember.id, roleId, panelId: panel._id, groupKey: group.key, optionRoleId: String(option.roleId) }
                        },
                        { upsert: true }
                    );
                }
            }
        } catch (error) {
            await Promise.all(newlyAdded.map(roleId => freshMember.roles.remove(roleId, 'Rolling back incomplete self-role update').catch(() => null)));
            await SelfRoleGrant.updateMany(
                { guildId: guild.id, userId: freshMember.id, panelId: panel._id, groupKey: group.key, optionRoleId: { $in: result.addedRoleIds } },
                { $set: { status: 'revoked', expiresAt: null } }
            ).catch(() => null);
            throw error;
        }

        for (const option of removedOptions) {
            const targetRoleIds = [String(option.roleId), ...(option.bundleRoleIds || []).map(String)];
            for (const roleId of targetRoleIds) {
                const sourceFilter = {
                    guildId: guild.id,
                    userId: freshMember.id,
                    roleId,
                    panelId: panel._id,
                    groupKey: group.key,
                    optionRoleId: String(option.roleId)
                };
                const sourceGrant = await SelfRoleGrant.findOne(sourceFilter);
                const otherGrant = await SelfRoleGrant.exists({
                    guildId: guild.id,
                    userId: freshMember.id,
                    roleId,
                    status: 'active',
                    ...(sourceGrant?._id ? { _id: { $ne: sourceGrant._id } } : {})
                });

                const explicitlyRemovedRole = roleId === String(option.roleId);
                const shouldRemoveRole = explicitlyRemovedRole || sourceGrant?.removeOnExpire !== false;
                if (!otherGrant && shouldRemoveRole && manageableRoleIds.has(roleId) && freshMember.roles.cache.has(roleId)) {
                    try {
                        await freshMember.roles.remove(roleId, `Self-role deselected in ${panel.key}`);
                    } catch (error) {
                        console.error(`[selfroles] failed removing role ${roleId} from ${freshMember.id}:`, error.message || error);
                        continue;
                    }
                }
                if (sourceGrant) {
                    await SelfRoleGrant.updateOne({ _id: sourceGrant._id }, { $set: { status: 'revoked', expiresAt: null } });
                }
            }
        }

        for (const option of [...addedOptions, ...removedOptions]) {
            await logAudit({
                client,
                guild,
                panel,
                action: addedOptions.includes(option) ? 'Self-role selected' : 'Self-role removed',
                details: `${safeText(option.label)} (${option.roleId})${option.durationMs ? ` · expires in ${formatDuration(option.durationMs)}` : ''}`,
                actorId: freshMember.id
            });
        }

        return {
            ok: true,
            addedCount: addedOptions.length,
            removedCount: result.removedRoleIds.length,
            source,
            notice: `Added ${addedOptions.length}; removed ${result.removedRoleIds.length}.`
        };
    });
}

async function withLock(key, callback) {
    const previous = LOCKS.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    LOCKS.set(key, current);
    await previous.catch(() => null);
    try {
        return await callback();
    } finally {
        release();
        if (LOCKS.get(key) === current) LOCKS.delete(key);
    }
}

async function logAudit({ client, guild, panel, action, details, actorId }) {
    if (!panel.auditChannelId) return;
    try {
        const channel = guild.channels.cache.get(panel.auditChannelId) || await guild.channels.fetch(panel.auditChannelId).catch(() => null);
        if (!channel?.send) return;
        const embed = new EmbedBuilder()
            .setColor(action.includes('removed') || action.includes('expired') ? 0xE74C3C : 0x5865F2)
            .setTitle(`Self-role audit • ${safeText(action, 100)}`)
            .setDescription(`${safeText(details, 1500)}\n\nUser: \`${String(actorId)}\`\nPanel: \`${safeText(panel.key, 32)}\``)
            .setTimestamp();
        await channel.send({ embeds: [embed], allowedMentions: { parse: [], users: [], roles: [] } });
    } catch (error) {
        console.error('[selfroles] audit log failed:', error.message || error);
    }
}

async function handleComponentInteraction(interaction) {
    const customId = String(interaction.customId || '');
    if (!customId.startsWith('sr:')) return false;

    try {
        const parts = customId.split(':');
        const action = parts[1];

        if (action === 'open') {
            const panelId = parts[2];
            await interaction.deferReply({ ephemeral: true });
            const panel = await getPanelById(interaction.guildId, panelId);
            if (!panel || panel.status !== 'published' || !isComponentMode(panel.mode) || panel.messageId !== interaction.message.id) {
                return interaction.editReply('This self-role panel is no longer active.');
            }
            const member = await getMember(interaction.guild, interaction.user.id);
            if (!member) return interaction.editReply('I could not load your server member profile. Please try again.');
            return interaction.editReply(makeGroupSelector(panel, member, interaction.user.id));
        }

        if (action === 'prefs') {
            const ownerId = parts[2];
            if (ownerId !== interaction.user.id) return rejectPrivateComponent(interaction);
            await interaction.deferUpdate();
            const panelId = interaction.values?.[0];
            const panel = await getPanelById(interaction.guildId, panelId);
            if (!panel || panel.status !== 'published' || !isComponentMode(panel.mode)) {
                return interaction.editReply({ content: 'That panel is no longer available.', embeds: [], components: [] });
            }
            const member = await getMember(interaction.guild, interaction.user.id);
            if (!member) return interaction.editReply({ content: 'I could not load your server member profile.', embeds: [], components: [] });
            return interaction.editReply(makeGroupSelector(panel, member, interaction.user.id));
        }

        if (action === 'group') {
            const panelId = parts[2];
            const ownerId = parts[3];
            if (ownerId !== interaction.user.id) return rejectPrivateComponent(interaction);
            await interaction.deferUpdate();
            const panel = await getPanelById(interaction.guildId, panelId);
            if (!panel || panel.status !== 'published' || !isComponentMode(panel.mode)) {
                return interaction.editReply({ content: 'That panel is no longer available.', embeds: [], components: [] });
            }
            const group = panel.groups.find(item => item.key === interaction.values?.[0]);
            const member = await getMember(interaction.guild, interaction.user.id);
            if (!group || !member) return interaction.editReply({ content: 'That role group is unavailable.', embeds: [], components: [] });
            return interaction.editReply(makeRolePicker(panel, group, member, interaction.user.id));
        }

        if (action === 'pick') {
            const [, , panelId, groupKey, pageRaw, ownerId] = parts;
            if (ownerId !== interaction.user.id) return rejectPrivateComponent(interaction);
            await interaction.deferUpdate();
            const panel = await getPanelById(interaction.guildId, panelId);
            if (!panel || panel.status !== 'published' || !isComponentMode(panel.mode)) {
                return interaction.editReply({ content: 'That panel is no longer available.', embeds: [], components: [] });
            }
            const group = panel.groups.find(item => item.key === groupKey);
            const member = await getMember(interaction.guild, interaction.user.id);
            if (!group || !member) return interaction.editReply({ content: 'That role group is unavailable.', embeds: [], components: [] });
            const page = Math.max(0, Number(pageRaw) || 0);
            const visibleRoleIds = group.options.slice(page * OPTIONS_PER_PAGE, (page + 1) * OPTIONS_PER_PAGE).map(option => String(option.roleId));
            const result = await applyGroupSelection({
                guild: interaction.guild,
                member,
                panel,
                group,
                visibleRoleIds,
                selectedRoleIds: interaction.values || [],
                client: interaction.client,
                source: 'components'
            });
            const freshMember = await getMember(interaction.guild, interaction.user.id) || member;
            const notice = result.ok ? result.notice : result.error;
            return interaction.editReply(makeRolePicker(panel, group, freshMember, interaction.user.id, page, notice));
        }

        if (action === 'nav') {
            const [, , panelId, groupKey, pageRaw, ownerId, navAction] = parts;
            if (ownerId !== interaction.user.id) return rejectPrivateComponent(interaction);
            await interaction.deferUpdate();
            if (navAction === 'done') {
                return interaction.editReply({
                    content: '✅ Your self-role preferences are updated.',
                    embeds: [],
                    components: [],
                    allowedMentions: { parse: [] }
                });
            }
            const panel = await getPanelById(interaction.guildId, panelId);
            if (!panel || panel.status !== 'published' || !isComponentMode(panel.mode)) {
                return interaction.editReply({ content: 'That panel is no longer available.', embeds: [], components: [] });
            }
            const member = await getMember(interaction.guild, interaction.user.id);
            const group = panel.groups.find(item => item.key === groupKey);
            if (!group || !member) return interaction.editReply({ content: 'That role group is unavailable.', embeds: [], components: [] });
            if (navAction === 'back') return interaction.editReply(makeGroupSelector(panel, member, interaction.user.id));

            const maxPage = Math.max(0, Math.ceil(group.options.length / OPTIONS_PER_PAGE) - 1);
            const direction = navAction === 'next' ? 1 : -1;
            const page = Math.max(0, Math.min(maxPage, (Number(pageRaw) || 0) + direction));
            return interaction.editReply(makeRolePicker(panel, group, member, interaction.user.id, page));
        }

        return rejectPrivateComponent(interaction);
    } catch (error) {
        console.error('[selfroles] component interaction failed:', error);
        return respondToComponentError(interaction);
    }
}

async function rejectPrivateComponent(interaction) {
    if (interaction.deferred || interaction.replied) {
        return interaction.followUp({ content: 'This private role menu belongs to another member. Open your own menu instead.', ephemeral: true });
    }
    return interaction.reply({ content: 'This private role menu belongs to another member. Open your own menu instead.', ephemeral: true });
}

async function respondToComponentError(interaction) {
    const payload = { content: '❌ I could not update your role preferences. Please try again.', ephemeral: true, allowedMentions: { parse: [] } };
    try {
        if (interaction.deferred && interaction.deferred === true) {
            return await interaction.editReply({ content: payload.content, embeds: [], components: [] });
        }
        if (interaction.replied) return await interaction.followUp(payload);
        return await interaction.reply(payload);
    } catch (error) {
        console.error('[selfroles] failed to send component error:', error.message || error);
    }
}

async function handleMessageReaction(reaction, user, adding, client) {
    if (!user || user.bot) return false;
    try {
        if (reaction.partial) await reaction.fetch();
        const message = reaction.message;
        const guild = message?.guild;
        if (!guild || !message.id) return false;

        const panel = await SelfRolePanel.findOne({
            guildId: guild.id,
            messageId: message.id,
            status: 'published',
            mode: { $in: ['reactions', 'both'] }
        });
        if (!panel) return false;

        const emojiKey = getReactionKey(reaction.emoji);
        let found = null;
        for (const group of panel.groups || []) {
            const option = (group.options || []).find(item => storedEmojiKey(item.emoji) === emojiKey);
            if (option) {
                found = { group, option };
                break;
            }
        }
        if (!found) return false;

        const member = guild.members.cache.get(user.id) || await guild.members.fetch(user.id).catch(() => null);
        if (!member) return true;

        const groupRoleIds = found.group.options.map(option => String(option.roleId));
        const currentSelection = groupRoleIds.filter(roleId => member.roles.cache.has(roleId));
        let desired = currentSelection;
        if (adding) {
            desired = found.group.mode === 'single'
                ? [String(found.option.roleId)]
                : [...new Set([...currentSelection, String(found.option.roleId)])];
        } else {
            desired = currentSelection.filter(roleId => roleId !== String(found.option.roleId));
        }

        const result = await applyGroupSelection({
            guild,
            member,
            panel,
            group: found.group,
            visibleRoleIds: groupRoleIds,
            selectedRoleIds: desired,
            client,
            source: 'reaction'
        });

        if (!result.ok) {
            if (adding) await reaction.users.remove(user.id).catch(() => null);
            await user.send(`Your selection for **${safeText(panel.title)}** was not applied: ${result.error}`).catch(() => null);
        } else if (adding && found.group.mode === 'single') {
            for (const oldRoleId of result.removedRoleIds || []) {
                const oldOption = found.group.options.find(option => String(option.roleId) === String(oldRoleId));
                if (!oldOption?.emoji) continue;
                const oldReaction = reaction.message.reactions?.cache?.find(item => getReactionKey(item.emoji) === storedEmojiKey(oldOption.emoji));
                if (oldReaction) await oldReaction.users.remove(user.id).catch(() => null);
            }
        }
        return true;
    } catch (error) {
        console.error('[selfroles] reaction handler failed:', error);
        if (adding && user?.send) {
            await user.send('I could not apply that self-role reaction. Please use the panel button or contact a moderator.').catch(() => null);
        }
        return true;
    }
}

async function buildRolePrefsPayload(guild, member, userId) {
    const allPanels = await SelfRolePanel.find({
        guildId: guild.id,
        status: 'published'
    }).sort({ key: 1 }).limit(100).lean();
    const panels = allPanels.filter(panel => isComponentMode(panel.mode)).slice(0, OPTIONS_PER_PAGE);

    const currentRoleIds = getMemberRoleIds(member);
    const held = [];
    for (const panel of allPanels) {
        for (const group of panel.groups || []) {
            for (const option of group.options || []) {
                if (currentRoleIds.has(String(option.roleId))) {
                    held.push(`• **${safeText(option.label)}** — ${safeText(panel.title, 80)} / ${safeText(group.name, 80)}`);
                }
            }
        }
    }

    const heldDescription = held.length
        ? held.slice(0, 20).join('\n').slice(0, 4000)
        : 'You do not currently hold any roles offered by active self-role panels.';
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Your self-role preferences')
        .setDescription(heldDescription);

    if (!panels.length) {
        const content = allPanels.length
            ? 'Active reaction-based panels are available in their posted messages; no button/dropdown panels are available to open here.'
            : 'There are no active self-role panels in this server.';
        return { embeds: [embed], content, allowedMentions: { parse: [] } };
    }

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`sr:prefs:${userId}`)
        .setPlaceholder('Open a self-role panel')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(panels.map(panel => ({
            label: safeText(panel.title || panel.key, 100),
            value: String(panel._id),
            description: safeText(`${panel.key} • ${panel.groups?.length || 0} group(s)`, 100)
        })));

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)],
        allowedMentions: { parse: [], users: [], roles: [] }
    };
}

async function startExpiryWorker(client, intervalMs = 60_000) {
    if (expiryTimer) return expiryTimer;
    await SelfRoleGrant.updateMany({ status: 'processing' }, { $set: { status: 'active' } }).catch(() => null);
    expireTimedRoles(client).catch(error => console.error('[selfroles] expiry sweep failed:', error));
    expiryTimer = setInterval(() => {
        expireTimedRoles(client).catch(error => console.error('[selfroles] expiry sweep failed:', error));
    }, intervalMs);
    expiryTimer.unref?.();
    return expiryTimer;
}

async function expireTimedRoles(client, now = new Date()) {
    if (expiryTickActive) return 0;
    expiryTickActive = true;
    let processed = 0;
    try {
        const due = await SelfRoleGrant.find({ status: 'active', expiresAt: { $ne: null, $lte: now } })
            .sort({ expiresAt: 1 })
            .limit(100)
            .lean();

        for (const grant of due) {
            const claimed = await SelfRoleGrant.findOneAndUpdate(
                { _id: grant._id, status: 'active', expiresAt: { $ne: null, $lte: now } },
                { $set: { status: 'processing' } },
                { returnDocument: 'after' }
            );
            if (!claimed) continue;

            try {
                const guild = client.guilds.cache.get(grant.guildId) || await client.guilds.fetch(grant.guildId).catch(() => null);
                if (!guild) throw new Error('Guild is not available yet.');
                const member = await guild.members.fetch(grant.userId).catch(() => null);
                if (member?.roles?.cache?.has(String(grant.roleId))) {
                    const otherActiveGrant = await SelfRoleGrant.exists({
                        guildId: grant.guildId,
                        userId: grant.userId,
                        roleId: grant.roleId,
                        status: 'active',
                        _id: { $ne: grant._id }
                    });
                    if (!otherActiveGrant && grant.removeOnExpire !== false) {
                        const role = await validateManageableRole(guild, grant.roleId);
                        if (role) await member.roles.remove(String(grant.roleId), 'Self-role duration expired');
                    }
                }

                await SelfRoleGrant.updateOne({ _id: grant._id, status: 'processing' }, {
                    $set: { status: 'expired', lastError: '' }
                });
                processed++;

                const panel = await SelfRolePanel.findById(grant.panelId).catch(() => null);
                if (panel) {
                    await logAudit({
                        client,
                        guild,
                        panel,
                        action: 'Timed self-role expired',
                        details: `Role <@&${grant.roleId}> expired for user \`${grant.userId}\`.`,
                        actorId: grant.userId
                    });
                }
            } catch (error) {
                await SelfRoleGrant.updateOne({ _id: grant._id, status: 'processing' }, {
                    $set: { status: 'active', lastError: String(error.message || error).slice(0, 500) }
                }).catch(() => null);
                console.error(`[selfroles] could not expire role ${grant.roleId} for ${grant.userId}:`, error.message || error);
            }
        }
    } finally {
        expiryTickActive = false;
    }
    return processed;
}

module.exports = {
    OPTIONS_PER_PAGE,
    MAX_GROUPS,
    MAX_REACTIONS_PER_PANEL,
    runAdminAction,
    handleComponentInteraction,
    handleMessageReaction,
    buildRolePrefsPayload,
    startExpiryWorker,
    expireTimedRoles,
    makePanelEmbed,
    publicPanelPayload,
    makeGroupSelector,
    makeRolePicker,
    applyGroupSelection,
    validateAssignableRole,
    validatePanelDefinition,
    getPanelByKey,
    getPanelById,
    parseDuration: require('./selfRoleRules').parseDuration
};
