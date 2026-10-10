const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');

const selfRoles = require('../../utils/selfRoles');
const { getPanelByKey } = selfRoles;
const { SelfRolePanel } = require('../../models/SelfRoles');
const { parseDuration } = require('../../utils/selfRoleRules');

function panelOption(option, required = true) {
    option.setName('panel')
        .setDescription('Panel key')
        .setRequired(required)
        .setAutocomplete(true);
    return option;
}

module.exports = {
    name: 'selfroles',
    aliases: ['selfrole', 'sr'],
    description: 'Build and manage safe, interactive self-role panels.',
    usage: '.selfroles list | create/group/role/publish/... (or /selfroles)',
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.ManageRoles],

    data: new SlashCommandBuilder()
        .setName('selfroles')
        .setDescription('Build and manage interactive self-role panels')
        .addSubcommand(sub => sub
            .setName('create')
            .setDescription('Create a self-role panel draft')
            .addStringOption(option => option.setName('key').setDescription('Short unique key, e.g. alerts').setRequired(true))
            .addStringOption(option => option.setName('title').setDescription('Panel heading').setMaxLength(256).setRequired(true))
            .addStringOption(option => option.setName('description').setDescription('Instructions shown to members').setMaxLength(1500).setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('group')
            .setDescription('Create or configure a choice group')
            .addStringOption(option => panelOption(option))
            .addStringOption(option => option.setName('name').setDescription('Group name').setMaxLength(80).setRequired(true))
            .addStringOption(option => option.setName('mode').setDescription('Single-choice or multiple-choice').setRequired(true)
                .addChoices({ name: 'Single choice', value: 'single' }, { name: 'Multiple choices', value: 'multiple' }))
            .addIntegerOption(option => option.setName('min').setDescription('Minimum selected roles (0–25)').setMinValue(0).setMaxValue(25).setRequired(false))
            .addIntegerOption(option => option.setName('max').setDescription('Maximum selected roles; 0 means no extra limit').setMinValue(0).setMaxValue(100).setRequired(false))
            .addRoleOption(option => option.setName('required_role').setDescription('Member must have this role to add choices').setRequired(false))
            .addRoleOption(option => option.setName('blocked_role').setDescription('Members with this role cannot add choices').setRequired(false))
            .addBooleanOption(option => option.setName('clear_required').setDescription('Clear the group’s existing required-role gate').setRequired(false))
            .addBooleanOption(option => option.setName('clear_blocked').setDescription('Clear the group’s existing blocked-role gate').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('role')
            .setDescription('Add an assignable role option to a group')
            .addStringOption(option => panelOption(option))
            .addStringOption(option => option.setName('group').setDescription('Group name').setRequired(true).setAutocomplete(true))
            .addRoleOption(option => option.setName('role').setDescription('The safe role members may choose').setRequired(true))
            .addStringOption(option => option.setName('label').setDescription('Text shown in the menu').setMaxLength(100).setRequired(false))
            .addStringOption(option => option.setName('description').setDescription('Short option description').setMaxLength(100).setRequired(false))
            .addStringOption(option => option.setName('emoji').setDescription('Unicode or server custom emoji (required for reaction mode)').setMaxLength(64).setRequired(false))
            .addStringOption(option => option.setName('duration').setDescription('Optional expiry, e.g. 12h, 7d; use permanent for no expiry').setMaxLength(16).setRequired(false))
            .addRoleOption(option => option.setName('bundle_role').setDescription('Optional extra role granted with this choice').setRequired(false))
            .addRoleOption(option => option.setName('bundle_role_two').setDescription('Optional second bundled role').setRequired(false))
            .addRoleOption(option => option.setName('bundle_role_three').setDescription('Optional third bundled role').setRequired(false))
            .addRoleOption(option => option.setName('bundle_role_four').setDescription('Optional fourth bundled role').setRequired(false))
            .addRoleOption(option => option.setName('required_role').setDescription('Role the member must have to choose this').setRequired(false))
            .addRoleOption(option => option.setName('blocked_role').setDescription('Role that blocks this choice').setRequired(false))
            .addRoleOption(option => option.setName('exclude_role').setDescription('Role that cannot be held at the same time').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('remove-role')
            .setDescription('Remove a role option from a panel')
            .addStringOption(option => panelOption(option))
            .addRoleOption(option => option.setName('role').setDescription('Role option to remove').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('remove-group')
            .setDescription('Remove a whole role group from a panel')
            .addStringOption(option => panelOption(option))
            .addStringOption(option => option.setName('group').setDescription('Group name').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(sub => sub
            .setName('access')
            .setDescription('Set an optional panel-wide role gate')
            .addStringOption(option => panelOption(option))
            .addRoleOption(option => option.setName('required_role').setDescription('Members must have this role to add choices').setRequired(false))
            .addRoleOption(option => option.setName('blocked_role').setDescription('Members with this role cannot add choices').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('clear-access')
            .setDescription('Clear panel-wide role gates')
            .addStringOption(option => panelOption(option))
        )
        .addSubcommand(sub => sub
            .setName('audit')
            .setDescription('Set or disable role-change audit logging')
            .addStringOption(option => panelOption(option))
            .addChannelOption(option => option.setName('channel').setDescription('Audit text channel; omit to disable').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('publish')
            .setDescription('Publish or refresh a panel')
            .addStringOption(option => panelOption(option))
            .addStringOption(option => option.setName('mode').setDescription('How members pick roles').setRequired(true)
                .addChoices(
                    { name: 'Buttons and dropdowns', value: 'components' },
                    { name: 'Emoji reactions', value: 'reactions' },
                    { name: 'Both', value: 'both' }
                ))
            .addChannelOption(option => option.setName('channel').setDescription('Channel to publish in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('preview')
            .setDescription('Preview a panel privately before publishing')
            .addStringOption(option => panelOption(option))
            .addStringOption(option => option.setName('mode').setDescription('Preview style').setRequired(false)
                .addChoices(
                    { name: 'Buttons and dropdowns', value: 'components' },
                    { name: 'Emoji reactions', value: 'reactions' },
                    { name: 'Both', value: 'both' }
                ))
        )
        .addSubcommand(sub => sub
            .setName('edit')
            .setDescription('Edit a panel heading or description')
            .addStringOption(option => panelOption(option))
            .addStringOption(option => option.setName('title').setDescription('New heading').setMaxLength(256).setRequired(false))
            .addStringOption(option => option.setName('description').setDescription('New instructions').setMaxLength(1500).setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('clone')
            .setDescription('Clone a panel into a new editable draft')
            .addStringOption(option => option.setName('source').setDescription('Panel to copy').setRequired(true).setAutocomplete(true))
            .addStringOption(option => option.setName('key').setDescription('New panel key').setRequired(true))
            .addStringOption(option => option.setName('title').setDescription('New panel title').setMaxLength(256).setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('pause')
            .setDescription('Pause a panel without removing current roles')
            .addStringOption(option => panelOption(option))
        )
        .addSubcommand(sub => sub
            .setName('resume')
            .setDescription('Resume a paused panel')
            .addStringOption(option => panelOption(option))
        )
        .addSubcommand(sub => sub
            .setName('delete')
            .setDescription('Close and remove a panel message')
            .addStringOption(option => panelOption(option))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List configured self-role panels')
        ),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused(true);
            const guildId = interaction.guildId;
            if (!guildId) return interaction.respond([]);

            if (focused.name === 'panel' || focused.name === 'source') {
                const query = String(focused.value || '').toLowerCase();
                const panels = await SelfRolePanel.find({ guildId, status: { $ne: 'deleted' } })
                    .select('key title')
                    .sort({ key: 1 })
                    .limit(25)
                    .lean();
                return interaction.respond(panels
                    .filter(panel => !query || panel.key.includes(query) || panel.title.toLowerCase().includes(query))
                    .slice(0, 25)
                    .map(panel => ({ name: `${panel.key} — ${panel.title}`.slice(0, 100), value: panel.key })));
            }

            if (focused.name === 'group') {
                const panelKey = interaction.options.getString('panel');
                const panel = panelKey ? await getPanelByKey(guildId, panelKey) : null;
                const query = String(focused.value || '').toLowerCase();
                return interaction.respond((panel?.groups || [])
                    .filter(group => !query || group.key.includes(query) || group.name.toLowerCase().includes(query))
                    .slice(0, 25)
                    .map(group => ({ name: group.name.slice(0, 100), value: group.key })));
            }

            return interaction.respond([]);
        } catch (error) {
            console.error('[selfroles] autocomplete failed:', error.message || error);
            return interaction.respond([]).catch(() => null);
        }
    },

    async execute(message, args = []) {
        try {
            if (!message.guild) return;
            if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                return message.reply('🚫 You need **Manage Roles** to configure self-role panels.');
            }

            const action = String(args[0] || '').toLowerCase();
            if (!action) return message.reply(prefixHelp());
            const options = parsePrefixOptions(message, args.slice(1), action);
            const result = await selfRoles.runAdminAction({
                action,
                guild: message.guild,
                userId: message.author.id,
                options,
                client: message.client
            });
            if (action === 'preview') {
                try {
                    await message.author.send(result);
                    return message.reply('📨 Sent the panel preview to your DMs.');
                } catch {
                    return message.reply('I could not DM you. Please enable DMs or use `/selfroles preview` for a private preview.');
                }
            }
            return message.reply(result);
        } catch (error) {
            console.error('[selfroles] prefix command failed:', error);
            return message.reply(`❌ ${error.message || 'Could not manage the self-role panel.'}`);
        }
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
            }
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
                return interaction.reply({ content: '🚫 You need **Manage Roles** to configure self-role panels.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });
            const subcommand = interaction.options.getSubcommand();
            const options = parseSlashOptions(interaction, subcommand);
            const result = await selfRoles.runAdminAction({
                action: subcommand,
                guild: interaction.guild,
                userId: interaction.user.id,
                options,
                client: interaction.client
            });
            return interaction.editReply(result);
        } catch (error) {
            console.error('[selfroles] slash command failed:', error);
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(`❌ ${error.message || 'Could not manage the self-role panel.'}`);
            }
            return interaction.reply({ content: `❌ ${error.message || 'Could not manage the self-role panel.'}`, ephemeral: true });
        }
    }
};

function parseSlashOptions(interaction, action) {
    const getString = name => interaction.options.getString(name);
    const getRole = name => interaction.options.getRole(name);
    const panelKey = getString('panel');

    if (action === 'create') {
        return { key: getString('key'), title: getString('title'), description: getString('description') || '' };
    }
    if (action === 'group') {
        const requiredRole = getRole('required_role');
        const blockedRole = getRole('blocked_role');
        return {
            panelKey,
            groupName: getString('name'),
            mode: getString('mode'),
            minSelections: interaction.options.getInteger('min'),
            maxSelections: interaction.options.getInteger('max'),
            requiredRoleId: interaction.options.getBoolean('clear_required') ? '' : (requiredRole ? requiredRole.id : undefined),
            deniedRoleId: interaction.options.getBoolean('clear_blocked') ? '' : (blockedRole ? blockedRole.id : undefined)
        };
    }
    if (action === 'role') {
        const bundleRoleIds = ['bundle_role', 'bundle_role_two', 'bundle_role_three', 'bundle_role_four']
            .map(name => getRole(name)?.id)
            .filter(Boolean);
        const duration = getString('duration');
        return {
            panelKey,
            groupName: getString('group'),
            roleId: getRole('role')?.id,
            label: getString('label'),
            description: getString('description'),
            emoji: getString('emoji'),
            durationMs: parseDuration(duration),
            bundleRoleIds,
            requiredRoleId: getRole('required_role')?.id,
            deniedRoleId: getRole('blocked_role')?.id,
            excludeRoleId: getRole('exclude_role')?.id
        };
    }
    if (action === 'remove-role') return { panelKey, roleId: getRole('role')?.id };
    if (action === 'remove-group') return { panelKey, groupName: getString('group') };
    if (action === 'access') return {
        panelKey,
        requiredRoleId: getRole('required_role')?.id || '',
        deniedRoleId: getRole('blocked_role')?.id || ''
    };
    if (action === 'clear-access' || action === 'pause' || action === 'resume' || action === 'delete') return { panelKey };
    if (action === 'preview') return { panelKey, mode: getString('mode') || undefined };
    if (action === 'audit') return { panelKey, channel: interaction.options.getChannel('channel') };
    if (action === 'publish') return {
        panelKey,
        mode: getString('mode'),
        channel: interaction.options.getChannel('channel') || interaction.channel
    };
    if (action === 'edit') return { panelKey, title: getString('title') ?? undefined, description: getString('description') ?? undefined };
    if (action === 'clone') return {
        sourceKey: getString('source'),
        key: getString('key'),
        title: getString('title')
    };
    return {};
}

function parsePrefixOptions(message, args, action) {
    const rest = args;
    const panelKey = rest[0];

    if (action === 'list') return {};
    if (action === 'create') {
        const key = rest[0];
        const title = rest.slice(1).join(' ').trim();
        return { key, title, description: '' };
    }
    if (action === 'group') {
        return {
            panelKey,
            groupName: rest[1],
            mode: rest[2] || 'multiple',
            minSelections: rest[3] === undefined ? undefined : Number(rest[3]),
            maxSelections: rest[4] === undefined ? undefined : Number(rest[4])
        };
    }
    if (action === 'role') {
        const role = message.mentions.roles.first() || message.guild.roles.cache.get(rest[2]);
        if (!role) throw new Error('Mention the role option, e.g. `.selfroles role alerts updates @Role [label...]`.');
        return {
            panelKey,
            groupName: rest[1],
            roleId: role.id,
            label: rest.slice(3).join(' ').trim() || role.name,
            durationMs: 0,
            bundleRoleIds: []
        };
    }
    if (action === 'remove-role') {
        const role = message.mentions.roles.first() || message.guild.roles.cache.get(rest[1]);
        return { panelKey, roleId: role?.id };
    }
    if (action === 'remove-group') return { panelKey, groupName: rest[1] };
    if (action === 'publish') {
        const channel = message.mentions.channels.first() || null;
        const mode = rest.find(value => ['components', 'reactions', 'both'].includes(String(value).toLowerCase())) || 'components';
        return { panelKey, channel, mode };
    }
    if (action === 'preview' || action === 'pause' || action === 'resume' || action === 'delete' || action === 'clear-access') {
        return { panelKey };
    }
    if (action === 'audit') return { panelKey, channel: message.mentions.channels.first() || null };
    if (action === 'access') {
        const mentionedRoles = Array.from(message.mentions.roles.values());
        return {
            panelKey,
            requiredRoleId: mentionedRoles[0]?.id || '',
            deniedRoleId: mentionedRoles[1]?.id || ''
        };
    }
    if (action === 'edit') return { panelKey, title: rest.slice(1).join(' ') };
    if (action === 'clone') return { sourceKey: rest[0], key: rest[1], title: rest.slice(2).join(' ') };
    throw new Error(prefixHelp());
}

function prefixHelp() {
    return [
        '**Self-role panel setup** (requires Manage Roles)',
        '`.selfroles create <key> <title...>`',
        '`.selfroles group <panel> <group> <single|multiple> [min] [max]`',
        '`.selfroles role <panel> <group> @role [label...]`',
        '`.selfroles publish <panel> [#channel] [components|reactions|both]`',
        '`.selfroles list` · `.selfroles preview <panel>` · `.selfroles pause|resume|delete <panel>`',
        'Use `/selfroles` for all advanced settings, gates, durations, and audit-channel controls.'
    ].join('\n');
}

module.exports.parseSlashOptions = parseSlashOptions;
module.exports.parsePrefixOptions = parsePrefixOptions;
