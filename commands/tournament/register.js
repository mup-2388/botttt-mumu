/**
 * register.js
 *
 * Register a new global team. Creates the Team + captain Player record,
 * syncs to open tournaments, and assigns captain/player roles.
 *
 * With the optional `tournament` option, the team is registered for ONE
 * specific tournament (manual registration mode) instead of all open
 * tournaments. Conflict checks are per-tournament, so a player who is on a
 * team — or captains a team — in another tournament can still create a new
 * team or re-register an existing one here.
 *
 * Usage:  .register <Team Name> [tournament=<key>]
 * Slash:  /register team_name:<name> [tournament:<key>]
 *
 * Aliases: reg
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const {
    Team,
    Player,
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer
} = require('../../models/Tournament');

const {
    syncTeamToOpenTournaments,
    enrollTeamInTournament
} = require('../../utils/tournamentSync');
const { escapeRegex } = require('../../utils/stringHelpers');
const { getDefaultTournament } = require('../../utils/getTournament');

module.exports = {
    name: 'register',
    description: 'Register a global team.',
    usage: '.register <Team Name> [tournament=<key>]',
    aliases: ['reg'],
    hidden: false,
    cooldown: 10,

    data: new SlashCommandBuilder()
        .setName('register')
        .setDescription('Register your global team')
        .addStringOption(opt =>
            opt.setName('team_name')
                .setDescription('Your team name')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt
                .setName('tournament')
                .setDescription('Optional: register for ONE specific tournament (manual registration)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            const { tournamentKey, teamNameInput } = parseRegisterArgs(args);

            if (!teamNameInput) {
                return message.reply('❓ Usage: `.register <Team Name> [tournament=<key>]`');
            }

            return await runRegister({
                guild: message.guild,
                member: message.member,
                user: message.author,
                teamNameInput,
                tournamentKey,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[register] prefix error:', error);
            return message.reply('❌ Failed to register team.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return await runRegister({
                guild: interaction.guild,
                member: interaction.member,
                user: interaction.user,
                teamNameInput: interaction.options.getString('team_name'),
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[register] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to register team.');
            }

            return interaction.reply({ content: '❌ Failed to register team.', ephemeral: true });
        }
    }
};

/* ====================================================
   PREFIX PARSING
==================================================== */

/**
 * Split prefix args into the team name and an optional
 * `tournament=<key>` token.
 */
function parseRegisterArgs(args) {
    let tournamentKey = null;
    const nameParts = [];

    for (const arg of args) {
        if (arg.toLowerCase().startsWith('tournament=')) {
            tournamentKey = arg.split('=')[1]?.trim().toLowerCase() || null;
            continue;
        }
        nameParts.push(arg);
    }

    return { tournamentKey, teamNameInput: nameParts.join(' ').trim() };
}

/* ====================================================
   CORE LOGIC
==================================================== */

async function runRegister({
    guild,
    member,
    user,
    teamNameInput,
    tournamentKey,
    reply
}) {
    if (tournamentKey) {
        return runTournamentRegister({
            guild,
            member,
            user,
            teamNameInput,
            tournamentKey,
            reply
        });
    }

    /*
     * No key given → the server's DEFAULT tournament.
     * Only when this server has no tournament at all do we keep the old
     * global registration behavior.
     */
    const defaultTournament = await getDefaultTournament(guild.id);

    if (defaultTournament) {
        return runTournamentRegister({
            guild,
            member,
            user,
            teamNameInput,
            tournamentKey: defaultTournament.tournamentKey,
            reply
        });
    }

    return runGlobalRegister({
        guild,
        member,
        user,
        teamNameInput,
        reply
    });
}

/**
 * GLOBAL registration (original behavior):
 * 1. Validate name uniqueness
 * 2. Ensure user isn't already a captain
 * 3. Create Team + captain Player
 * 4. Sync to open tournaments (manual-registration tournaments excluded)
 * 5. Assign Discord roles
 */
