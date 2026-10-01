/**
 * changecaptain.js
 *
 * Change the captain of a team. Current captain or vice captain can initiate.
 * Works for the server's DEFAULT tournament unless `tournament=<key>` is given;
 * the team is the one you lead IN THAT TOURNAMENT.
 * Preserves the vice captain unless the new captain was the VC.
 * Moves the tournament's captain Discord role if configured.
 *
 * Usage: .cc @user [tournament=<key>]
 * Slash: /changecaptain user:<user> [tournament:<key>]
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
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const {
    resolveActorTeam,
    getRosterMembership,
    effectiveCaptainId,
    effectiveViceCaptainId,
    sameId
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'changecaptain',
    description: 'Change captain of your team.',
    usage: '.cc @user [tournament=<key>]',
    aliases: ['cc', 'captainchange'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('changecaptain')
        .setDescription('Change captain of your team')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('New captain')
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

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const target = message.mentions.users.first() || await getUserFromArgs(message, parsedKey.rest);

            if (!target) {
                return message.reply('❌ Usage: `.cc @user [tournament=<key>]`');
            }

            return await runChangeCaptain({
                guild: message.guild,
                actorId: message.author.id,
                targetUser: target,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
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
 * Validates: actor is captain/VC in that tournament, target is on the same team there.
 * Preserves the vice captain unless the new captain was the VC (promoted).
 *
 * Writes:
 *  - TournamentPlayer flags + TournamentTeam.viceCaptainID (this tournament)
 *  - the team's captain: global Team/Player records when the team uses its
 *    global captain here, otherwise the per-tournament TournamentTeam.captainID
 */
async function runChangeCaptain({ guild, actorId, targetUser, tournamentKey = null, reply }) {
    // ── Self-change check ──
    if (actorId === targetUser.id) {
        return reply({ content: '❌ You cannot make yourself captain — you already are.' });
    }

    // ── Find actor's team in the tournament ──
    const { tournament, ctx, error } = await resolveActorTeam({
        guildId: guild.id,
        userId: actorId,
        tournamentKey,
        need: 'manage',
        noun: 'use `.cc`'
    });

    if (error) return reply({ content: error });

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

    const oldCaptainId = effectiveCaptainId(entry, team) || actorId;
    const oldViceId = effectiveViceCaptainId(entry, team);
    const usesGlobalCaptain = !entry.captainID;

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
            `Old Captain: <@${oldCaptainId}>\n` +
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

    const oldMember = await guild.members.fetch(oldCaptainId).catch(() => null);
    const newMember = await guild.members.fetch(newCaptainId).catch(() => null);

    if (oldMember?.roles.cache.has(roleId)) {
        await oldMember.roles.remove(roleId).catch(() => null);
    }

    if (newMember && !newMember.roles.cache.has(roleId)) {
        await newMember.roles.add(roleId).catch(() => null);
    }
}
