/**
 * moveplayer.js
 *
 * Organizer command to directly move a player to a different team.
 * Cannot move captains — change captain first.
 * Works inside the server's DEFAULT tournament unless `tournament=<key>` is
 * given: the target team must be registered in that tournament.
 *
 * Usage:  .moveplayer @user <team name> [tournament=<key>]
 * Slash:  /moveplayer user:<user> team:<team> [tournament:<key>]
 *
 * Aliases: mp, forcemoveplayer
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Player } = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { getUserFromArgs } = require('../../utils/stringHelpers');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const {
    sameId,
    effectiveCaptainId,
    getUserTeamInTournament,
    findTeamInTournamentByName,
    assignPlayerToTeamInTournament
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'moveplayer',
    description: 'Organizer command to directly move a player to a team.',
    usage: '.moveplayer @user <team name> [tournament=<key>]',
    aliases: ['mp', 'forcemoveplayer'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('moveplayer')
        .setDescription('Directly move a player to a team')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Player to move')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Target team name')
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

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const target =
                message.mentions.users.first() ||
                await getUserFromArgs(message, parsedKey.rest);

            if (!target) {
                return message.reply('❌ Usage: `.moveplayer @user <team name> [tournament=<key>]`');
            }

            const teamName = parsedKey.rest
                .join(' ')
                .replace(/<@!?\d{17,20}>/g, '')
                .replace(/\d{17,20}/g, '')
                .trim();

            if (!teamName) {
                return message.reply('❌ Usage: `.moveplayer @user <team name> [tournament=<key>]`');
            }

            return await runMovePlayer({
                guild: message.guild,
                targetUser: target,
                teamName,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[moveplayer] prefix error:', error);
            return message.reply('❌ Failed to move player.');
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

            return await runMovePlayer({
                guild: interaction.guild,
                targetUser: interaction.options.getUser('user'),
                teamName: interaction.options.getString('team'),
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[moveplayer] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to move player.');
            }

            return interaction.reply({ content: '❌ Failed to move player.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Move a player to a new team INSIDE the tournament:
 * 1. Resolve tournament (explicit key, else the server default)
 * 2. Validate player exists and is not captain (of their team in that tournament)
 * 3. Resolve target team among the tournament's teams
 * 4. Move the tournament roster entry (global record follows when it should)
 */
async function runMovePlayer({ guild, targetUser, teamName, tournamentKey = null, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey);
    if (!resolved.tournament) return reply({ content: resolved.error });

    const tournament = resolved.tournament;

    /* ── Find player ── */
    const player = await Player.findOne({
        guildId: guild.id,
        discordID: targetUser.id
    });

    if (!player) {
        return reply({ content: `❌ ${targetUser} is not registered as a player.` });
    }

    const oldCtx = await getUserTeamInTournament(guild.id, tournament, targetUser.id);
    const oldTeam = oldCtx?.team || null;

    /* ── Block captain from being moved directly ── */
    if (oldCtx && (oldCtx.isCaptain || sameId(effectiveCaptainId(oldCtx.entry, oldCtx.team), targetUser.id))) {
        return reply({
            content:
                `❌ ${targetUser} is currently captain of **${oldTeam.name}**.\n` +
                `Use \`.fixcaptain ${oldTeam.name} @newCaptain\` or \`.cc @newCaptain\` first.`
        });
    }

    /* ── Resolve target team (must be in this tournament) ── */
    const found = await findTeamInTournamentByName(guild.id, tournament, teamName);

    if (!found) {
        return reply({
            content: `❌ Target team \`${teamName}\` is not registered in **${tournament.name}** (\`${tournament.tournamentKey}\`).`
        });
    }

    const newTeam = found.team;

    if (oldTeam && String(oldTeam._id) === String(newTeam._id)) {
        return reply({ content: `❌ ${targetUser} is already in **${newTeam.name}**.` });
    }

    /* ── Move ── */
    await assignPlayerToTeamInTournament({
        guildId: guild.id,
        tournament,
        player,
        newTeam,
        oldTeamId: oldTeam?._id || null
    });

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Player Moved')
        .setDescription(
            `${targetUser} moved to **${newTeam.name}**.\n` +
            `Old Team: **${oldTeam?.name || 'FREE AGENT'}**`
        )
        .setFooter({
            text: `Tournament: ${tournament.name} (${tournament.tournamentKey})`
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}
