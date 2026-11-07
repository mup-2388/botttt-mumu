/**
 * changecaptain.js
 *
 * Change the captain of a team. Current captain or vice captain can initiate.
 * Organizers can repair/set a team's tournament captain using `team=<name>`.
 * Works for the server's DEFAULT tournament unless `tournament=<key>` is given.
 * Preserves the vice captain unless the new captain was the VC.
 * Moves the tournament's captain Discord role if configured.
 *
 * Usage: .cc @user [team=<Team Name>] [tournament=<key>]
 * Slash: /changecaptain user:<user> [tournament:<key>] [team:<name>]
 *
 * Aliases: cc, captainchange
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Team,
    Player,
    TournamentTeam,
    TournamentPlayer
} = require('../../models/Tournament');

const { getUserFromArgs } = require('../../utils/stringHelpers');
const { isOrganizer } = require('../../utils/isOrganizer');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const {
    resolveActorTeam,
    getRosterMembership,
    findTeamInTournamentByName,
    parseTeamTokenInTournament,
    effectiveCaptainId,
    effectiveViceCaptainId,
    sameId
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'changecaptain',
    description: 'Change captain of your team (organizers may specify a team).',
    usage: '.cc @user [team=<Team Name>] [tournament=<key>]',
    aliases: ['cc', 'captainchange'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('changecaptain')
        .setDescription('Change captain of your team or repair tournament captaincy')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('New captain')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team name (organizers only, to repair/set tournament captaincy)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const tournamentKey = parsedKey.explicit ? parsedKey.tournament.tournamentKey : null;
            const resolved = await resolveTournament(message.guild.id, tournamentKey);
            if (!resolved.tournament) return message.reply(resolved.error);

            const token = await parseTeamTokenInTournament(
                message.guild.id,
                resolved.tournament,
                parsedKey.rest
            );
            const target = message.mentions.users.first() || await getUserFromArgs(message, token.rest);

            if (!target) {
                return message.reply('❌ Usage: `.cc @user [team=<Team Name>] [tournament=<key>]`');
            }

            return await runChangeCaptain({
                guild: message.guild,
                actorId: message.author.id,
                targetUser: target,
                tournamentKey,
                teamName: token.teamName,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[changecaptain] prefix error:', error);
            return message.reply('❌ Failed to change captain.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: false });

            const target = interaction.options.getUser('user');

            return await runChangeCaptain({
                guild: interaction.guild,
                actorId: interaction.user.id,
                targetUser: target,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                teamName: interaction.options.getString('team'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[changecaptain] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to change captain.');
            }

            return interaction.reply({ content: '❌ Failed to change captain.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Change the captain of a team IN A TOURNAMENT.
 * Validates: actor is captain/VC there, or organizer explicitly names a team;
 * target must be on that team in the selected tournament.
 * Preserves the vice captain unless the new captain was the VC (promoted).
 *
 * Writes the tournament roster flags and per-tournament captain ID for an
 * organizer override; ordinary captain changes retain the existing global-vs-
 * tournament-specific behavior.
 */
