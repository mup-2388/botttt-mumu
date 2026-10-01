/**
 * bracket.js
 *
 * View the tournament knockout bracket.
 * Delegates to generateBracketEmbed from sendbracket.js.
 *
 * Usage: .bracket [tournamentKey]
 * Slash: /bracket key:<key>
 *
 * Aliases: viewbracket, ko
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { generateBracketEmbed } = require('./sendbracket');
const { extractTournamentFromArgs } = require('../../utils/getTournament');

module.exports = {
    name: 'bracket',
    description: 'View tournament knockout bracket.',
    usage: '.bracket [tournamentKey]',
    aliases: ['viewbracket', 'ko'],
    hidden: false,
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('bracket')
        .setDescription('View tournament bracket')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args = []) {
        try {
            const parsed = await extractTournamentFromArgs(message.guild.id, args);

            if (parsed.explicit && parsed.error) {
                return message.reply(parsed.error);
            }

            // No key → the server's default tournament (already resolved for us)
            const key = parsed.tournament?.tournamentKey || null;

            const embed = await generateBracketEmbed(message.guild.id, key);
            return message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('[bracket] prefix error:', error);
            return message.reply('❌ Failed to load bracket.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const key = interaction.options.getString('key')?.toLowerCase() || null;
            const embed = await generateBracketEmbed(interaction.guild.id, key);

            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('[bracket] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to load bracket.');
            }

            return interaction.reply({ content: '❌ Failed to load bracket.', ephemeral: true });
        }
    }
};
