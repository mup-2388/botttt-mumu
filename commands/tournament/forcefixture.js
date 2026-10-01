/**
 * forcefixture.js
 *
 * Force-change a fixture's status (Pending, Live, Played, Cancelled).
 * Use with caution — does not trigger any stat/standing updates.
 *
 * Usage:  .forcefixture [key] match=<number> status=<Pending|Live|Played|Cancelled>
 * Slash:  /forcefixture match:<number> status:<status> [key]
 *
 * Aliases: setfixturestatus
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Fixture } = require('../../models/Tournament');
const { getDefaultTournament, getTournamentByKey } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');

module.exports = {
    name: 'forcefixture',
    description: 'Force-change fixture status.',
    usage: '.forcefixture [key] match=<number> status=<Pending|Live|Played|Cancelled>',
    aliases: ['setfixturestatus'],
    hidden: true,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('forcefixture')
        .setDescription('Force-change fixture status')
        .addIntegerOption(opt =>
            opt.setName('match')
                .setDescription('Match number')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('status')
                .setDescription('New fixture status')
                .setRequired(true)
                .addChoices(
                    { name: 'Pending', value: 'Pending' },
                    { name: 'Live', value: 'Live' },
                    { name: 'Played', value: 'Played' },
                    { name: 'Cancelled', value: 'Cancelled' }
                )
        )
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key (default: the default tournament)')
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

            const parsed = parsePrefixArgs(args);
            if (!parsed.ok) return message.reply(parsed.error);

            return await runForceFixture({
                guild: message.guild,
                ...parsed,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[forcefixture] prefix error:', error);
            return message.reply('❌ Failed to force fixture status.');
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

            return await runForceFixture({
                guild: interaction.guild,
                key: interaction.options.getString('key')?.toLowerCase() || null,
                matchNumber: interaction.options.getInteger('match'),
                status: interaction.options.getString('status'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[forcefixture] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to force fixture status.');
            }

            return interaction.reply({ content: '❌ Failed to force fixture status.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/** Force-set a fixture's status field. Does NOT trigger stat/standing cascades. */
async function runForceFixture({ guild, key, matchNumber, status, reply }) {
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

    /* ── Apply status change ── */
    fixture.status = status;
    await fixture.save();

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0xF39C12)
        .setTitle('🛠️ FIXTURE STATUS FORCED')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Match #**${fixture.matchNumber}**\n` +
            `**${fixture.homeTeam} vs ${fixture.awayTeam}**\n\n` +
            `New status: **${fixture.status}**`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   PREFIX ARG PARSER
==================================================== */

/** Parse prefix args: [key] match=<num> status=<status> */
function parsePrefixArgs(args) {
    let key = null;
    let matchNumber = null;
    let status = null;

    for (const arg of args) {
        if (arg.startsWith('match=')) matchNumber = parseInt(arg.slice(6), 10);
        else if (arg.startsWith('status=')) status = arg.slice(7);
        else if (!arg.includes('=') && !key) key = arg.toLowerCase();
    }

    if (!matchNumber || !status) {
        return {
            ok: false,
            error: '❌ Usage: `.forcefixture [key] match=<number> status=<Pending|Live|Played|Cancelled>`'
        };
    }

    return { ok: true, key, matchNumber, status };
}
