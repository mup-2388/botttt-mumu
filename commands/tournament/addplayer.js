/**
 * addplayer.js
 *
 * Add a new player to your global team.
 * Captain or Vice Captain only. Creates a global Player record,
 * syncs to active tournaments, and optionally assigns the tournament player role.
 *
 * With the optional `tournament` option, the player is added to your team
 * in ONE specific tournament (manual registration mode). Conflict checks are
 * per-tournament, so a player who is on a team in another tournament can
 * still join your team here — their global profile stays on their original
 * team.
 *
 * If no player name is given, the Discord username is used automatically.
 *
 * Usage: .addplayer @user [Player Name] [tournament=<key>]
 * Slash: /addplayer user:<user> [player_name:<name>] [tournament:<key>]
 *
 * Aliases: ap
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Player,
    Team,
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer
} = require('../../models/Tournament');
const { syncPlayerToOpenTournaments } = require('../../utils/tournamentSync');
const { getUserFromArgs } = require('../../utils/stringHelpers');

module.exports = {
    name: 'addplayer',
    description: 'Add a player to your global team.',
    usage: '.addplayer @user [Player Name] [tournament=<key>]',
    aliases: ['ap'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('addplayer')
        .setDescription('Add a player to your team')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('User to add')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('player_name')
                .setDescription('Player display name (defaults to Discord username)')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt
                .setName('tournament')
                .setDescription('Optional: add to your team in ONE specific tournament (manual registration)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            const target = message.mentions.users.first()
                || await getUserFromArgs(message, args);

            if (!target) {
                return message.reply('❓ Usage: `.addplayer @user [Player Name] [tournament=<key>]`');
            }

            // Build custom name: strip mention tokens from args, join the rest
            const { tournamentKey, cleanArgs } = parseAddPlayerArgs(args);
            const customName = cleanArgs.join(' ').trim() || null;

            return await runAddPlayer({
                guild: message.guild,
                captainUserId: message.author.id,
                targetUser: target,
                customName,
                tournamentKey,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[addplayer] prefix error:', error);
            return message.reply('❌ Failed to add player.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const target = interaction.options.getUser('user');
            const customName = interaction.options.getString('player_name') || null;
            const tournamentKey = interaction.options.getString('tournament')?.toLowerCase() || null;

            return await runAddPlayer({
                guild: interaction.guild,
                captainUserId: interaction.user.id,
                targetUser: target,
                customName,
                tournamentKey,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[addplayer] slash error:', error);

            if (interaction.replied || interaction.deferred) {
                return interaction.editReply('❌ Failed to add player.');
            }

            return interaction.reply({
                content: '❌ Failed to add player.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   PREFIX PARSING
==================================================== */

/**
 * Split prefix args into: the `tournament=<key>` token (optional) and the
 * remaining name parts (mention tokens stripped).
 */
function parseAddPlayerArgs(args) {
    let tournamentKey = null;
    const cleanArgs = [];

    for (const arg of args) {
        if (arg.toLowerCase().startsWith('tournament=')) {
            tournamentKey = arg.split('=')[1]?.trim().toLowerCase() || null;
            continue;
        }
        const cleaned = arg.replace(/<@!?\d+>/, '').trim();
        if (cleaned) cleanArgs.push(cleaned);
    }

    return { tournamentKey, cleanArgs };
}

/* ====================================================
   CORE LOGIC
==================================================== */

async function runAddPlayer({
    guild,
    captainUserId,
    targetUser,
    customName,
    tournamentKey,
    reply
}) {
    if (tournamentKey) {
        return runTournamentAddPlayer({
            guild,
            captainUserId,
            targetUser,
            customName,
            tournamentKey,
            reply
        });
    }

    return runGlobalAddPlayer({
        guild,
        captainUserId,
        targetUser,
        customName,
        reply
    });
}

/**
 * GLOBAL addplayer (original behavior):
 * Validates: name length, actor is captain/VC, target not already
 * registered globally, target is not a captain of another team.
 */
