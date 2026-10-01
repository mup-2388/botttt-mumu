/**
 * setqualification.js
 *
 * Set the number of qualification spots per group for a tournament.
 * Organizer only.
 *
 * Usage:  .setqualification <tournamentKey> <spots>
 * Slash:  /setqualification tournament:<key> spots:<number>
 *
 * Aliases: setq, setqualify
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { TournamentSettings } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');

module.exports = {
    name: 'setqualification',
    description: 'Set qualification spots per group.',
    usage: '.setqualification [tournamentKey] <spots>',
    aliases: ['setq', 'setqualify'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('setqualification')
        .setDescription('Set qualification spots per group')
        .addIntegerOption(opt =>
            opt.setName('spots')
                .setDescription('Qualification spots')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args);
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const spots = Number(parsedKey.rest[0]);

            if (!spots || spots < 1) {
                return message.reply(
                    '❓ Usage: `.setqualification [tournamentKey] <spots>`\n' +
                    'Without a key the server default tournament is used.'
                );
            }

            return await runUpdateQualification({
                guildId: message.guild.id,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                spots,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[setqualification] prefix error:', error);
            return message.reply('❌ Failed to update qualification spots.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 Unauthorized.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            const tournamentKey = interaction.options.getString('tournament')?.toLowerCase() || null;
            const spots = interaction.options.getInteger('spots');

            return await runUpdateQualification({
                guildId: interaction.guild.id,
                tournamentKey,
                spots,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[setqualification] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to update qualification spots.');
            }

            return interaction.reply({
                content: '❌ Failed to update qualification spots.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

async function runUpdateQualification({ guildId, tournamentKey, spots, reply }) {
    const resolved = await resolveTournament(guildId, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    tournament.qualificationSpotsPerGroup = spots;

    // Recalculate knockout rounds based on new qualification count
    if (tournament.groupCount > 0) {
        const qualifiedCount = tournament.groupCount * spots;
        tournament.knockoutRounds = deriveKnockoutRounds(qualifiedCount);
        tournament.hasKnockout = true;
    }

    await tournament.save();

    const qualifiedCount = tournament.groupCount * spots;
    const roundsStr = tournament.knockoutRounds.length
        ? tournament.knockoutRounds.map(r => r.charAt(0).toUpperCase() + r.slice(1)).join(' → ')
        : 'None';

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('✅ QUALIFICATION UPDATED')
        .setDescription(
            `Tournament: **${tournament.name}**\n\n` +
            `Teams qualifying from each group: **${spots}**\n` +
            `Total qualified: **${qualifiedCount}**\n` +
            `Knockout rounds: **${roundsStr}**`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/**
 * Derive knockout rounds from qualified team count.
 * 2 → ['final'], 4 → ['semifinal','final'], 8 → ['quarterfinal','semifinal','final'], etc.
 */
function deriveKnockoutRounds(qualifiedTeamCount) {
    const ALL_ROUNDS = ['roundof16', 'quarterfinal', 'semifinal', 'final'];
    const total = Math.max(2, qualifiedTeamCount);
    const roundedCount = Math.ceil(Math.log2(total));
    return ALL_ROUNDS.slice(ALL_ROUNDS.length - roundedCount);
}
