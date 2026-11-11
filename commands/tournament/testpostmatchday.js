/**
 * testpostmatchday.js
 *
 * Post a no-ping test of the next unplayed matchday or a selected knockout
 * round in the channel where this command is used. Unlike .postmatchday, this
 * command ignores the configured destination channel and sends no pings.
 *
 * Usage:  .testpostmatchday [roundof16|quarterfinal|semifinal|final] <deadline>
 * Slash:  /testpostmatchday deadline:<text> [round:<round>]
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits
} = require('discord.js');

const { isOrganizer } = require('../../utils/isOrganizer');
const { KNOCKOUT_ROUNDS, sanitizeDeadline } = require('../../utils/matchdayAnnouncement');
const {
    runPostMatchday,
    parseRoundPhase,
    parsePostMatchdayArgs
} = require('./postmatchday');

const MAX_DEADLINE_LENGTH = 100;

module.exports = {
    name: 'testpostmatchday',
    description: 'Preview matchday or knockout-round fixtures in the current channel without pings.',
    usage: '.testpostmatchday [roundof16|quarterfinal|semifinal|final] <deadline>',
    aliases: ['testmatchday'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('testpostmatchday')
        .setDescription('Preview matchday or knockout-round fixtures in this channel')
        .addStringOption(option =>
            option.setName('deadline')
                .setDescription('Deadline to show in the test announcement')
                .setRequired(true)
                .setMaxLength(MAX_DEADLINE_LENGTH)
        )
        .addStringOption(option =>
            option.setName('round')
                .setDescription('Choose a knockout round; leave blank for the next matchday')
                .setRequired(false)
                .addChoices(
                    { name: 'Next Matchday', value: 'matchday' },
                    { name: KNOCKOUT_ROUNDS.roundof16.label, value: 'roundof16' },
                    { name: KNOCKOUT_ROUNDS.quarterfinal.label, value: 'quarterfinal' },
                    { name: KNOCKOUT_ROUNDS.semifinal.label, value: 'semifinal' },
                    { name: KNOCKOUT_ROUNDS.final.label, value: 'final' }
                )
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const { deadline, roundPhase } = parsePostMatchdayArgs(args);
            if (!deadline) {
                return message.reply('❓ Usage: `.testpostmatchday [roundof16|quarterfinal|semifinal|final] <deadline>`.');
            }

            if (deadline.length > MAX_DEADLINE_LENGTH) {
                return message.reply(`❌ Keep the deadline under ${MAX_DEADLINE_LENGTH} characters.`);
            }

            return await runPostMatchday({
                guild: message.guild,
                deadline,
                roundPhase,
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
            const selectedRound = interaction.options.getString('round');
            const roundPhase = selectedRound && selectedRound !== 'matchday'
                ? parseRoundPhase(selectedRound)
                : null;
            if (!deadline) {
                return interaction.editReply('❓ Please provide a deadline for the test announcement.');
            }

            return await runPostMatchday({
                guild: interaction.guild,
                deadline,
                roundPhase,
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
