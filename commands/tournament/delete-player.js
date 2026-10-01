/**
 * delete-player.js
 *
 * Remove a global player entirely and deactivate all tournament entries.
 * Removes tournament player role if configured.
 *
 * Usage:  .delete-player @user
 * Slash:  /delete-player user:<user>
 *
 * Aliases: deleteplayer, removeplayer, dp
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Player,
    TournamentPlayer,
    UserProfile,
    TournamentSettings
} = require('../../models/Tournament');

const { getUserFromArgs } = require('../../utils/stringHelpers');

const { isOrganizer } = require('../../utils/isOrganizer');
const { getDefaultTournament } = require('../../utils/getTournament');

module.exports = {
    name: 'delete-player',
    description: 'Remove a global player and deactivate tournament entries.',
    usage: '.delete-player @user',
    aliases: ['deleteplayer', 'removeplayer', 'dp'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('delete-player')
        .setDescription('Remove a global player')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Player to remove')
                .setRequired(true)
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

            const target = message.mentions.users.first()
                || await getUserFromArgs(message, args);

            if (!target) {
                return message.reply('❌ Usage: `.delete-player @user`');
            }

            return await runDeletePlayer({
                guild: message.guild,
                targetUser: target,
                targetUserId: target.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[delete-player] prefix error:', error);
            return message.reply('❌ Failed to remove player.');
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

            return await runDeletePlayer({
                guild: interaction.guild,
                targetUserId: interaction.options.getUser('user').id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[delete-player] slash error:', error);

            if (interaction.replied || interaction.deferred) {
                return interaction.editReply('❌ Failed to remove player.');
            }

            return interaction.reply({ content: '❌ Failed to remove player.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Permanently remove a player:
 * 1. Deactivate all TournamentPlayer entries
 * 2. Delete the global Player record
 * 3. Update UserProfile (keep display name)
 * 4. Remove tournament player role from Discord member
 */
async function runDeletePlayer({ guild, targetUserId, reply }) {
    /* ── Find the player ── */
    const player = await Player.findOne({
        guildId: guild.id,
        discordID: targetUserId
    }).populate('teamId');

    if (!player) {
        return reply({ content: '❌ That user is not registered as a player in this server.' });
    }

    const teamName =
        player.teamId?.name ||
        player.teamNameSnapshot ||
        'No Team';

    /* ── Deactivate tournament entries ── */
    const tournamentUpdate = await TournamentPlayer.updateMany(
        { guildId: guild.id, playerId: player._id },
        { $set: { isActive: false } }
    );

    /* ── Delete global player record ── */
    await Player.deleteOne({ _id: player._id });

    /* ── Preserve display name in UserProfile ── */
    await UserProfile.updateOne(
        { guildId: guild.id, discordID: targetUserId },
        { $set: { displayName: player.name } },
        { upsert: true }
    ).catch(() => null);

    /* ── Remove tournament player role from Discord ── */
    const settings = await getDefaultTournament(guild.id, { includeCompleted: true })
        .catch(() => null);
    const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
    const roleResult = await tryRemoveRole({
        guild,
        member: targetMember,
        roleId: settings?.tournamentPlayerRoleId || ''
    });

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🗑️ PLAYER REMOVED')
        .setDescription(
            `**${player.name}** has been removed globally.\n\n` +
            `👤 User: <@${targetUserId}>\n` +
            `🏟️ Team: **${teamName}**\n\n` +
            `Tournament entries deactivated: **${tournamentUpdate.modifiedCount || 0}**`
        )
        .addFields({
            name: 'Tournament Player Role',
            value: buildRoleRemovalStatus(roleResult),
            inline: false
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   ROLE HELPERS
==================================================== */

/** Attempt to remove a role from a member with full permission/hierarchy checks. */
async function tryRemoveRole({ guild, member, roleId }) {
    if (!roleId) return { status: 'not_configured' };
    if (!member) return { status: 'member_missing' };

    const role = guild.roles.cache.get(roleId);
    if (!role) return { status: 'role_missing' };

    const botMember = guild.members.me;
    if (!botMember) return { status: 'bot_member_missing' };

    if (!botMember.permissions.has('ManageRoles')) return { status: 'missing_manage_roles' };
    if (role.managed) return { status: 'managed_role' };
    if (botMember.roles.highest.position <= role.position) return { status: 'role_too_high' };
    if (!member.roles.cache.has(role.id)) return { status: 'did_not_have_role' };

    try {
        await member.roles.remove(role);
        return { status: 'removed', role };
    } catch {
        return { status: 'remove_failed', role };
    }
}

/** Human-readable status for the role removal attempt. */
function buildRoleRemovalStatus(result) {
    const messages = {
        removed: `Removed automatically: <@&${result.role.id}>`,
        did_not_have_role: 'User did not have role',
        not_configured: 'Not configured',
        role_missing: 'Configured role no longer exists',
        missing_manage_roles: 'Bot lacks Manage Roles permission',
        role_too_high: 'Role is above bot role',
        managed_role: 'Managed role cannot be removed',
        member_missing: 'Member not found',
        bot_member_missing: 'Bot member missing',
        remove_failed: 'Failed to remove role'
    };

    return messages[result.status] || 'Unknown';
}
