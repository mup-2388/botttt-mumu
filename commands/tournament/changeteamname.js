/**
 * changeteamname.js
 *
 * Change a team name safely across all collections.
 * Captains/VCs can rename their own team; organizers can rename any team.
 *
 * Inside the server's DEFAULT tournament unless `tournament=<key>` is given:
 * captains can only rename the team they lead there, and organizers only teams
 * registered there.
 *
 * Usage:  .ctn <new name> [tournament=<key>]
 *         .ctn <old name> => <new name>   (organizer only)
 * Slash:  /changeteamname new_name:<name> [old_name:<name>] [tournament:<key>]
 *
 * Aliases: ctn, renameteam
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Team,
    Player,
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer,
    Fixture
} = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { escapeRegex } = require('../../utils/stringHelpers');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const {
    effectiveCaptainId,
    effectiveViceCaptainId,
    findTeamInTournamentByName,
    getTournamentTeams,
    sameId
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'changeteamname',
    description: 'Change a team name safely.',
    usage: '.ctn <new name> OR .ctn <old name> => <new name> [tournament=<key>]',
    aliases: ['ctn', 'renameteam'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('changeteamname')
        .setDescription('Change a team name safely')
        .addStringOption(opt =>
            opt.setName('new_name')
                .setDescription('New team name')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('old_name')
                .setDescription('Old team name (organizer only). Captains can omit this.')
                .setRequired(false)
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

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            if (!parsedKey.rest.length) {
                return message.reply(
                    '❌ Usage:\n' +
                    'Captain: `.ctn <new name> [tournament=<key>]`\n' +
                    'Organizer: `.ctn <old name> => <new name> [tournament=<key>]`'
                );
            }

            const parsed = parsePrefixArgs(parsedKey.rest);

            return await runChangeTeamName({
                guild: message.guild,
                actorId: message.author.id,
                oldName: parsed.oldName,
                newName: parsed.newName,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[changeteamname] prefix error:', error);
            return message.reply('❌ Failed to change team name.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return await runChangeTeamName({
                guild: interaction.guild,
                actorId: interaction.user.id,
                oldName: interaction.options.getString('old_name'),
                newName: interaction.options.getString('new_name'),
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[changeteamname] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to change team name.');
            }

            return interaction.reply({
                content: '❌ Failed to change team name.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Rename a team across all collections.
 * - If oldName is provided: organizer-only path (team must be in the tournament).
 * - If oldName is omitted: auto-detect from actor's team IN THE TOURNAMENT
 *   (captain / vice captain only).
 *
 * The Team document is server-wide, so the new name is also written to the
 * tournament snapshots (Teams/Players/Fixtures) that reference it.
 */
async function runChangeTeamName({ guild, actorId, oldName, newName, tournamentKey = null, reply }) {
    const cleanNewName = normalizeName(newName);

    /* ── Validate new name ── */
    if (!cleanNewName || cleanNewName.length < 2 || cleanNewName.length > 50) {
        return reply({ content: '❌ New team name must be between 2 and 50 characters.' });
    }

    /* ── Check for duplicate name ── */
    const duplicate = await Team.findOne({
        guildId: guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(cleanNewName)}$`, 'i') }
    });

    if (duplicate) {
        return reply({ content: `❌ A team named **${cleanNewName}** already exists.` });
    }

    /* ── Resolve the tournament ── */
    const resolved = await resolveTournament(guild.id, tournamentKey);
    if (!resolved.tournament) return reply({ content: resolved.error });

    const tournament = resolved.tournament;

    /* ── Resolve which team to rename ── */
    let team = null;
    const organizer = await isOrganizer(guild.id, actorId);

    // All teams registered in this tournament: { entry, team }
    const tournamentTeams = await getTournamentTeams(guild.id, tournament);

    if (oldName) {
        // Organizer path — rename any team that is in this tournament
        if (!organizer) {
            return reply({ content: '❌ Only organizers can rename another team by old name.' });
        }

        const wanted = normalizeName(oldName).toLowerCase();
        const found =
            tournamentTeams.find(x => x.team.name.toLowerCase() === wanted) ||
            (await findTeamInTournamentByName(guild.id, tournament, oldName));

        if (!found) {
            return reply({
                content: `❌ Team \`${oldName}\` is not registered in **${tournament.name}** (\`${tournament.tournamentKey}\`).`
            });
        }

        team = found.team;
    } else {
        // Captain/VC path — rename the team they lead in THIS tournament
        const mine = tournamentTeams.filter(x =>
            sameId(effectiveCaptainId(x.entry, x.team), actorId) ||
            sameId(effectiveViceCaptainId(x.entry, x.team), actorId)
        );

        if (!mine.length) {
            return reply({
                content:
                    `❌ You are not the captain or vice captain of a team in **${tournament.name}**.` +
                    (resolved.explicit ? '' : '\nManaging a team in another tournament? Add `tournament=<key>`.')
            });
        }

        if (mine.length > 1) {
            const list = mine.map(x => `• **${x.team.name}**`).join('\n');
            return reply({
                content:
                    `🤔 You manage more than one team in **${tournament.name}**:\n${list}\n\n` +
                    'Organizer form: `.ctn <old name> => <new name>`'
            });
        }

        team = mine[0].team;
    }

    if (!team) {
        return reply({ content: '❌ Team not found.' });
    }

    const oldTeamName = team.name;

    /* ── Update core Team name ── */
    await Team.updateOne(
        { _id: team._id },
        { $set: { name: cleanNewName } }
    );

    /* ── Update global Player snapshots ── */
    await Player.updateMany(
        { guildId: guild.id, teamId: team._id },
        { $set: { teamNameSnapshot: cleanNewName } }
    );

    /* ── Update the SAME tournament's records ── */
    const ttResult = await TournamentTeam.updateMany(
        { guildId: guild.id, tournamentId: tournament._id, teamId: team._id },
        { $set: { teamNameSnapshot: cleanNewName } }
    );

    const tpResult = await TournamentPlayer.updateMany(
        { guildId: guild.id, tournamentId: tournament._id, teamId: team._id },
        { $set: { teamNameSnapshot: cleanNewName } }
    );

    const homeResult = await Fixture.updateMany(
        { guildId: guild.id, tournamentId: tournament._id, homeTeamId: team._id },
        { $set: { homeTeam: cleanNewName } }
    );

    const awayResult = await Fixture.updateMany(
        { guildId: guild.id, tournamentId: tournament._id, awayTeamId: team._id },
        { $set: { awayTeam: cleanNewName } }
    );

    const fixturesUpdated =
        (homeResult.modifiedCount || 0) + (awayResult.modifiedCount || 0);

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Team Name Changed')
        .setDescription(
            `Tournament: **${tournament.name}**\n` +
            `**${oldTeamName}** → **${cleanNewName}**`
        )
        .setFooter({
            text:
                `Tournament teams: ${ttResult.modifiedCount || 0} • ` +
                `Tournament players: ${tpResult.modifiedCount || 0} • ` +
                `Fixtures: ${fixturesUpdated}`
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   HELPERS
==================================================== */

/** Parse prefix args — supports `<old name> => <new name>` or just `<new name>`. */
function parsePrefixArgs(args) {
    const text = args.join(' ').trim();

    if (text.includes('=>')) {
        const [oldName, newName] = text.split('=>').map(v => v.trim());
        return { oldName, newName };
    }

    return { oldName: null, newName: text };
}

/** Collapse whitespace and trim. */
function normalizeName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim();
}
