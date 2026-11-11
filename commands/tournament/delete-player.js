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
const { optionalStep } = require('../../utils/optionalStep');

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
            return message.reply(
                '❌ Failed to remove player.\n`' +
                    String(error?.message || error).slice(0, 200) +
                    '`'
            );
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

            const reason = String(error?.message || error).slice(0, 200);

            if (interaction.replied || interaction.deferred) {
                return interaction.editReply(
                    '❌ Failed to remove player.\n`' + reason + '`'
                );
            }

            return interaction.reply({
                content: '❌ Failed to remove player.\n`' + reason + '`',
                ephemeral: true
            });
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
        return reply({
            content:
                'ℹ️ That user is not registered as a player in this server — nothing to remove.'
        });
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

    /* ── Optional cleanup below ──
       The player is already deleted at this point, so a failure in any of
       these steps must never turn a successful removal into a failure. */
    await optionalStep(
        'delete-player: UserProfile update',
        () =>
            UserProfile.updateOne(
                { guildId: guild.id, discordID: targetUserId },
                { $set: { displayName: player.name } },
                { upsert: true }
            ),
        null
    );

    const roleResult = await optionalStep(
        'delete-player: tournament player role cleanup',
        async () => {
            const settings = await getDefaultTournament(guild.id, {
                includeCompleted: true
            }).catch(() => null);

            const targetMember = await guild.members
                .fetch(targetUserId)
                .catch(() => null);

            return tryRemoveRole({
                guild,
                member: targetMember,
                roleId: settings?.tournamentPlayerRoleId || ''
            });
        },
        { status: 'remove_failed' }
    );

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

/**
 * Human-readable status for the role removal attempt.
 *
 * NOTE: this used to be an object literal, which meant EVERY message was
 * evaluated eagerly — including `<@&${result.role.id}>` — so any status that
 * carries no `role` (not configured, member missing, role too high, ...)
 * threw a TypeError AFTER the player had already been deleted and the command
 * reported "❌ Failed to remove player" even though it had succeeded.
 * A switch keeps the messages lazy and safe.
 */
function buildRoleRemovalStatus(result) {
    const roleRef = result?.role?.id ? `<@&${result.role.id}>` : 'tournament player role';

    switch (result?.status) {
        case 'removed':
            return `Removed automatically: ${roleRef}`;
        case 'did_not_have_role':
            return 'User did not have role';
        case 'not_configured':
            return 'Not configured';
        case 'role_missing':
            return 'Configured role no longer exists';
        case 'missing_manage_roles':
            return 'Bot lacks Manage Roles permission';
        case 'role_too_high':
            return 'Role is above bot role';
        case 'managed_role':
            return 'Managed role cannot be removed';
        case 'member_missing':
            return 'Member not found';
        case 'bot_member_missing':
            return 'Bot member missing';
        case 'remove_failed':
            return `Failed to remove ${roleRef}`;
        default:
            return 'Unknown';
    }
}
