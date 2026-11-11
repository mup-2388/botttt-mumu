/**
 * teamrolecolors.js
 *
 * Enable or disable server-wide changes to team role colors.
 * When disabled, setcolor is blocked and teamrolessync leaves existing
 * Discord role colors untouched while continuing membership changes.
 *
 * Usage:  .teamrolecolors [on|off|status]
 * Slash:  /teamrolecolors [state:<on|off>]
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { ServerConfig } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');

module.exports = {
    name: 'teamrolecolors',
    description: 'Enable or disable color changes to team roles in this server.',
    usage: '.teamrolecolors [on|off|status]',
    aliases: ['teamcolors', 'rolecolors'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('teamrolecolors')
        .setDescription('Enable or disable color changes to team roles in this server')
        .addStringOption(opt =>
            opt.setName('state')
                .setDescription('Enable or disable team-role color changes (omit to view status)')
                .setRequired(false)
                .addChoices(
                    { name: 'Enable color changes', value: 'on' },
                    { name: 'Disable color changes', value: 'off' }
                )
        ),

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Only organizers can change this server setting.');
            }

            const parsed = parseState(args[0]);
            if (!parsed.valid) {
                return message.reply('❓ Usage: `.teamrolecolors on`, `.teamrolecolors off`, or `.teamrolecolors status`.');
            }

            return await runSettings({
                guild: message.guild,
                enabled: parsed.enabled,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[teamrolecolors] prefix error:', error);
            return message.reply('❌ Failed to update team-role color settings.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
            }

            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Only organizers can change this server setting.', ephemeral: true });
            }

            const parsed = parseState(interaction.options.getString('state'));
            await interaction.deferReply({ ephemeral: true });

            return await runSettings({
                guild: interaction.guild,
                enabled: parsed.enabled,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[teamrolecolors] slash error:', error);
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to update team-role color settings.');
            }
            return interaction.reply({ content: '❌ Failed to update team-role color settings.', ephemeral: true });
        }
    }
};

function parseState(input) {
    const state = String(input || '').trim().toLowerCase();
    if (!state || state === 'status') return { valid: true, enabled: undefined };
    if (['on', 'enable', 'enabled'].includes(state)) return { valid: true, enabled: true };
    if (['off', 'disable', 'disabled'].includes(state)) return { valid: true, enabled: false };
    return { valid: false, enabled: undefined };
}

async function runSettings({ guild, enabled, reply }) {
    if (enabled === undefined) {
        const config = await ServerConfig.findOne({ guildId: guild.id }).lean();
        return reply({ embeds: [buildStatusEmbed(config?.teamRoleColorsEnabled !== false)] });
    }

    await ServerConfig.findOneAndUpdate(
        { guildId: guild.id },
        { $set: { teamRoleColorsEnabled: enabled } },
        { upsert: true, setDefaultsOnInsert: true }
    );

    return reply({ embeds: [buildStatusEmbed(enabled, true)] });
}

function buildStatusEmbed(enabled, updated = false) {
    const title = updated
        ? enabled ? '🎨 TEAM ROLE COLOR CHANGES ENABLED' : '🎨 TEAM ROLE COLOR CHANGES DISABLED'
        : `🎨 TEAM ROLE COLOR CHANGES ${enabled ? 'ENABLED' : 'DISABLED'}`;

    const description = enabled
        ? 'Team-role color changes are **enabled**. `/setcolor` can update saved team colors, and `/teamrolessync` may apply those colors to Discord roles on its next run.'
        : 'Team-role color changes are **disabled**. `/setcolor` is blocked, and `/teamrolessync` will continue syncing membership without changing role colors. Existing Discord role colors are preserved.';

    return new EmbedBuilder()
        .setColor(enabled ? 0x2ECC71 : 0xE74C3C)
        .setTitle(title)
        .setDescription(description)
        .setFooter({ text: 'Use .teamrolecolors on/off or /teamrolecolors state:on/off to change this setting.' })
        .setTimestamp();
}

module.exports.runSettings = runSettings;
module.exports.parseState = parseState;