async function runChangeCaptain({ guild, actorId, targetUser, tournamentKey = null, teamName = null, reply }) {
    const organizerOverride = Boolean(teamName) && await isOrganizer(guild, actorId);

    if (teamName && !organizerOverride) {
        return reply({ content: '❌ Only an organizer can set captaincy for a named team.' });
    }

    // ── Self-change check ──
    if (actorId === targetUser.id && !organizerOverride) {
        return reply({ content: '❌ You cannot make yourself captain — you already are.' });
    }

    let tournament;
    let ctx;

    if (organizerOverride) {
        const resolved = await resolveTournament(guild.id, tournamentKey);
        if (!resolved.tournament) return reply({ content: resolved.error });
        tournament = resolved.tournament;
        ctx = await findTeamInTournamentByName(guild.id, tournament, teamName);

        if (!ctx) {
            return reply({ content: `❌ Team **${teamName}** is not active in **${tournament.name}**.` });
        }
    } else {
        const resolved = await resolveActorTeam({
            guildId: guild.id,
            userId: actorId,
            tournamentKey,
            need: 'manage',
            noun: 'use `.cc`'
        });

        if (resolved.error) return reply({ content: resolved.error });
        ({ tournament, ctx } = resolved);
    }

    const { team, entry } = ctx;

    // ── Target must be on the same team IN THIS TOURNAMENT ──
    const { player: targetPlayer, tournamentPlayer: targetEntry } =
        await getRosterMembership(guild.id, tournament, team._id, targetUser.id);

    if (!targetPlayer) {
        return reply({ content: `❌ ${targetUser} is not registered as a player.` });
    }

    if (!targetEntry) {
        return reply({
            content:
                `❌ ${targetUser} is not in **${team.name}** (${tournament.name}).\n` +
                'Captaincy can only be given to a player from the same team.'
        });
    }

    const oldCaptainId = effectiveCaptainId(entry, team) || (organizerOverride ? null : actorId);
    const oldViceId = effectiveViceCaptainId(entry, team);
    // The organizer override creates a tournament-specific captain assignment
    // so it cannot overwrite leadership for the team's other tournaments.
    const usesGlobalCaptain = !organizerOverride && !entry.captainID;

    if (sameId(oldCaptainId, targetUser.id)) {
        return reply({ content: `❌ ${targetUser} is already the captain of **${team.name}**.` });
    }

    // ── VC: if the new captain was the VC they got promoted → clear VC ──
    const targetWasVC = sameId(oldViceId, targetUser.id) || targetEntry.isViceCaptain;
    const newViceCaptainID = targetWasVC ? null : oldViceId;

    // ── This tournament's records ──
    await TournamentPlayer.updateMany(
        { guildId: guild.id, tournamentId: tournament._id, teamId: team._id },
        { $set: { isCaptain: false, isViceCaptain: false } }
    );

    await TournamentPlayer.updateOne(
        { _id: targetEntry._id },
        { $set: { isCaptain: true, isViceCaptain: false } }
    );

    if (newViceCaptainID) {
        const vcPlayer = await Player.findOne({ guildId: guild.id, discordID: String(newViceCaptainID) });
        if (vcPlayer) {
            await TournamentPlayer.updateMany(
                { guildId: guild.id, tournamentId: tournament._id, teamId: team._id, playerId: vcPlayer._id },
                { $set: { isViceCaptain: true } }
            );
        }
    }

    if (usesGlobalCaptain) {
        // Team uses its global captain here → keep the global records in sync
        await Team.updateOne(
            { _id: team._id },
            { $set: { captainID: targetUser.id, viceCaptainID: newViceCaptainID } }
        );

        await Player.updateMany(
            { guildId: guild.id, teamId: team._id },
            { $set: { isCaptain: false, isViceCaptain: false } }
        );

        await Player.updateOne(
            { guildId: guild.id, discordID: targetUser.id, teamId: team._id },
            { $set: { isCaptain: true, isViceCaptain: false } }
        );

        if (newViceCaptainID) {
            await Player.updateOne(
                { guildId: guild.id, discordID: String(newViceCaptainID), teamId: team._id },
                { $set: { isViceCaptain: true } }
            );
        }

        await TournamentTeam.updateOne(
            { _id: entry._id },
            { $set: { viceCaptainID: newViceCaptainID } }
        );
    } else {
        await TournamentTeam.updateOne(
            { _id: entry._id },
            { $set: { captainID: targetUser.id, viceCaptainID: newViceCaptainID } }
        );
    }

    // ── Move captain Discord role (this tournament's role) ──
    await moveCaptainRole({
        guild,
        roleId: tournament.captainRoleId,
        oldCaptainId,
        newCaptainId: targetUser.id
    });

    // ── Response ──
    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('👑 CAPTAIN CHANGED')
        .setDescription(
            `Tournament: **${tournament.name}**\n` +
            `Team: **${team.name}**\n\n` +
            `Old Captain: ${oldCaptainId ? `<@${oldCaptainId}>` : 'Not assigned'}\n` +
            `New Captain: ${targetUser}`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   ROLE MANAGEMENT
==================================================== */

/**
 * Move the tournament's captain Discord role from old captain to new captain.
 */
async function moveCaptainRole({ guild, roleId, oldCaptainId, newCaptainId }) {
    if (!roleId) return;

    const role = guild.roles.cache.get(roleId);
    if (!role) return;

    const oldMember = oldCaptainId
        ? await guild.members.fetch(oldCaptainId).catch(() => null)
        : null;
    const newMember = await guild.members.fetch(newCaptainId).catch(() => null);

    if (oldMember?.roles.cache.has(roleId)) {
        await oldMember.roles.remove(roleId).catch(() => null);
    }

    if (newMember && !newMember.roles.cache.has(roleId)) {
        await newMember.roles.add(roleId).catch(() => null);
    }
}
