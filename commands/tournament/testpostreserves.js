/**
 * testpostreserves.js
 *
 * Post a no-ping preview of the reserved-fixture announcement in the current
 * channel. The preview bypasses the configured fixtures channel and sends no
 * user or role mentions.
 *
 * Usage:  .testpostreserves
 * Slash:  /testpostreserves
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { isOrganizer } = require('../../utils/isOrganizer');
const { runPostReserves } = require('./postreserves');

module.exports = {
    name: 'testpostreserves',
    description: 'Post a no-ping reserved-fixture preview in the current channel.',
    usage: '.testpostreserves',
    aliases: ['testreserved'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('testpostreserves')
        .setDescription('Post a no-ping reserved-fixture preview in this channel'),

    async execute(message) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            return await runPostReserves({
                guild: message.guild,
                testMode: true,
                targetChannel: message.channel,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[testpostreserves] prefix error:', error);
            return message.reply('❌ Failed to post the reserved-fixture preview.');
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

            return await runPostReserves({
                guild: interaction.guild,
                testMode: true,
                targetChannel: interaction.channel,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[testpostreserves] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to post the reserved-fixture preview.');
            }

            return interaction.reply({
                content: '❌ Failed to post the reserved-fixture preview.',
                ephemeral: true
            });
        }
    }
};
