/**
 * editfixture.js
 *
 * Edit a fixture's schedule or venue details.
 * Does NOT change teams — use /fixfixture for team/metadata changes.
 *
 * Usage:  .editfixture [key] match=<number> [date=ISO] [venue=...] [venuetype=home|away|neutral]
 * Slash:  /editfixture match:<number> [key] [date] [venue] [venuetype]
 *
 * Aliases: updatefixture
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Fixture } = require('../../models/Tournament');
const { getDefaultTournament, getTournamentByKey } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { vsLine, slotEmoji } = require('../../utils/ai/emojiSlots');

module.exports = {
    name: 'editfixture',
    description: 'Edit a fixture schedule or venue details.',
    usage: '.editfixture [key] match=<number> [date=ISO] [venue=...] [venuetype=home|away|neutral]',
    aliases: ['updatefixture'],
    hidden: true,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('editfixture')
        .setDescription('Edit/fix fixture details')
        .addIntegerOption(opt =>
            opt.setName('match')
                .setDescription('Match number')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('date')
                .setDescription('New fixture date/time')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('venue')
                .setDescription('New venue name')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('venuetype')
                .setDescription('Venue type')
                .setRequired(false)
                .addChoices(
                    { name: 'Home', value: 'home' },
                    { name: 'Away', value: 'away' },
                    { name: 'Neutral', value: 'neutral' }
                )
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

            const parsed = parsePrefixArgs(args);
            if (!parsed.ok) return message.reply(parsed.error);

            return await runEditFixture({
                guild: message.guild,
                ...parsed,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[editfixture] prefix error:', error);
            return message.reply('❌ Failed to edit fixture.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runEditFixture({
                guild: interaction.guild,
                key: interaction.options.getString('key')?.toLowerCase() || null,
                matchNumber: interaction.options.getInteger('match'),
                date: interaction.options.getString('date'),
                venue: interaction.options.getString('venue'),
                venueType: interaction.options.getString('venuetype'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[editfixture] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to edit fixture.');
            }

            return interaction.reply({ content: '❌ Failed to edit fixture.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/** Update schedule, venue, or venue type for a single fixture. */
async function runEditFixture({ guild, key, matchNumber, date, venue, venueType, reply }) {
    /* ── Resolve tournament ── */
    const tournament = key
        ? await getTournamentByKey(guild.id, key)
        : await getDefaultTournament(guild.id);

    if (!tournament) {
        return reply({ content: '❌ Tournament not found.' });
    }

    /* ── Find fixture ── */
    const fixture = await Fixture.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        matchNumber
    });

    if (!fixture) {
        return reply({
            content: `❌ Fixture #${matchNumber} not found in \`${tournament.tournamentKey}\`.`
        });
    }

    /* ── Apply updates ── */
    if (date) {
        const parsedDate = new Date(date);
        if (Number.isNaN(parsedDate.getTime())) {
            return reply({ content: '❌ Invalid date format.' });
        }
        fixture.scheduledAt = parsedDate;
    }

    if (venue != null) fixture.venueName = venue;
    if (venueType) fixture.venueType = venueType;

    await fixture.save();

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('✏️ FIXTURE UPDATED')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Match #**${fixture.matchNumber}**\n` +
            `**${vsLine(fixture.homeTeam, fixture.awayTeam, guild.id)}**`
        )
        .addFields(
            {
                name: `${slotEmoji('calendar', guild.id)} Schedule`,
                value: fixture.scheduledAt
                    ? `<t:${Math.floor(new Date(fixture.scheduledAt).getTime() / 1000)}:F>`
                    : 'Not scheduled',
                inline: true
            },
            { name: 'Venue', value: fixture.venueName || 'Not set', inline: true },
            { name: 'Venue Type', value: fixture.venueType || 'Not set', inline: true }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   PREFIX ARG PARSER
==================================================== */

/** Parse prefix arguments: [key] match=<num> [date=ISO] [venue=...] [venuetype=...] */
function parsePrefixArgs(args) {
    let key = null;
    let matchNumber = null;
    let date = null;
    let venue = null;
    let venueType = null;

    for (const arg of args) {
        if (arg.startsWith('match=')) matchNumber = parseInt(arg.slice(6), 10);
        else if (arg.startsWith('date=')) date = arg.slice(5);
        else if (arg.startsWith('venue=')) venue = arg.slice(6).replace(/_/g, ' ');
        else if (arg.startsWith('venuetype=')) venueType = arg.slice(10).toLowerCase();
        else if (!arg.includes('=') && !key) key = arg.toLowerCase();
    }

    if (!matchNumber || Number.isNaN(matchNumber)) {
        return {
            ok: false,
            error: '❌ Usage: `.editfixture [key] match=<number> [date=ISO] [venue=...] [venuetype=home|away|neutral]`'
        };
    }

    return { ok: true, key, matchNumber, date, venue, venueType };
}