async function runGlobalRegister({ guild, member, user, teamNameInput, reply }) {
    const teamName = teamNameInput?.trim();

    if (!teamName || teamName.length < 2) {
        return reply({ content: '❌ Please provide a valid team name.' });
    }

    /* ── Check if user already manages a team ── */
    const existingCaptainTeam = await Team.findOne({
        guildId: guild.id,
        captainID: user.id
    });

    if (existingCaptainTeam) {
        return reply({ content: `❌ You already manage **${existingCaptainTeam.name}**.` });
    }

    /* ── Check name uniqueness ── */
    const existingName = await Team.findOne({
        guildId: guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(teamName)}$`, 'i') }
    });

    if (existingName) {
        return reply({ content: `❌ A team named **${existingName.name}** already exists.` });
    }

    /* ── Check if user is already on a team ── */
    const existingPlayer = await Player.findOne({
        guildId: guild.id,
        discordID: user.id
    }).populate('teamId');

    const isFreeAgent =
        existingPlayer &&
        (
            !existingPlayer.teamId ||
            String(existingPlayer.teamNameSnapshot || '').toUpperCase() === 'FREE AGENT'
        );

    if (existingPlayer && !isFreeAgent) {
        const linkedTeamName =
            existingPlayer.teamId?.name ||
            existingPlayer.teamNameSnapshot ||
            'another team';

        return reply({
            content:
                `❌ You are already registered as **${existingPlayer.name}** ` +
                `in **${linkedTeamName}**.`
        });
    }

    /* ── Create team ── */
    const createdTeam = await Team.create({
        guildId: guild.id,
        name: teamName,
        captainID: user.id,
        groupKey: null,
        stats: {
            played: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            gf: 0,
            ga: 0,
            points: 0
        }
    });

    /* ── Create or update captain player record ── */
    let captainPlayer;

    if (existingPlayer && isFreeAgent) {
        captainPlayer = await Player.findOneAndUpdate(
            { _id: existingPlayer._id },
            {
                $set: {
                    name: existingPlayer.name || member?.displayName || user.username,
                    teamId: createdTeam._id,
                    teamNameSnapshot: createdTeam.name,
                    isCaptain: true,
                    isViceCaptain: false
                }
            },
            { new: true }
        );
    } else {
        captainPlayer = await Player.create({
            guildId: guild.id,
            name: member?.displayName || user.username,
            discordID: user.id,
            discordUsername: user.username?.toLowerCase() || null,
            teamId: createdTeam._id,
            teamNameSnapshot: createdTeam.name,
            isCaptain: true,
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
        });
    }

    /* ── Sync to open tournaments ── */
    const sync = await syncTeamToOpenTournaments(guild.id, createdTeam);

    /* ── Assign Discord roles ── */
    const newestSettings = await TournamentSettings.findOne({
        guildId: guild.id,
        registrationOpen: true,
        currentPhase: 'registration'
    }).sort({ createdAt: -1 });

    const captainRoleResult = await tryAssignRole({
        guild,
        member,
        roleId: newestSettings?.captainRoleId || ''
    });

    const playerRoleResult = await tryAssignRole({
        guild,
        member,
        roleId: newestSettings?.tournamentPlayerRoleId || ''
    });

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('✅ TEAM REGISTERED')
        .setDescription(
            `**${createdTeam.name}** has been registered globally.\n` +
            `👑 Captain: ${user}\n` +
            `🧍 Captain Profile: **${captainPlayer.name}**`
        )
        .addFields(
            {
                name: 'Tournament Sync',
                value:
                    `Added to open tournaments: **${sync.syncedTournaments}**\n` +
                    `Players synced: **${sync.syncedPlayers}**`,
                inline: false
            },
            {
                name: 'Captain Role',
                value: buildRoleStatusText(captainRoleResult),
                inline: false
            },
            {
                name: 'Player Role',
                value: buildRoleStatusText(playerRoleResult),
                inline: false
            }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/**
 * TOURNAMENT registration (manual registration mode):
 * Registers a team for ONE specific tournament only.
 *
 * - A team name that already exists globally is registered into the
 *   tournament by its captain (no new team is created).
 * - A new name creates a new global team whose captaincy is scoped to
 *   this tournament when the user already manages a team elsewhere.
 * - Conflict checks are per-tournament, so players/captains from another
 *   tournament are not blocked.
 */
async function runTournamentRegister({
    guild,
    member,
    user,
    teamNameInput,
    tournamentKey,
    reply
}) {
    const teamName = teamNameInput?.trim();

    if (!teamName || teamName.length < 2) {
        return reply({ content: '❌ Please provide a valid team name.' });
    }

    /* ── Resolve tournament ── */
    const tournament = await TournamentSettings.findOne({
        guildId: guild.id,
        tournamentKey
    });

    if (!tournament) {
        return reply({ content: `❌ Tournament \`${tournamentKey}\` not found.` });
    }

    if (!tournament.registrationOpen) {
        return reply({
            content: `❌ Registration is closed for **${tournament.name}**.`
        });
    }

    /* ── Per-tournament check: already a player in this tournament ── */
    const userPlayer = await Player.findOne({
        guildId: guild.id,
        discordID: user.id
    }).populate('teamId');

    if (userPlayer) {
        const tourPlayer = await TournamentPlayer.findOne({
            guildId: guild.id,
            tournamentId: tournament._id,
            playerId: userPlayer._id,
            isActive: true
        });

        if (tourPlayer) {
            const linkedTeam = tourPlayer.teamNameSnapshot || 'another team';
            return reply({
                content:
                    `❌ You are already registered as **${userPlayer.name}** in ` +
                    `**${linkedTeam}** for **${tournament.name}**.\n` +
                    `One team per tournament.`
            });
        }
    }

    /* ── Per-tournament check: already captain of a team in this tournament ── */
    const captainEntry = await TournamentTeam.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        isActive: true,
        captainID: user.id
    }).populate('teamId');

    if (captainEntry) {
        const teamNameInT = captainEntry.teamId?.name || captainEntry.teamNameSnapshot;
        return reply({
            content:
                `❌ You already captain **${teamNameInT}** in **${tournament.name}**.\n` +
                `One captaincy per tournament.`
        });
    }

    /* ── Existing global team with this name? ── */
    const existingTeam = await Team.findOne({
        guildId: guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(teamName)}$`, 'i') }
    });

    let team;
    let isExistingTeam = false;
    let entryCaptainId = user.id;
    let entryViceCaptainId = null;

    if (existingTeam) {
        /* Only the team's global or per-tournament captain can register it. */
        const entry = await TournamentTeam.findOne({
            guildId: guild.id,
            tournamentId: tournament._id,
            teamId: existingTeam._id
        });

        const isAllowed =
            String(existingTeam.captainID || '') === user.id ||
            (entry && String(entry.captainID || '') === user.id);

        if (!isAllowed) {
            return reply({
                content:
                    `❌ A team named **${existingTeam.name}** already exists ` +
                    `and belongs to another captain.`
            });
        }

        team = existingTeam;
        isExistingTeam = true;
        entryCaptainId =
            (entry && entry.captainID) || existingTeam.captainID || user.id;
        entryViceCaptainId = existingTeam.viceCaptainID || null;
    } else {
        /*
         * New global team. If the user already captains a global team
         * (in another tournament), the new team gets NO global captain —
         * its captaincy is stored per-tournament so global commands keep
         * resolving the user's original team.
         */
        const myCaptainTeam = await Team.findOne({
            guildId: guild.id,
            captainID: user.id
        });

        team = await Team.create({
            guildId: guild.id,
            name: teamName,
            captainID: myCaptainTeam ? null : user.id,
            groupKey: null,
            stats: {
                played: 0,
                wins: 0,
                draws: 0,
                losses: 0,
                gf: 0,
                ga: 0,
                points: 0
            }
        });
    }

    /* ── Ensure the user has a global player record ── */
    let captainPlayer = userPlayer;
    let globalAffiliationNote = null;

    if (!captainPlayer) {
        captainPlayer = await Player.create({
            guildId: guild.id,
            name: member?.displayName || user.username,
            discordID: user.id,
            discordUsername: user.username?.toLowerCase() || null,
            teamId: team._id,
            teamNameSnapshot: team.name,
            isCaptain: String(team.captainID || '') === user.id,
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
        });
    } else if (
        !captainPlayer.teamId ||
        String(captainPlayer.teamNameSnapshot || '').toUpperCase() === 'FREE AGENT'
    ) {
        /* Globally free agent — attach to the new team. */
        await Player.updateOne(
            { _id: captainPlayer._id },
            {
                $set: {
                    teamId: team._id,
                    teamNameSnapshot: team.name,
                    isCaptain: String(team.captainID || '') === user.id,
                    isViceCaptain: false
                }
            }
        );
        captainPlayer = await Player.findOne({ _id: captainPlayer._id });
    } else if (
        !isExistingTeam &&
        String(captainPlayer.teamId?._id || '') !== String(team._id)
    ) {
        /*
         * The user already belongs to a DIFFERENT global team (in another
         * tournament). The global record is left untouched; membership in
         * this tournament is stored on the TournamentPlayer entry below.
         */
        globalAffiliationNote =
            `Your global profile stays on **${captainPlayer.teamId?.name || captainPlayer.teamNameSnapshot}**. ` +
            `This registration only affects **${tournament.name}**.`;
    }

    /* ── Enroll the team into THIS tournament only ── */
    const enroll = await enrollTeamInTournament(guild.id, tournament, team, {
        captainID: entryCaptainId,
        viceCaptainID: entryViceCaptainId
    });

    if (!enroll.enrolled) {
        return reply({
            content:
                `❌ **${tournament.name}** is full ` +
                `(${tournament.teamCount}/${tournament.teamCount} teams). ` +
                `Registration for this team was not added.`
        });
    }

    /*
     * Make sure the user's own tournament entry exists with the right
     * flags — their global player record may still point at a different
     * team, in which case the enrollment loop above skipped them.
     */
    if (captainPlayer) {
        await TournamentPlayer.findOneAndUpdate(
            {
                guildId: guild.id,
                tournamentId: tournament._id,
                playerId: captainPlayer._id
            },
            {
                $set: {
                    guildId: guild.id,
                    tournamentId: tournament._id,
                    playerId: captainPlayer._id,
                    teamId: team._id,
                    playerNameSnapshot: captainPlayer.name,
                    teamNameSnapshot: team.name,
                    isActive: true,
                    isCaptain: true,
                    isViceCaptain: false
                },
                $setOnInsert: {
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
    }

    /* ── Assign Discord roles (from THIS tournament's settings) ── */
    const captainRoleResult = await tryAssignRole({
        guild,
        member,
        roleId: tournament.captainRoleId || ''
    });

    const playerRoleResult = await tryAssignRole({
        guild,
        member,
        roleId: tournament.tournamentPlayerRoleId || ''
    });

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(`✅ TEAM REGISTERED — ${tournament.name}`)
        .setDescription(
            `${tournament.emoji || '🏆'} **${team.name}** is now in **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n` +
            `👑 Captain: ${user}\n` +
            (globalAffiliationNote ? `\nℹ️ ${globalAffiliationNote}` : '')
        )
        .addFields(
            {
                name: 'Registration',
                value:
                    `${isExistingTeam ? 'Existing team' : 'New team'} registered manually for this tournament.\n` +
                    `Squad members synced: **${enroll.playersSynced}**`,
                inline: false
            },
            {
                name: 'Captain Role',
                value: buildRoleStatusText(captainRoleResult),
                inline: false
            },
            {
                name: 'Player Role',
                value: buildRoleStatusText(playerRoleResult),
                inline: false
            }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   ROLE HELPERS
==================================================== */

/** Attempt to assign a Discord role with full permission/hierarchy checks. */
async function tryAssignRole({ guild, member, roleId }) {
    if (!roleId) return { status: 'not_configured' };
    if (!member) return { status: 'member_missing' };

    const role = guild.roles.cache.get(roleId);
    if (!role) return { status: 'role_missing' };

    const botMember = guild.members.me;
    if (!botMember) return { status: 'bot_member_missing', role };

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

/** Human-readable status for the role assignment attempt. */
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
