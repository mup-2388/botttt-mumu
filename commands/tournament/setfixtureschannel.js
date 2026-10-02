/**
 * setfixtureschannel.js
 *
 * Set the guild-wide destination for .postmatchday announcements.
 * Run without a channel argument in the destination, or pass a channel mention.
 *
 * Usage:  .setfixtureschannel [#channel]
 * Slash:  /setfixtureschannel [channel]
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');

const { ServerConfig } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');

const FIXTURES_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

module.exports = {
    name: 'setfixtureschannel',
    description: 'Set the default destination for matchday fixture announcements.',
    usage: '.setfixtureschannel [#channel]',
    aliases: ['setfixturechannel'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.ManageChannels],

    data: new SlashCommandBuilder()
        .setName('setfixtureschannel')
        .setDescription('Set the default destination for matchday fixture announcements')
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Destination channel (defaults to the current channel)')
                .addChannelTypes(...FIXTURES_CHANNEL_TYPES)
                .setRequired(false)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            let channel = null;

            if (args.length) {
                channel = message.mentions.channels.first() || null;

                if (!channel && /^\d{15,22}$/.test(args[0])) {
                    channel = await message.guild.channels.fetch(args[0]).catch(() => null);
                }

                if (!channel) {
                    return message.reply('❓ Usage: `.setfixtureschannel [#channel]` — mention a channel or run this in the destination channel.');
                }
            } else {
                channel = message.channel;
            }

            return await runSet({
                guild: message.guild,
                channel,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[setfixtureschannel] prefix error:', error);
            return message.reply('❌ Failed to set the default fixtures channel.');
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

            return await runSet({
                guild: interaction.guild,
                channel: interaction.options.getChannel('channel') || interaction.channel,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[setfixtureschannel] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to set the default fixtures channel.');
            }

            return interaction.reply({
                content: '❌ Failed to set the default fixtures channel.',
                ephemeral: true
            });
        }
    }
};

async function runSet({ guild, channel, reply }) {
    if (!isDestinationChannel(channel, guild.id)) {
        return reply({
            content: '❌ Choose a regular text or announcement channel in this server (threads are not supported).'
        });
    }

    await ServerConfig.findOneAndUpdate(
        { guildId: guild.id },
        {
            $set: {
                guildId: guild.id,
                defaultFixturesChannelId: channel.id
            }
        },
        { upsert: true, new: true }
    );

    return reply({
        content: `✅ Default matchday fixtures channel set to <#${channel.id}>. Use ` +
            '`.postmatchday <deadline>` to post the next unplayed matchday.'
    });
}

function isDestinationChannel(channel, guildId) {
    return !!channel &&
        String(channel.guildId || channel.guild?.id || '') === String(guildId) &&
        FIXTURES_CHANNEL_TYPES.includes(channel.type);
}

module.exports.runSet = runSet;
module.exports.isDestinationChannel = isDestinationChannel;
