/**
 * fixfixture.js
 *
 * Repair a fixture by editing teams, round label, phase, or group.
 * Resolves team names to TournamentTeam entries automatically.
 *
 * Usage:  .fixfixture [key] match=<number> [home=...] [away=...] [round=...] [phase=...] [group=...]
 * Slash:  /fixfixture match:<number> [key] [home] [away] [round] [phase] [group]
 *
 * Aliases: repairfixture
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Fixture, Team, TournamentTeam } = require('../../models/Tournament');
const { getDefaultTournament, getTournamentByKey } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { escapeRegex } = require('../../utils/stringHelpers');

module.exports = {
    name: 'fixfixture',
    description: 'Repair a fixture by editing teams or metadata.',
    usage: '.fixfixture [key] match=<number> [home=...] [away=...] [round=...] [phase=...] [group=...]',
    aliases: ['repairfixture'],
    hidden: true,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('fixfixture')
        .setDescription('Repair a fixture')
        .addIntegerOption(opt =>
            opt.setName('match')
                .setDescription('Match number')
                .setRequired(true)
        )
        .addStringOption(opt => opt.setName('home').setDescription('New home team').setRequired(false))
        .addStringOption(opt => opt.setName('away').setDescription('New away team').setRequired(false))
        .addStringOption(opt => opt.setName('round').setDescription('New round label').setRequired(false))
        .addStringOption(opt =>
            opt.setName('phase')
                .setDescription('New phase')
                .setRequired(false)
                .addChoices(
                    { name: 'League', value: 'league' },
                    { name: 'Group', value: 'group' },
                    { name: 'Qualifier', value: 'qualifier' },
                    { name: 'Eliminator', value: 'eliminator' },
                    { name: 'Quarter Final', value: 'quarterfinal' },
                    { name: 'Semi Final', value: 'semifinal' },
                    { name: 'Final', value: 'final' },
                    { name: 'Custom', value: 'custom' }
                )
        )
        .addStringOption(opt => opt.setName('group').setDescription('New group key').setRequired(false))
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

            return await runFixFixture({
                guild: message.guild,
                ...parsed,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[fixfixture] prefix error:', error);
            return message.reply('❌ Failed to fix fixture.');
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

            return await runFixFixture({
                guild: interaction.guild,
                key: interaction.options.getString('key')?.toLowerCase() || null,
                matchNumber: interaction.options.getInteger('match'),
                home: interaction.options.getString('home'),
                away: interaction.options.getString('away'),
                round: interaction.options.getString('round'),
                phase: interaction.options.getString('phase'),
                group: interaction.options.getString('group'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[fixfixture] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to fix fixture.');
            }

            return interaction.reply({ content: '❌ Failed to fix fixture.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Repair a fixture's data. Can update:
 * - Home/away teams (resolved to TournamentTeam entries)
 * - Round label, phase, group key
 */
async function runFixFixture({ guild, key, matchNumber, home, away, round, phase, group, reply }) {
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
            content: `❌ Fixture not found for match #${matchNumber} in \`${tournament.tournamentKey}\`.`
        });
    }

    /* ── Apply team changes ── */
    if (home) {
        const resolved = await resolveTournamentTeam(guild.id, tournament._id, home);
        if (!resolved) return reply({ content: `❌ Home team not found/active: **${home}**` });

        fixture.homeTeam = resolved.team.name;
        fixture.homeTeamId = resolved.team._id;
        fixture.homeTournamentTeamId = resolved.entry._id;
    }

    if (away) {
        const resolved = await resolveTournamentTeam(guild.id, tournament._id, away);
        if (!resolved) return reply({ content: `❌ Away team not found/active: **${away}**` });

        fixture.awayTeam = resolved.team.name;
        fixture.awayTeamId = resolved.team._id;
        fixture.awayTournamentTeamId = resolved.entry._id;
    }

    /* ── Apply metadata changes ── */
    if (round) fixture.roundLabel = round;
    if (phase) fixture.phase = phase;

    if (group != null) {
        fixture.groupKey = group ? group.toUpperCase() : null;
    }

    await fixture.save();

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('🔧 FIXTURE REPAIRED')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Match #**${fixture.matchNumber}**\n` +
            `**${fixture.homeTeam} vs ${fixture.awayTeam}**`
        )
        .addFields(
            { name: 'Phase', value: fixture.phase || '—', inline: true },
            { name: 'Round', value: fixture.roundLabel || '—', inline: true },
            { name: 'Group', value: fixture.groupKey || '—', inline: true }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   HELPERS
==================================================== */

/** Resolve a team name to a Team + TournamentTeam pair. */
async function resolveTournamentTeam(guildId, tournamentId, teamName) {
    const team = await Team.findOne({
        guildId,
        name: { $regex: new RegExp(`^${escapeRegex(teamName)}$`, 'i') }
    });

    if (!team) return null;

    const entry = await TournamentTeam.findOne({
        guildId,
        tournamentId,
        teamId: team._id,
        isActive: true
    });

    if (!entry) return null;

    return { team, entry };
}

/* ====================================================
   PREFIX ARG PARSER
==================================================== */

/** Parse prefix args: [key] match=<num> [home=...] [away=...] [round=...] [phase=...] [group=...] */
function parsePrefixArgs(args) {
    let key = null;
    let matchNumber = null;
    let home = null;
    let away = null;
    let round = null;
    let phase = null;
    let group = undefined;

    for (const arg of args) {
        if (arg.startsWith('match=')) matchNumber = parseInt(arg.slice(6), 10);
        else if (arg.startsWith('home=')) home = arg.slice(5).replace(/_/g, ' ');
        else if (arg.startsWith('away=')) away = arg.slice(5).replace(/_/g, ' ');
        else if (arg.startsWith('round=')) round = arg.slice(6).replace(/_/g, ' ');
        else if (arg.startsWith('phase=')) phase = arg.slice(6).toLowerCase();
        else if (arg.startsWith('group=')) group = arg.slice(6);
        else if (!arg.includes('=') && !key) key = arg.toLowerCase();
    }

    if (!matchNumber) {
        return {
            ok: false,
            error: '❌ Usage: `.fixfixture [key] match=<number> [home=...] [away=...] [round=...] [phase=...] [group=...]`'
        };
    }

    return { ok: true, key, matchNumber, home, away, round, phase, group };
}
