/**
 * addplayer.js
 *
 * Add ONE or MANY players to your team in a single command.
 * Captain or Vice Captain only. Creates global Player record(s),
 * syncs to active tournaments, and optionally assigns the tournament player role.
 *
 * Multiple users (prefix only):
 *   .addplayer @user1 @user2 @user3 [tournament=<key>]
 * In bulk mode each player is named after their Discord username (a custom
 * player name only applies when exactly one user is added). The slash
 * command stays single-user because this discord.js version cannot declare
 * multi-user options.
 *
 * With the optional `tournament` option, players are added to your team in
 * ONE specific tournament (manual registration mode). Conflict checks are
 * per-tournament, so a player who is on a team in another tournament can
 * still join your team here — their global profile stays on their original
 * team.
 *
 * Usage: .addplayer @user1 [@user2 ...] [Player Name] [tournament=<key>]
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

/** Soft cap for prefix bulk adds (slash is capped by Discord at 1+10). */
const MAX_BULK_PREFIX = 30;

module.exports = {
    name: 'addplayer',
    description: 'Add one or more players to your team (prefix: @user1 @user2 ...).',
    usage: '.addplayer @user1 [@user2 ...] [Player Name] [tournament=<key>]',
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
                .setDescription('Player display name (single user only, defaults to Discord username)')
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

            const { tournamentKey, cleanArgs } = parseAddPlayerArgs(args);

            // Collect every mentioned user (bulk), else fall back to one.
            let targets = dedupe([...message.mentions.users.values()]);
            if (!targets.length) {
                const single = await getUserFromArgs(message, args);
                if (single) targets = [single];
            }

            if (!targets.length) {
                return message.reply('❓ Usage: `.addplayer @user1 [@user2 ...] [Player Name] [tournament=<key>]`');
            }

            if (targets.length > MAX_BULK_PREFIX) {
                return message.reply(
                    `❌ Too many users at once (max **${MAX_BULK_PREFIX}**). ` +
                    `Please split into smaller groups.`
                );
            }

            const customName = cleanArgs.join(' ').trim() || null;

            return await runAddPlayer({
                guild: message.guild,
                captainUserId: message.author.id,
                targetUsers: targets,
                customName,
                tournamentKey,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[addplayer] prefix error:', error);
            return message.reply('❌ Failed to add player(s).');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const primary = interaction.options.getUser('user');
            const targetUsers = [primary].filter(Boolean);
            const customName = interaction.options.getString('player_name') || null;
            const tournamentKey = interaction.options.getString('tournament')?.toLowerCase() || null;

            return await runAddPlayer({
                guild: interaction.guild,
                captainUserId: interaction.user.id,
                targetUsers,
                customName,
                tournamentKey,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[addplayer] slash error:', error);

            if (interaction.replied || interaction.deferred) {
                return interaction.editReply('❌ Failed to add player(s).');
            }

            return interaction.reply({
                content: '❌ Failed to add player(s).',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   HELPERS
==================================================== */

function dedupe(users) {
    const seen = new Set();
    const out = [];
    for (const u of users) {
        if (!u || seen.has(u.id)) continue;
        seen.add(u.id);
        out.push(u);
    }
    return out;
}

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
   CORE LOGIC — dispatcher
==================================================== */

async function runAddPlayer({
    guild,
    captainUserId,
    targetUsers,
    customName,
    tournamentKey,
    reply
}) {
    if (tournamentKey) {
        return targetUsers.length === 1
            ? runTournamentAddSingle({ guild, captainUserId, targetUser: targetUsers[0], customName, tournamentKey, reply })
            : runTournamentAddBulk({ guild, captainUserId, targetUsers, tournamentKey, reply });
    }

    return targetUsers.length === 1
        ? runGlobalAddSingle({ guild, captainUserId, targetUser: targetUsers[0], customName, reply })
        : runGlobalAddBulk({ guild, captainUserId, targetUsers, reply });
}

/* ====================================================
   GLOBAL FLOW
==================================================== */

/** Resolve the actor's global team (captain or VC). */
async function resolveGlobalTeam(guildId, captainUserId) {
    let team = await Team.findOne({ guildId, captainID: captainUserId });
    if (!team) {
        team = await Team.findOne({ guildId, viceCaptainID: captainUserId });
    }
    return team;
}

/**
 * Per-target global add. Returns a result object instead of replying:
 *   { ok: true,  player, team, sync, roleResult, cleanName }
 *   { ok: false, message }
 */
async function attemptGlobalAdd({ guild, captainUserId, team, targetUser, customName }) {
    const targetUserId = targetUser.id;

    const cleanName = (customName && customName.trim()) || targetUser.username || 'Unknown';
    if (cleanName.length < 2) {
        return { ok: false, message: '❌ Invalid player name (at least 2 characters).' };
    }

    if (targetUserId === captainUserId) {
        return { ok: false, message: '❌ You are already the captain/player of this team.' };
    }

    const existing = await Player.findOne({ guildId: guild.id, discordID: targetUserId });
    if (existing) {
        return { ok: false, message: `❌ Already registered as **${existing.name}**.` };
    }

    const captainConflict = await Team.findOne({ guildId: guild.id, captainID: targetUserId });
    if (captainConflict) {
        return { ok: false, message: `❌ Already captain of **${captainConflict.name}**.` };
    }

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

    const sync = await syncPlayerToOpenTournaments(guild.id, player);

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

    return { ok: true, player, team, sync, roleResult, cleanName };
}

/** Single-user global add — original detailed reply. */
async function runGlobalAddSingle({ guild, captainUserId, targetUser, customName, reply }) {
    const team = await resolveGlobalTeam(guild.id, captainUserId);
    if (!team) {
        return reply({ content: '🚫 Only team captains or vice captains can add players.' });
    }

    const res = await attemptGlobalAdd({ guild, captainUserId, team, targetUser, customName });
    if (!res.ok) {
        return reply({ content: res.message });
    }

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('🏃 PLAYER ADDED')
        .setDescription(
            `**${res.player.name}** has joined **${team.name}** globally.\n` +
            `👤 Linked to: <@${targetUser.id}>`
        )
        .addFields(
            {
                name: 'Tournament Sync',
                value: `Added to active tournament entries: **${res.sync.syncedTournaments}**`,
                inline: false
            },
            {
                name: 'Tournament Player Role',
                value: buildRoleStatusText(res.roleResult),
                inline: false
            }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/** Bulk global add — one summary reply. */
async function runGlobalAddBulk({ guild, captainUserId, targetUsers, reply }) {
    const team = await resolveGlobalTeam(guild.id, captainUserId);
    if (!team) {
        return reply({ content: '🚫 Only team captains or vice captains can add players.' });
    }

    const results = [];
    for (const target of targetUsers) {
        results.push({
            target,
            res: await attemptGlobalAdd({ guild, captainUserId, team, targetUser: target, customName: null })
        });
    }

    return reply({ embeds: [buildBulkEmbed({ teamName: team.name, results, scopeNote: 'added globally' })] });
}

/* ====================================================
   TOURNAMENT FLOW
==================================================== */

/**
 * Resolve the actor's team in ONE tournament.
 * Returns { entry, team, usedGlobalFallback } or { message }.
 */
async function resolveTournamentTeam(guild, tournament, captainUserId) {
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
        return {
            message:
                `🚫 You are not a captain or vice captain of a team in ` +
                `**${tournament.name}**.\n` +
                `Register your team first: \`/register team_name:<Team Name> tournament:${tournament.tournamentKey}\``
        };
    }

    if (!entry.isActive) {
        return { message: `❌ **${team.name}** is not active in **${tournament.name}**.` };
    }

    return { entry, team, usedGlobalFallback };
}

/**
 * Per-target tournament add. Returns a result object instead of replying:
 *   { ok: true, player, team, roleResult, cleanName, affiliationNote }
 *   { ok: false, message }
 */
async function attemptTournamentAdd({ guild, tournament, team, captainUserId, targetUser, customName }) {
    const targetUserId = targetUser.id;

    const cleanName = (customName && customName.trim()) || targetUser.username || 'Unknown';
    if (cleanName.length < 2) {
        return { ok: false, message: '❌ Invalid player name (at least 2 characters).' };
    }

    if (targetUserId === captainUserId) {
        return { ok: false, message: '❌ You are already a player of this team in this tournament.' };
    }

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
            return {
                ok: false,
                message: `❌ Already on **${linkedTeam}** in this tournament (one team per tournament).`
            };
        }

        const targetCaptainEntry = await TournamentTeam.findOne({
            guildId: guild.id,
            tournamentId: tournament._id,
            isActive: true,
            captainID: targetUserId
        });

        if (targetCaptainEntry && String(targetCaptainEntry.teamId) !== String(team._id)) {
            return {
                ok: false,
                message: `❌ Already captains **${targetCaptainEntry.teamNameSnapshot}** in this tournament.`
            };
        }
    }

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
        affiliationNote =
            `stays on **${player.teamId?.name || player.teamNameSnapshot}** globally`;
    } else if (!player.teamId || String(player.teamNameSnapshot || '').toUpperCase() === 'FREE AGENT') {
        await Player.updateOne(
            { _id: player._id },
            { $set: { teamId: team._id, teamNameSnapshot: team.name } }
        );
    }

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

    const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
    const roleResult = await tryAssignRole({
        guild,
        member: targetMember,
        roleId: tournament.tournamentPlayerRoleId || ''
    });

    return { ok: true, player, team, roleResult, cleanName, affiliationNote };
}

/** Single-user tournament add — original detailed reply. */
async function runTournamentAddSingle({ guild, captainUserId, targetUser, customName, tournamentKey, reply }) {
    const tournament = await TournamentSettings.findOne({ guildId: guild.id, tournamentKey });
    if (!tournament) {
        return reply({ content: `❌ Tournament \`${tournamentKey}\` not found.` });
    }
    if (tournament.currentPhase === 'completed') {
        return reply({ content: `❌ **${tournament.name}** is already completed.` });
    }

    const resolved = await resolveTournamentTeam(guild, tournament, captainUserId);
    if (resolved.message) {
        return reply({ content: resolved.message });
    }

    const res = await attemptTournamentAdd({
        guild,
        tournament,
        team: resolved.team,
        captainUserId,
        targetUser,
        customName
    });

    if (!res.ok) {
        return reply({ content: res.message });
    }

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(`🏃 PLAYER ADDED — ${tournament.name}`)
        .setDescription(
            `${tournament.emoji || '🏆'} **${res.player.name}** joined **${resolved.team.name}** in **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n` +
            `👤 Linked to: <@${targetUser.id}>\n` +
            (res.affiliationNote ? `\nℹ️ <@${targetUser.id}> ${res.affiliationNote} — joins **${resolved.team.name}** for **${tournament.name}** only.` : '')
        )
        .addFields(
            {
                name: 'Scope',
                value: resolved.usedGlobalFallback
                    ? 'Added via your global team in this tournament.'
                    : 'Added to your team in this tournament only (manual registration).',
                inline: false
            },
            {
                name: 'Tournament Player Role',
                value: buildRoleStatusText(res.roleResult),
                inline: false
            }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/** Bulk tournament add — one summary reply. */
async function runTournamentAddBulk({ guild, captainUserId, targetUsers, tournamentKey, reply }) {
    const tournament = await TournamentSettings.findOne({ guildId: guild.id, tournamentKey });
    if (!tournament) {
        return reply({ content: `❌ Tournament \`${tournamentKey}\` not found.` });
    }
    if (tournament.currentPhase === 'completed') {
        return reply({ content: `❌ **${tournament.name}** is already completed.` });
    }

    const resolved = await resolveTournamentTeam(guild, tournament, captainUserId);
    if (resolved.message) {
        return reply({ content: resolved.message });
    }

    const results = [];
    for (const target of targetUsers) {
        results.push({
            target,
            res: await attemptTournamentAdd({
                guild,
                tournament,
                team: resolved.team,
                captainUserId,
                targetUser: target,
                customName: null
            })
        });
    }

    const emoji = tournament.emoji || '🏆';
    return reply({
        embeds: [buildBulkEmbed({
            title: `🏃 PLAYERS ADDED — ${tournament.name}`,
            teamName: resolved.team.name,
            tournamentName: tournament.name,
            emoji,
            results,
            scopeNote: `added to **${resolved.team.name}** in **${tournament.name}** (manual registration)`
        })]
    });
}

/* ====================================================
   BULK EMBED
==================================================== */

/**
 * Build a single summary embed for a bulk add.
 * `results` is an array of { target, res }.
 */
function buildBulkEmbed({ title, teamName, tournamentName, emoji, results, scopeNote }) {
    const added = results.filter(r => r.res.ok);
    const failed = results.filter(r => !r.res.ok);

    const addedLines = added.map(r =>
        `• **${r.res.player.name}** — <@${r.target.id}>${r.res.affiliationNote ? ` _(${r.res.affiliationNote})_` : ''}`
    );

    const failedLines = failed.map(r =>
        `• <@${r.target.id}> — ${r.res.message.replace(/^❌\s*/, '')}`
    );

    const embed = new EmbedBuilder()
        .setColor(added.length ? 0x2ECC71 : 0xE74C3C)
        .setTitle(title || '🏃 PLAYERS ADDED')
        .setDescription(
            (emoji ? `${emoji} ` : '') +
            `${added.length} of **${results.length}** ${scopeNote}.\n` +
            `Team: **${teamName}**${tournamentName ? `\nTournament: **${tournamentName}**` : ''}`
        )
        .setTimestamp();

    if (addedLines.length) {
        embed.addFields({
            name: '✅ Added',
            value: addedLines.join('\n').substring(0, 1024),
            inline: false
        });
    }

    if (failedLines.length) {
        embed.addFields({
            name: '⚠️ Skipped',
            value: failedLines.join('\n').substring(0, 1024),
            inline: false
        });
    }

    return embed;
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
