/**
 * testpostmatchday.js
 *
 * Post a no-ping test of the next unplayed matchday in the channel where this
 * command is used. Unlike .postmatchday, this command ignores the configured
 * destination channel and does not send any user or role mentions.
 *
 * Usage:  .testpostmatchday <deadline>
 * Slash:  /testpostmatchday deadline:<text>
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits
} = require('discord.js');

const { isOrganizer } = require('../../utils/isOrganizer');
const { sanitizeDeadline } = require('../../utils/matchdayAnnouncement');
const { runPostMatchday } = require('./postmatchday');

const MAX_DEADLINE_LENGTH = 100;

module.exports = {
    name: 'testpostmatchday',
    description: 'Post a no-ping test announcement in the current channel.',
    usage: '.testpostmatchday <deadline>',
    aliases: ['testmatchday'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('testpostmatchday')
        .setDescription('Post a no-ping test announcement in this channel')
        .addStringOption(option =>
            option.setName('deadline')
                .setDescription('Deadline to show in the test announcement')
                .setRequired(true)
                .setMaxLength(MAX_DEADLINE_LENGTH)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const deadline = sanitizeDeadline(args.join(' '));
            if (!deadline) {
                return message.reply('❓ Usage: `.testpostmatchday <deadline>`.');
            }

            if (deadline.length > MAX_DEADLINE_LENGTH) {
                return message.reply(`❌ Keep the deadline under ${MAX_DEADLINE_LENGTH} characters.`);
            }

            return await runPostMatchday({
                guild: message.guild,
                deadline,
                testMode: true,
                targetChannel: message.channel,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[testpostmatchday] prefix error:', error);
            return message.reply('❌ Failed to post the test announcement.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
            }

            if (!(await isOrganizer(interaction.guild, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const deadline = sanitizeDeadline(interaction.options.getString('deadline'));
            if (!deadline) {
                return interaction.editReply('❓ Please provide a deadline for the test announcement.');
            }

            return await runPostMatchday({
                guild: interaction.guild,
                deadline,
                testMode: true,
                targetChannel: interaction.channel,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[testpostmatchday] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to post the test announcement.');
            }

            return interaction.reply({
                content: '❌ Failed to post the test announcement.',
                ephemeral: true
            });
        }
    }
};