async function runGlobalAddPlayer({
    guild,
    captainUserId,
    targetUser,
    customName,
    reply
}) {
    const targetUserId = targetUser.id;

    /* ── Resolve player name: custom or Discord username ── */
    const cleanName = (customName && customName.trim()) || targetUser.username || 'Unknown';

    if (cleanName.length < 2) {
        return reply({ content: '❌ Please provide a valid player name (at least 2 characters).' });
    }

    // ── Find actor's team (captain or VC) ──
    let team = await Team.findOne({
        guildId: guild.id,
        captainID: captainUserId
    });

    if (!team) {
        team = await Team.findOne({
            guildId: guild.id,
            viceCaptainID: captainUserId
        });
    }

    if (!team) {
        return reply({ content: '🚫 Only team captains or vice captains can add players.' });
    }

    // ── Self-add check ──
    if (targetUserId === captainUserId) {
        return reply({ content: '❌ You are already the captain/player of this team.' });
    }

    // ── Check if user is already registered ──
    const existing = await Player.findOne({
        guildId: guild.id,
        discordID: targetUserId
    });

    if (existing) {
        return reply({
            content: `❌ This user is already registered as **${existing.name}**.`
        });
    }

    // ── Check if user is captain of another team ──
    const captainConflict = await Team.findOne({
        guildId: guild.id,
        captainID: targetUserId
    });

    if (captainConflict) {
        return reply({
            content: `❌ This user is already captain of **${captainConflict.name}**.`
        });
    }

    // ── Create player ──
    const player = await Player.create({
        guildId: guild.id,
        name: cleanName,
        discordID: targetUserId,
        discordUsername: targetUser.username?.toLowerCase() || null,
        teamId: team._id,
        teamNameSnapshot: team.name,
        isCaptain: false,
        isViceCaptain: false
    });

    // ── Sync to active tournaments ──
    const sync = await syncPlayerToOpenTournaments(guild.id, player);

    // ── Assign tournament player role ──
    const newestSettings = await TournamentSettings.findOne({
        guildId: guild.id,
        registrationOpen: true,
        currentPhase: 'registration'
    }).sort({ createdAt: -1 });

    const targetMember = await guild.members.fetch(targetUserId).catch(() => null);

    const roleResult = await tryAssignRole({
        guild,
        member: targetMember,
        roleId: newestSettings?.tournamentPlayerRoleId || ''
    });

    // ── Response ──
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('🏃 PLAYER ADDED')
        .setDescription(
            `**${player.name}** has joined **${team.name}** globally.\n` +
            `👤 Linked to: <@${targetUserId}>`
        )
        .addFields(
            {
                name: 'Tournament Sync',
                value: `Added to active tournament entries: **${sync.syncedTournaments}**`,
                inline: false
            },
            {
                name: 'Tournament Player Role',
                value: buildRoleStatusText(roleResult),
                inline: false
            }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/**
 * TOURNAMENT addplayer (manual registration mode):
 * Adds a player to your team in ONE specific tournament only.
 *
 * - Captain/VC is resolved per-tournament (TournamentTeam.captainID /
 *   viceCaptainID), with a fallback to the global team captain/VC.
 * - Conflict checks are per-tournament: a player who is on a team in
 *   ANOTHER tournament can still join here.
 * - The target's global profile is only created when they have none;
 *   otherwise it stays on their original team.
 */
async function runTournamentAddPlayer({
    guild,
    captainUserId,
    targetUser,
    customName,
    tournamentKey,
    reply
}) {
    const targetUserId = targetUser.id;

    /* ── Resolve player name: custom or Discord username ── */
    const cleanName = (customName && customName.trim()) || targetUser.username || 'Unknown';

    if (cleanName.length < 2) {
        return reply({ content: '❌ Please provide a valid player name (at least 2 characters).' });
    }

    /* ── Resolve tournament ── */
    const tournament = await TournamentSettings.findOne({
        guildId: guild.id,
        tournamentKey
    });

    if (!tournament) {
        return reply({ content: `❌ Tournament \`${tournamentKey}\` not found.` });
    }

    if (tournament.currentPhase === 'completed') {
        return reply({
            content: `❌ **${tournament.name}** is already completed.`
        });
    }

    /* ── Self-add check ── */
    if (targetUserId === captainUserId) {
        return reply({ content: '❌ You are already a player of this team in this tournament.' });
    }

    /* ── Resolve actor's team in THIS tournament ── */
    let entry = await TournamentTeam.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        isActive: true,
        $or: [
            { captainID: captainUserId },
            { viceCaptainID: captainUserId }
        ]
    }).populate('teamId');

    let team = entry?.teamId || null;
    let usedGlobalFallback = false;

    if (!team) {
        /* Fallback: actor's global team, if it has an entry in this tournament. */
        const globalTeam = await Team.findOne({
            guildId: guild.id,
            $or: [
                { captainID: captainUserId },
                { viceCaptainID: captainUserId }
            ]
        });

        if (globalTeam) {
            entry = await TournamentTeam.findOne({
                guildId: guild.id,
                tournamentId: tournament._id,
                teamId: globalTeam._id
            }).populate('teamId');

            if (entry) {
                team = entry.teamId;
                usedGlobalFallback = true;
            }
        }
    }

    if (!team || !entry) {
        return reply({
            content:
                `🚫 You are not a captain or vice captain of a team in ` +
                `**${tournament.name}**.\n` +
                `Register your team first: \`/register team_name:<Team Name> tournament:${tournament.tournamentKey}\``
        });
    }

    if (!entry.isActive) {
        return reply({
            content: `❌ **${team.name}** is not active in **${tournament.name}**.`
        });
    }

    /* ── Per-tournament conflict: target already a player in this tournament ── */
    const targetPlayer = await Player.findOne({
        guildId: guild.id,
        discordID: targetUserId
    }).populate('teamId');

    if (targetPlayer) {
        const targetTourPlayer = await TournamentPlayer.findOne({
            guildId: guild.id,
            tournamentId: tournament._id,
            playerId: targetPlayer._id,
            isActive: true
        });

        if (targetTourPlayer) {
            const linkedTeam = targetTourPlayer.teamNameSnapshot || 'another team';
            return reply({
                content:
                    `❌ <@${targetUserId}> is already on **${linkedTeam}** in ` +
                    `**${tournament.name}**.\n` +
                    `One team per tournament.`
            });
        }

        /* Per-tournament conflict: target captains another team here. */
        const targetCaptainEntry = await TournamentTeam.findOne({
            guildId: guild.id,
            tournamentId: tournament._id,
            isActive: true,
            captainID: targetUserId
        });

        if (targetCaptainEntry && String(targetCaptainEntry.teamId) !== String(team._id)) {
            return reply({
                content:
                    `❌ <@${targetUserId}> already captains ` +
                    `**${targetCaptainEntry.teamNameSnapshot}** in **${tournament.name}**.`
            });
        }
    }

    /* ── Ensure the target has a global player record ── */
    let player = targetPlayer;
    let affiliationNote = null;

    if (!player) {
        player = await Player.create({
            guildId: guild.id,
            name: cleanName,
            discordID: targetUserId,
            discordUsername: targetUser.username?.toLowerCase() || null,
            teamId: team._id,
            teamNameSnapshot: team.name,
            isCaptain: false,
            isViceCaptain: false
        });
    } else if (
        String(player.teamId?._id || '') !== String(team._id) &&
        (player.teamId || String(player.teamNameSnapshot || '').toUpperCase() === 'FREE AGENT')
    ) {
        /*
         * The target belongs to a DIFFERENT global team (in another
         * tournament). Leave the global record untouched; membership in
         * this tournament is stored on the TournamentPlayer entry below.
         */
        affiliationNote =
            `<@${targetUserId}> stays on **${player.teamId?.name || player.teamNameSnapshot}** globally — ` +
            `they join **${team.name}** for **${tournament.name}** only.`;
    } else {
        /*
         * No team yet (free agent) or already on this team — keep/align
         * the global record with this team.
         */
        if (!player.teamId || String(player.teamNameSnapshot || '').toUpperCase() === 'FREE AGENT') {
            await Player.updateOne(
                { _id: player._id },
                {
                    $set: {
                        teamId: team._id,
                        teamNameSnapshot: team.name
                    }
                }
            );
        }
    }

    /* ── Create / reactivate the tournament player entry ── */
    await TournamentPlayer.findOneAndUpdate(
        {
            guildId: guild.id,
            tournamentId: tournament._id,
            playerId: player._id
        },
        {
            $set: {
                guildId: guild.id,
                tournamentId: tournament._id,
                playerId: player._id,
                teamId: team._id,
                playerNameSnapshot: player.name || cleanName,
                teamNameSnapshot: team.name,
                isActive: true
            },
            $setOnInsert: {
                isCaptain: false,
                isViceCaptain: false,
                stats: {
                    played: 0,
                    goals: 0,
                    assists: 0,
                    saves: 0,
                    tackles: 0,
                    interceptions: 0,
                    yc: 0,
                    rc: 0,
                    mvps: 0
                }
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    /* ── Assign tournament player role (from THIS tournament's settings) ── */
    const targetMember = await guild.members.fetch(targetUserId).catch(() => null);

    const roleResult = await tryAssignRole({
        guild,
        member: targetMember,
        roleId: tournament.tournamentPlayerRoleId || ''
    });

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(`🏃 PLAYER ADDED — ${tournament.name}`)
        .setDescription(
            `${tournament.emoji || '🏆'} **${player.name}** joined **${team.name}** in **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n` +
            `👤 Linked to: <@${targetUserId}>\n` +
            (affiliationNote ? `\nℹ️ ${affiliationNote}` : '')
        )
        .addFields(
            {
                name: 'Scope',
                value:
                    usedGlobalFallback
                        ? 'Added via your global team in this tournament.'
                        : 'Added to your team in this tournament only (manual registration).',
                inline: false
            },
            {
                name: 'Tournament Player Role',
                value: buildRoleStatusText(roleResult),
                inline: false
            }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   ROLE ASSIGNMENT
==================================================== */

/**
 * Attempt to assign a tournament player role to a member.
 * Checks all permission and hierarchy conditions before assigning.
 */
async function tryAssignRole({ guild, member, roleId }) {
    if (!roleId) return { status: 'not_configured' };
    if (!member) return { status: 'member_missing' };

    const role = guild.roles.cache.get(roleId);
    if (!role) return { status: 'role_missing' };

    const botMember = guild.members.me;
    if (!botMember) return { status: 'bot_member_missing' };

    if (!botMember.permissions.has('ManageRoles')) return { status: 'missing_manage_roles', role };
    if (member.roles.cache.has(role.id)) return { status: 'already_has_role', role };
    if (role.managed) return { status: 'managed_role', role };
    if (botMember.roles.highest.position <= role.position) return { status: 'role_too_high', role };

    try {
        await member.roles.add(role);
        return { status: 'assigned', role };
    } catch {
        return { status: 'assign_failed', role };
    }
}

/**
 * Build a human-readable status string for the role assignment result.
 */
function buildRoleStatusText(result) {
    switch (result.status) {
        case 'assigned': return `Assigned: <@&${result.role.id}>`;
        case 'already_has_role': return `Already has: <@&${result.role.id}>`;
        case 'not_configured': return 'Not configured';
        case 'role_missing': return 'Configured role missing';
        case 'missing_manage_roles': return `Bot lacks Manage Roles for <@&${result.role.id}>`;
        case 'role_too_high': return `Role too high: <@&${result.role.id}>`;
        case 'managed_role': return 'Managed role cannot be assigned';
        case 'member_missing': return 'Member not found';
        case 'bot_member_missing': return 'Bot member missing';
        case 'assign_failed': return `Failed to assign: <@&${result.role.id}>`;
        default: return 'Unknown';
    }
}
