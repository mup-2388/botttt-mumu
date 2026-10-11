const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');

const selfRoles = require('../../utils/selfRoles');
const { getPanelByKey } = selfRoles;
const { SelfRolePanel } = require('../../models/SelfRoles');
const { parseDuration, normalizeKey } = require('../../utils/selfRoleRules');

const ACTIVE_SETUP_WIZARDS = new Set();
const WIZARD_TIMEOUT_MS = 180_000;

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
    description: 'Set up reaction-role panels through a guided chat wizard.',
    usage: '.selfroles (guided setup) | .selfroles list | /selfroles (advanced settings)',
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.ManageRoles],

    data: new SlashCommandBuilder()
        .setName('selfroles')
        .setDescription('Set up and manage reaction-role panels')
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
            .addStringOption(option => option.setName('label').setDescription('Role label shown in the panel embed').setMaxLength(100).setRequired(false))
            .addStringOption(option => option.setName('description').setDescription('Custom text shown beside this reaction role in the embed').setMaxLength(500).setRequired(false))
            .addStringOption(option => option.setName('emoji').setDescription('Unicode or server custom emoji members react with').setMaxLength(64).setRequired(false))
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
            .setDescription('Publish or refresh this reaction-role panel')
            .addStringOption(option => panelOption(option))
            .addChannelOption(option => option.setName('channel').setDescription('Channel to publish in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('preview')
            .setDescription('Preview a reaction-role panel privately')
            .addStringOption(option => panelOption(option))
        )
        .addSubcommand(sub => sub
            .setName('edit')
            .setDescription('Edit a panel heading or description')
            .addStringOption(option => panelOption(option))
            .addStringOption(option => option.setName('title').setDescription('New heading').setMaxLength(256).setRequired(false))
            .addStringOption(option => option.setName('description').setDescription('New embed text (Markdown allowed)').setMaxLength(1500).setRequired(false))
            .addStringOption(option => option.setName('color').setDescription('Embed accent color, e.g. #5865F2').setMaxLength(7).setRequired(false))
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
            if (!action || action === 'setup' || action === 'wizard') return await startSetupWizard(message);
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

class SetupWizardCancelled extends Error {}

class SetupWizardTimedOut extends Error {}

async function startSetupWizard(message) {
    if (!message.guild) return message.reply('❌ The setup wizard must be started inside a server.');
    if (!message.member?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
        return message.reply('🚫 You need **Manage Roles** to configure self-role panels.');
    }

    const lockKey = `${message.guild.id}:${message.author.id}`;
    if (ACTIVE_SETUP_WIZARDS.has(lockKey)) {
        return message.reply('You already have a self-role setup running in this server. Reply to its current question, or type `cancel`.');
    }
    ACTIVE_SETUP_WIZARDS.add(lockKey);

    const send = content => message.channel.send({ content, allowedMentions: { parse: [] } });
    const ask = async prompt => {
        await send(prompt);
        let collected;
        try {
            collected = await message.channel.awaitMessages({
                filter: response => response.author.id === message.author.id && response.channelId === message.channel.id,
                max: 1,
                time: WIZARD_TIMEOUT_MS,
                errors: ['time']
            });
        } catch {
            throw new SetupWizardTimedOut();
        }
        const response = collected.first();
        if (!response) throw new SetupWizardTimedOut();
        if (String(response.content || '').trim().toLowerCase() === 'cancel') throw new SetupWizardCancelled();
        return response;
    };
    const askParsed = async (prompt, parse) => {
        while (true) {
            const response = await ask(prompt);
            try {
                return await parse(response);
            } catch (error) {
                await send(`❌ ${error.message || 'That answer was not valid.'} Try again, or type \`cancel\` to stop.`);
            }
        }
    };

    let createdPanelKey = '';
    try {
        await send('🧭 **Reaction-role setup** — I will ask one question at a time. Reply in this channel; type `cancel` at any time to stop. I will only use emoji reactions, not buttons or dropdowns.');

        const title = await askParsed('1/7 — What should the embed heading say? (1–256 characters)', response => {
            const value = String(response.content || '').trim();
            if (!value || value.length > 256) throw new Error('Enter a heading between 1 and 256 characters.');
            return value;
        });

        const description = await askParsed('2/7 — What exact text should appear in the embed? You can use Markdown and multiple lines. Reply `-` for no intro text.', response => {
            const value = String(response.content || '');
            if (value.trim() === '-') return '';
            if (value.length > 1500) throw new Error('The embed intro is limited to 1,500 characters.');
            return value;
        });

        const color = await askParsed('3/7 — What embed accent color should I use? Send a hex color like `#5865F2`, or `default`.', response => {
            const value = String(response.content || '').trim();
            if (['default', 'skip', '-'].includes(value.toLowerCase())) return null;
            const match = value.match(/^#?([0-9a-f]{6})$/i);
            if (!match) throw new Error('Use a six-digit hex color such as `#5865F2`, or reply `default`.');
            return parseInt(match[1], 16);
        });

        const targetChannel = await askParsed('4/7 — Where should I post the panel? Mention a text channel, type its exact name, or reply `here` if this is a text or announcement channel.', response =>
            resolveWizardChannel(response, message)
        );

        const group = await askParsed('5/7 — What should this set of role choices be called? Reply `skip` to call it **Roles**.', response => {
            const value = String(response.content || '').trim();
            const name = !value || ['skip', 'default', '-'].includes(value.toLowerCase()) ? 'Roles' : value;
            if (name.length > 80) throw new Error('Group names are limited to 80 characters.');
            const key = normalizeKey(name, 32);
            if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) throw new Error('Use a group name containing letters or numbers.');
            return { name, key };
        });

        const choiceMode = await askParsed('6/7 — Should members pick `single` (one role) or `multiple` roles?', response => {
            const value = String(response.content || '').trim().toLowerCase();
            if (['single', 'one', '1'].includes(value)) return 'single';
            if (['multiple', 'multi', 'many', 'several'].includes(value)) return 'multiple';
            throw new Error('Reply `single` or `multiple`.');
        });

        const maxSelections = choiceMode === 'single'
            ? 1
            : await askParsed('7/7 — What is the maximum number of roles a member may choose from this panel? Reply `0` for no extra limit, or a number from 1 to 20.', response => {
                const value = Number(String(response.content || '').trim());
                if (!Number.isInteger(value) || value < 0 || value > 20) throw new Error('Enter 0 (unlimited) or a whole number from 1 to 20.');
                return value;
            });

        await send('Now I will add the reaction-role choices. For each choice, I’ll ask for a role, emoji, label, optional embed text, duration, and any bundled roles. You can type `done` when finished (up to 20 choices).');
        const options = [];
        const primaryRoleIds = new Set();
        const bundleRoleIdsUsed = new Set();
        const emojiKeys = new Set();

        while (options.length < 20) {
            const roleAnswer = await ask(`Role ${options.length + 1}/20 — mention the role, type its exact name, or send its ID. Type \`done\` when you have added at least one role.`);
            const roleText = String(roleAnswer.content || '').trim();
            if (['done', 'finish'].includes(roleText.toLowerCase())) {
                if (!options.length) {
                    await send('Add at least one role before finishing.');
                    continue;
                }
                break;
            }

            let role;
            try {
                role = resolveWizardRole(roleAnswer, message.guild);
                if (primaryRoleIds.has(String(role.id)) || bundleRoleIdsUsed.has(String(role.id))) {
                    throw new Error('That role is already used by another choice or bundle.');
                }
                await selfRoles.validateAssignableRole(message.guild, role.id);
            } catch (error) {
                await send(`❌ ${error.message || 'I could not find that server role.'} Mention a different role, or type \`cancel\`.`);
                continue;
            }

            const emoji = await askParsed(`What emoji should members react with for **${role.name}**? Send a Unicode emoji or a custom emoji from this server.`, response => {
                const descriptor = selfRoles.getEmojiDescriptor(String(response.content || '').trim(), message.guild);
                if (!descriptor) throw new Error('Send one emoji.');
                if (emojiKeys.has(descriptor.key)) throw new Error('Each role needs a different emoji.');
                return descriptor;
            });

            const label = await askParsed(`What label should appear beside ${emoji.display} in the embed? Reply \`same\` to use **${role.name}**.`, response => {
                const value = String(response.content || '').trim();
                const result = ['same', 'default', 'skip'].includes(value.toLowerCase()) ? role.name : value;
                if (!result || result.length > 100) throw new Error('The label must be between 1 and 100 characters.');
                return result;
            });

            const optionDescription = await askParsed(`What extra text should appear in the embed for **${label}**? Write it exactly as you want it shown (Markdown and multiple lines are okay), or reply \`-\` for none.`, response => {
                const value = String(response.content || '');
                if (value.trim() === '-') return '';
                if (value.length > 500) throw new Error('Each role’s embed text is limited to 500 characters.');
                return value;
            });

            const durationMs = await askParsed(`How long should **${label}** last? Reply \`permanent\` or a duration like \`12h\` or \`7d\`.`, response =>
                parseDuration(String(response.content || '').trim() || 'permanent')
            );

            const bundles = await askParsed(`Any extra roles to grant together with **${label}**? Mention up to four roles, or reply \`-\` for none.`, async response => {
                const text = String(response.content || '').trim();
                if (!text || ['-', 'none', 'no'].includes(text.toLowerCase())) return [];
                const mentioned = response.mentions?.roles ? [...response.mentions.roles.values()] : [];
                const ids = mentioned.map(item => String(item.id));
                if (!ids.length) {
                    const rawIds = text.match(/\b\d{17,20}\b/g) || [];
                    ids.push(...rawIds);
                }
                const uniqueIds = [...new Set(ids)];
                if (!uniqueIds.length || uniqueIds.length > 4) throw new Error('Mention between one and four server roles, or reply `-`.');
                if (uniqueIds.includes(String(role.id)) || uniqueIds.some(id => primaryRoleIds.has(id) || bundleRoleIdsUsed.has(id))) {
                    throw new Error('A bundled role cannot duplicate a role already used in this setup.');
                }
                const foundRoles = [];
                for (const id of uniqueIds) {
                    const bundleRole = message.guild.roles.cache.get(id);
                    if (!bundleRole) throw new Error(`Role ${id} is not in this server.`);
                    await selfRoles.validateAssignableRole(message.guild, id);
                    foundRoles.push(bundleRole);
                }
                return foundRoles;
            });

            primaryRoleIds.add(String(role.id));
            for (const bundleRole of bundles) bundleRoleIdsUsed.add(String(bundleRole.id));
            emojiKeys.add(emoji.key);
            options.push({
                roleId: String(role.id),
                label,
                description: optionDescription,
                emoji: emoji.display,
                durationMs,
                bundleRoleIds: bundles.map(bundleRole => String(bundleRole.id))
            });

            if (options.length >= 20) {
                await send('You have reached the 20-role reaction-panel limit.');
                break;
            }
            const more = await askParsed('Add another reaction role? Reply `yes` or `no`.', response => {
                const value = String(response.content || '').trim().toLowerCase();
                if (['yes', 'y', 'add'].includes(value)) return true;
                if (['no', 'n', 'done', 'finish'].includes(value)) return false;
                throw new Error('Reply `yes` or `no`.');
            });
            if (!more) break;
        }

        const draftPanel = {
            title,
            description,
            color: color ?? 0x5865F2,
            groups: [{
                key: group.key,
                name: group.name,
                mode: choiceMode,
                minSelections: 0,
                maxSelections,
                options
            }]
        };
        selfRoles.validatePanelDefinition(draftPanel, 'reactions');

        const publishNow = await askParsed('Setup is ready. Reply `publish` to post the panel now, or `draft` to save it and publish later.', response => {
            const value = String(response.content || '').trim().toLowerCase();
            if (['publish', 'yes', 'y', 'post', 'now'].includes(value)) return true;
            if (['draft', 'no', 'n', 'later'].includes(value)) return false;
            throw new Error('Reply `publish` or `draft`.');
        });

        const panelKey = await chooseUniquePanelKey(message.guild, title);
        await selfRoles.runAdminAction({
            action: 'create', guild: message.guild, userId: message.author.id,
            options: { key: panelKey, title, description }, client: message.client
        });
        createdPanelKey = panelKey;
        await selfRoles.runAdminAction({
            action: 'group', guild: message.guild, userId: message.author.id,
            options: {
                panelKey,
                groupName: group.name,
                mode: choiceMode,
                minSelections: 0,
                maxSelections,
                requiredRoleId: '',
                deniedRoleId: ''
            }, client: message.client
        });
        for (const option of options) {
            await selfRoles.runAdminAction({
                action: 'role', guild: message.guild, userId: message.author.id,
                options: {
                    panelKey,
                    groupName: group.name,
                    roleId: option.roleId,
                    label: option.label,
                    description: option.description,
                    emoji: option.emoji,
                    durationMs: option.durationMs,
                    bundleRoleIds: option.bundleRoleIds
                }, client: message.client
            });
        }
        if (color !== null) {
            await selfRoles.runAdminAction({
                action: 'edit', guild: message.guild, userId: message.author.id,
                options: { panelKey, color: `#${color.toString(16).padStart(6, '0')}` }, client: message.client
            });
        }

        if (!publishNow) {
            return send(`✅ Saved **${title}** as a draft (key: \`${panelKey}\`). Publish it later with \`/selfroles publish panel:${panelKey}\`.`);
        }

        try {
            const result = await selfRoles.runAdminAction({
                action: 'publish', guild: message.guild, userId: message.author.id,
                options: { panelKey, channel: targetChannel }, client: message.client
            });
            return send(result);
        } catch (error) {
            return send(`✅ Draft saved as \`${panelKey}\`, but I could not publish it: ${error.message || error}. Fix the permissions and run \`/selfroles publish panel:${panelKey}\`.`);
        }
    } catch (error) {
        if (error instanceof SetupWizardCancelled) return send('Setup cancelled. No panel was saved.');
        if (error instanceof SetupWizardTimedOut) return send('Setup timed out. No panel was saved. Run `.selfroles` again when you are ready.');
        console.error('[selfroles] guided setup failed:', error);
        const savedNote = createdPanelKey ? ` A draft named \`${createdPanelKey}\` may already have been saved.` : '';
        return send(`❌ ${error.message || 'Setup could not be completed.'}${savedNote}`);
    } finally {
        ACTIVE_SETUP_WIZARDS.delete(lockKey);
    }
}

async function chooseUniquePanelKey(guild, title) {
    let base = normalizeKey(title).slice(0, 26);
    if (base.length < 2) base = 'self-roles';
    let candidate = base;
    for (let suffix = 2; suffix < 10_000; suffix++) {
        if (!await getPanelByKey(guild.id, candidate)) return candidate;
        const suffixText = `-${suffix}`;
        candidate = `${base.slice(0, 32 - suffixText.length)}${suffixText}`;
    }
    throw new Error('Could not generate a unique panel key. Try a different heading.');
}

function resolveWizardChannel(response, message) {
    const mentioned = response.mentions?.channels?.first?.();
    const text = String(response.content || '').trim();
    if (mentioned) return validateWizardChannel(mentioned, message.guild);
    if (['here', 'this', 'this channel', 'current'].includes(text.toLowerCase())) {
        return validateWizardChannel(message.channel, message.guild);
    }
    const id = text.match(/^<#?(\d{17,20})>?$/)?.[1];
    let channel = id ? message.guild.channels.cache.get(id) : null;
    if (!channel) {
        const name = text.replace(/^#/, '').toLowerCase();
        const matches = [...message.guild.channels.cache.values()].filter(item => item.name?.toLowerCase() === name);
        if (matches.length === 1) channel = matches[0];
        else if (matches.length > 1) throw new Error('That channel name is ambiguous. Mention the channel instead.');
    }
    if (!channel) throw new Error('Mention a text channel, send its exact name, or use `here`.');
    return validateWizardChannel(channel, message.guild);
}

function validateWizardChannel(channel, guild) {
    if (channel.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
        throw new Error('Choose a text or announcement channel in this server.');
    }
    return channel;
}

function resolveWizardRole(response, guild) {
    const mentioned = response.mentions?.roles?.first?.();
    if (mentioned) return mentioned;
    const text = String(response.content || '').trim();
    const id = text.match(/^<@&(\d{17,20})>$|^(\d{17,20})$/)?.slice(1).find(Boolean);
    if (id) {
        const role = guild.roles.cache.get(id);
        if (role) return role;
    }
    const matches = [...guild.roles.cache.values()].filter(role => role.name.toLowerCase() === text.toLowerCase());
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error('More than one role has that name. Mention the role to choose the right one.');
    throw new Error('I could not find that role. Mention it, or send its exact name or ID.');
}

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
    if (action === 'clear-access' || action === 'pause' || action === 'resume' || action === 'delete' || action === 'preview') return { panelKey };
    if (action === 'audit') return { panelKey, channel: interaction.options.getChannel('channel') };
    if (action === 'publish') return { panelKey, channel: interaction.options.getChannel('channel') || interaction.channel };
    if (action === 'edit') return {
        panelKey,
        title: getString('title') ?? undefined,
        description: getString('description') ?? undefined,
        color: getString('color') ?? undefined
    };
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
        return { panelKey, channel };
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
        '**Self-role panels** (requires Manage Roles)',
        '`.selfroles` — start the guided reaction-panel setup; reply `cancel` at any time.',
        '`.selfroles list` · `.selfroles preview <panel>` · `.selfroles pause|resume|delete <panel>`',
        '`.selfroles create <key> <title...>` · `.selfroles publish <panel> [#channel]`',
        'Panels use emoji reactions only. Use `/selfroles` for advanced groups, access gates, timed grants, bundles, and audit logging.'
    ].join('\n');
}

module.exports.parseSlashOptions = parseSlashOptions;
module.exports.parsePrefixOptions = parsePrefixOptions;
