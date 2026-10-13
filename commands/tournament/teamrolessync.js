/**
 * teamrolessync.js
 *
 * Sync team Discord roles with the database.
 *
 *   • Fixes the role colour
 *   • ADDS the team role to members who are on the team in the DB
 *   • REMOVES the team role from members who are NOT on the team
 *     (skip that pass with `--keep-extra` / keep_extra:true)
 *
 * Membership is the union of:
 *   • Player.teamId            (global player record)
 *   • TournamentPlayer entries (active roster entries for ANY tournament)
 * so someone who is only on a tournament roster is never treated as an
 * "extra" and stripped of their role.
 *
 * Discord hierarchy rules (why some members are skipped):
 *   • The bot can only touch a role that sits BELOW its own highest role.
 *   • The bot can only change the roles of a member whose highest role is
 *     BELOW the bot's highest role — admins/owners therefore cannot be
 *     touched, no matter how low the team role is.
 * Skips are reported instead of silently claiming success.
 *
 * Usage:  .teamrolessync [--preview] [--keep-extra]
 * Slash:  /teamrolessync [preview:true] [keep_extra:true]
 *
 * Aliases: syncroles, rolesync
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Team,
    Player,
    TournamentPlayer,
    ServerConfig
} = require('../../models/Tournament');

const { OWNER_IDS, isOrganizer } = require('../../utils/isOrganizer');

const SKIP_LABELS = {
    member_missing: 'member left the server',
    guild_owner: 'server owner',
    is_bot: 'bot account',
    bot_member_missing: 'I am not in this server',
    missing_manage_roles: 'I lack Manage Roles',
    member_above_bot: 'their highest role is above mine'
};

module.exports = {
    name: 'teamrolessync',
    description: 'Sync all team roles with database data.',
    usage: '.teamrolessync [--preview] [--keep-extra]',
    aliases: ['syncroles', 'rolesync'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.ManageRoles],

    data: new SlashCommandBuilder()
        .setName('teamrolessync')
        .setDescription('Sync all team roles with database data')
        .addBooleanOption(opt =>
            opt.setName('preview')
                .setDescription('Show what would change without touching any role')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('keep_extra')
                .setDescription('Only add missing members — never remove the role from anyone')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            const allowed =
                OWNER_IDS.includes(message.author.id) ||
                await isOrganizer(message.guild.id, message.author.id);

            if (!allowed) {
                return message.reply('🚫 Only organizers can use this command.');
            }

            const flags = (Array.isArray(args) ? args : []).map(a =>
                String(a).toLowerCase().replace(/^--?/, '')
            );

            return await runSync({
                guild: message.guild,
                preview: flags.includes('preview') || flags.includes('dryrun') || flags.includes('dry-run'),
                keepExtra: flags.includes('keep-extra') || flags.includes('keepextra') || flags.includes('keep_extra'),
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[teamrolessync] prefix error:', error);
            return message.reply('❌ Failed to sync team roles.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            const allowed =
                OWNER_IDS.includes(interaction.user.id) ||
                await isOrganizer(interaction.guild.id, interaction.user.id);

            if (!allowed) {
                return interaction.reply({
                    content: '🚫 Only organizers can use this command.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: false });

            return await runSync({
                guild: interaction.guild,
                preview: interaction.options.getBoolean('preview') ?? false,
                keepExtra: interaction.options.getBoolean('keep_extra') ?? false,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[teamrolessync] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to sync team roles.');
            }

            return interaction.reply({
                content: '❌ Failed to sync team roles.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

async function runSync({ guild, reply, preview = false, keepExtra = false }) {
    let teamRoleColorsEnabled = true;
    let teamRoleColorsSettingRead = true;

    try {
        const serverConfig = await ServerConfig.findOne({ guildId: guild.id }).lean();
        teamRoleColorsEnabled = serverConfig?.teamRoleColorsEnabled !== false;
    } catch (error) {
        // Fail closed on color writes, but continue the membership sync.
        console.error('[teamrolessync] could not read team-role color setting:', error);
        teamRoleColorsEnabled = false;
        teamRoleColorsSettingRead = false;
    }

    const colorStatus = teamRoleColorsEnabled
        ? 'Team-role color syncing is enabled.'
        : teamRoleColorsSettingRead
            ? 'Team-role color syncing is disabled; existing Discord role colors will be preserved.'
            : 'Could not verify the color setting; role colors will be preserved for safety.';

    const progressEmbed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle(preview ? '🔎 TEAM ROLE SYNC (PREVIEW)' : '🔄 TEAM ROLE SYNC')
        .setDescription(
            (preview
                ? 'Checking every registered team — nothing will be changed.'
                : 'Going through all registered teams and syncing roles...') + `\n${colorStatus}`
        )
        .setTimestamp();

    const progressMessage = await reply({
        embeds: [progressEmbed]
    });

    const teams = await Team.find({
        guildId: guild.id
    }).lean();

    if (!teams.length) {
        return progressMessage.edit({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('❌ NO TEAMS FOUND')
                    .setDescription('No registered teams were found in this server.')
            ]
        });
    }

    const botMember = guild.members.me;
    const botHighest = botMember?.roles?.highest?.position ?? -1;
    const canManageRoles = botMember?.permissions?.has(PermissionFlagsBits.ManageRoles) ?? false;

    /* ── Every active tournament roster entry, so roster-only players are
          never mistaken for "extra" members. ── */
    const rosterEntries = await TournamentPlayer.find({
        guildId: guild.id,
        isActive: true
    })
        .select('teamId playerId')
        .lean()
        .catch(() => []);

    const rosterPlayerIds = rosterEntries.map(e => e.playerId).filter(Boolean);

    const rosterPlayers = rosterPlayerIds.length
        ? await Player.find({
              guildId: guild.id,
              _id: { $in: rosterPlayerIds }
          })
              .select('_id discordID')
              .lean()
              .catch(() => [])
        : [];

    const discordIdByPlayerId = new Map(
        rosterPlayers.map(p => [String(p._id), p.discordID]).filter(([, id]) => Boolean(id))
    );

    const rosterDiscordIdsByTeamId = new Map();

    for (const entry of rosterEntries) {
        const discordID = discordIdByPlayerId.get(String(entry.playerId));
        if (!discordID || !entry.teamId) continue;

        const key = String(entry.teamId);
        if (!rosterDiscordIdsByTeamId.has(key)) rosterDiscordIdsByTeamId.set(key, new Set());
        rosterDiscordIdsByTeamId.get(key).add(String(discordID));
    }

    const results = [];

    for (const team of teams) {

        try {

            const role = guild.roles.cache.find(r =>
                r.name.toLowerCase() === String(team.name || '').toLowerCase()
            );

            if (!role) {
                results.push(`⚠️ **${team.name}** → Team role does not exist`);
                continue;
            }

            /* ── Members the team should have (DB is the source of truth) ── */
            const players = await Player.find({
                guildId: guild.id,
                teamId: team._id
            }).select('discordID').lean();

            const expectedIds = new Set(
                players.map(p => String(p.discordID || '')).filter(Boolean)
            );

            for (const id of rosterDiscordIdsByTeamId.get(String(team._id)) || []) {
                expectedIds.add(String(id));
            }

            const roleMemberIds = role.members.map(m => String(m.id));

            /* ── Role sits above the bot? Then NOTHING can be done here. ── */
            if (!canManageRoles || role.position >= botHighest) {
                const why = !canManageRoles
                    ? 'I lack the Manage Roles permission'
                    : 'the role is at/above my highest role';

                results.push(
                    `⚠️ **${team.name}** → skipped, ${why} ` +
                        `(role position ${role.position}, my highest ${botHighest})`
                );
                continue;
            }

            const toAdd = [...expectedIds].filter(id => !roleMemberIds.includes(id));
            const toRemove = keepExtra
                ? []
                : roleMemberIds.filter(id => !expectedIds.has(id));

            const skipped = [];
            let added = 0;
            let removed = 0;
            let recolored = false;

            /* ── Colour sync ── */
            if (teamRoleColorsEnabled) {
                const teamColor = parseColor(team.color);

                if (teamColor !== null && role.color !== teamColor) {
                    if (preview) {
                        recolored = true;
                    } else {
                        const ok = await role.setColor(teamColor).then(() => true).catch(() => false);
                        if (ok) recolored = true;
                    }
                }
            }

            /* ── Add missing members ── */
            for (const userId of toAdd) {
                const member = await guild.members.fetch(userId).catch(() => null);

                const skip = cannotManageMember({ guild, member, botMember, botHighest });
                if (skip) {
                    skipped.push(`${userId} (${SKIP_LABELS[skip] || skip})`);
                    continue;
                }

                if (preview) {
                    added++;
                    continue;
                }

                const ok = await member.roles.add(role).then(() => true).catch(() => false);
                if (ok) added++;
                else skipped.push(`${userId} (Discord refused the role change)`);
            }

            /* ── Remove the role from members who are not on the team ── */
            for (const userId of toRemove) {
                const member = await guild.members.fetch(userId).catch(() => null);

                const skip = cannotManageMember({ guild, member, botMember, botHighest });
                if (skip) {
                    skipped.push(`${userId} (${SKIP_LABELS[skip] || skip})`);
                    continue;
                }

                if (preview) {
                    removed++;
                    continue;
                }

                const ok = await member.roles.remove(role).then(() => true).catch(() => false);
                if (ok) removed++;
                else skipped.push(`${userId} (Discord refused the role change)`);
            }

            /* ── Report this team ── */
            const parts = [];

            if (added) parts.push(`+${added} added`);
            if (removed) parts.push(`−${removed} removed`);
            if (recolored) parts.push('colour updated');
            if (skipped.length) parts.push(`⚠️ ${skipped.length} skipped`);

            if (parts.length) {
                const prefixIcon = preview ? '🔎' : '✅';
                results.push(`${prefixIcon} **${team.name}** → ${parts.join(', ')}`);

                for (const skip of skipped.slice(0, 3)) {
                    results.push(`   ↳ skipped ${skip}`);
                }

                if (skipped.length > 3) {
                    results.push(`   ↳ …and ${skipped.length - 3} more skipped`);
                }
            } else {
                results.push(`☑️ **${team.name}** → Already synced`);
            }

            const liveEmbed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(preview ? '🔎 TEAM ROLE SYNC (PREVIEW)' : '🔄 TEAM ROLE SYNC')
                .setDescription(results.join('\n').slice(0, 4000))
                .setFooter({
                    text: `${results.length}/${teams.length} teams checked`
                });

            await progressMessage.edit({
                embeds: [liveEmbed]
            });

        } catch (error) {

            console.error('[teamrolessync] role sync failed for %s:', team.name, error);

            results.push(`❌ **${team.name}** → Failed to sync`);
        }
    }

    const finalEmbed = new EmbedBuilder()
        .setColor(preview ? 0xFEE75C : 0x57F287)
        .setTitle(
            preview
                ? '🔎 TEAM ROLE SYNC PREVIEW'
                : '✅ TEAM ROLE SYNC COMPLETE'
        )
        .setDescription(results.join('\n').slice(0, 4000))
        .addFields({
            name: 'How membership is decided',
            value:
                'A member keeps the team role when they are on that team either as a ' +
                'global player (`Player.teamId`) **or** on an active tournament roster ' +
                '(`TournamentPlayer`).' +
                (keepExtra
                    ? '\n`keep_extra` was used — nobody was stripped of a role.'
                    : '\nUse `.teamrolessync --keep-extra` to only add roles, never remove them.'),
            inline: false
        }, {
            name: 'Team-role colors',
            value: teamRoleColorsEnabled
                ? 'Enabled — matching team colors may be applied to Discord roles.'
                : teamRoleColorsSettingRead
                    ? 'Disabled — existing Discord role colors were left untouched; membership syncing still ran normally.'
                    : 'Setting unavailable — role colors were left untouched for safety; membership syncing still ran normally.',
            inline: false
        })
        .setFooter({
            text: preview
                ? `PREVIEW ONLY — nothing was changed • ${teams.length} teams checked`
                : `${teams.length} teams checked`
        })
        .setTimestamp();

    return progressMessage.edit({
        embeds: [finalEmbed]
    });
}

/* ====================================================
   HELPERS
==================================================== */

/**
 * Why the bot is not allowed to change this member's roles (null = allowed).
 *
 * Discord only lets a bot edit members whose highest role is strictly BELOW
 * the bot's highest role — so admins and the server owner can never be
 * touched, even when the team role itself is far below the bot.
 */
function cannotManageMember({ guild, member, botMember, botHighest }) {
    if (!member) return 'member_missing';
    if (member.id === guild.ownerId) return 'guild_owner';
    if (member.user?.bot) return 'is_bot';
    if (!botMember) return 'bot_member_missing';
    if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) return 'missing_manage_roles';
    if (member.roles.highest.position >= botHighest) return 'member_above_bot';

    return null;
}

function parseColor(color) {

    if (!color) return null;

    const cleaned = String(color)
        .trim()
        .replace('#', '');

    if (!/^[0-9A-Fa-f]{6}$/.test(cleaned)) {
        return null;
    }

    return parseInt(cleaned, 16);
}

module.exports.runSync = runSync;
