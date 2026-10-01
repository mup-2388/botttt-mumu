/**
 * delete-team.js
 *
 * Safely remove a team and make all its players free agents.
 * Cancels pending fixtures involving the team. Removes player/captain roles.
 *
 * Usage:  .delete-team <team name> confirm
 * Slash:  /delete-team team:<name> confirm:true
 *
 * Aliases: deleteteam, removeteam, dt
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Team,
    Player,
    Fixture,
    TournamentTeam,
    TournamentPlayer,
    TournamentSettings
} = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { getDefaultTournament } = require('../../utils/getTournament');
const { optionalStep } = require('../../utils/optionalStep');
const { escapeRegex } = require('../../utils/stringHelpers');

module.exports = {
    name: 'delete-team',
    description: 'Safely remove a team and make its players free agents.',
    usage: '.delete-team <team name> confirm',
    aliases: ['deleteteam', 'removeteam', 'dt'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('delete-team')
        .setDescription('Safely remove a team and make its players free agents')
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team name')
                .setRequired(true)
        )
        .addBooleanOption(opt =>
            opt.setName('confirm')
                .setDescription('Required confirmation')
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

            const confirm = args[args.length - 1]?.toLowerCase() === 'confirm';
            const teamName = args.slice(0, -1).join(' ').trim();

            if (!teamName || !confirm) {
                return message.reply('⚠️ Use `.delete-team <team name> confirm` to proceed.');
            }

            return await runDeleteTeam({
                guild: message.guild,
                teamName,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[delete-team] prefix error:', error);
            return message.reply(
                '❌ Failed to remove team.\n`' + String(error?.message || error).slice(0, 200) + '`'
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

            if (!interaction.options.getBoolean('confirm')) {
                return interaction.editReply('⚠️ You must set confirm to true.');
            }

            return await runDeleteTeam({
                guild: interaction.guild,
                teamName: interaction.options.getString('team'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[delete-team] slash error:', error);

            const reason = String(error?.message || error).slice(0, 200);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(
                    '❌ Failed to remove team.\n`' + reason + '`'
                );
            }

            return interaction.reply({
                content: '❌ Failed to remove team.\n`' + reason + '`',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Delete a team and handle all cascading effects:
 * 1. Deactivate TournamentTeam entries in active tournaments
 * 2. Make all players free agents (TournamentPlayer + Player)
 * 3. Cancel pending fixtures involving the team
 * 4. Remove captain/player Discord roles
 * 5. Delete the Team record
 */
async function runDeleteTeam({ guild, teamName, reply }) {
    /* ── Find team ── */
    const team = await Team.findOne({
        guildId: guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(teamName)}$`, 'i') }
    });

    if (!team) {
        return reply({
            content: `ℹ️ Team not found: \`${teamName}\` — nothing to remove.`
        });
    }

    const oldTeamName = team.name;

    /* ── Collect all players on the team ── */
    const players = await Player.find({
        guildId: guild.id,
        teamId: team._id
    });

    const playerIds = players.map(p => p._id);
    const playerDiscordIds = players.map(p => p.discordID).filter(Boolean);

    /* ── Find active tournaments ── */
    const activeTournaments = await TournamentSettings.find({
        guildId: guild.id,
        currentPhase: { $ne: 'completed' }
    }).lean();

    const activeTournamentIds = activeTournaments.map(t => t._id);

    let tournamentTeamsUpdated = 0;
    let tournamentPlayersUpdated = 0;
    let fixturesCancelled = 0;

    /* ── Update tournament data if any active tournaments exist ── */
    if (activeTournamentIds.length) {
        // Deactivate tournament team entries
        const ttResult = await TournamentTeam.updateMany(
            {
                guildId: guild.id,
                tournamentId: { $in: activeTournamentIds },
                teamId: team._id
            },
            { $set: { isActive: false, removedAt: new Date() } }
        );
        tournamentTeamsUpdated = ttResult.modifiedCount || 0;

        // Make tournament players free agents
        if (playerIds.length) {
            const tpResult = await TournamentPlayer.updateMany(
                {
                    guildId: guild.id,
                    tournamentId: { $in: activeTournamentIds },
                    playerId: { $in: playerIds }
                },
                {
                    $set: {
                        teamId: null,
                        tournamentTeamId: null,
                        teamNameSnapshot: 'FREE AGENT',
                        isCaptain: false,
                        isViceCaptain: false
                    }
                }
            );
            tournamentPlayersUpdated = tpResult.modifiedCount || 0;
        }

        // Cancel pending fixtures involving the team
        const fixtureResult = await Fixture.updateMany(
            {
                guildId: guild.id,
                tournamentId: { $in: activeTournamentIds },
                status: { $ne: 'Played' },
                $or: [
                    { homeTeamId: team._id },
                    { awayTeamId: team._id },
                    { homeTeam: oldTeamName },
                    { awayTeam: oldTeamName }
                ]
            },
            {
                $set: {
                    status: 'Cancelled',
                    notes: `Cancelled because ${oldTeamName} was removed.`
                }
            }
        );
        fixturesCancelled = fixtureResult.modifiedCount || 0;
    }

    /* ── Update global players to free agents ── */
    await Player.updateMany(
        { guildId: guild.id, teamId: team._id },
        {
            $set: {
                teamId: null,
                teamNameSnapshot: 'FREE AGENT',
                isCaptain: false,
                isViceCaptain: false
            }
        }
    );

    /* ── Remove Discord roles (optional cleanup) ── */
    await optionalStep(
        'delete-team: Discord role cleanup',
        () => removeTeamRoles({ guild, playerDiscordIds, captainId: team.captainID }),
        null
    );

    /* ── Delete the team ── */
    await Team.deleteOne({ _id: team._id });

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🗑️ Team Removed')
        .setDescription(
            `**${oldTeamName}** has been removed.\n\n` +
            `Players are now **FREE AGENTS**.\n` +
            `Stats were **not deleted**.`
        )
        .setFooter({
            text:
                `Players moved: ${players.length} • ` +
                `Tournament teams deactivated: ${tournamentTeamsUpdated} • ` +
                `Fixtures cancelled: ${fixturesCancelled}`
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   ROLE HELPERS
==================================================== */

/** Remove tournament player + captain roles from all affected members. */
async function removeTeamRoles({ guild, playerDiscordIds, captainId }) {
    const defaultTournament = await getDefaultTournament(guild.id, { includeCompleted: true })
        .catch(() => null);

    const settings = defaultTournament ? [defaultTournament] : [];

    const captainRoleIds = [
        ...new Set(settings.map(s => s.captainRoleId).filter(Boolean))
    ];

    const playerRoleIds = [
        ...new Set(settings.map(s => s.tournamentPlayerRoleId).filter(Boolean))
    ];

    const allPlayerIds = [...new Set(playerDiscordIds.map(String))];

    // Remove player roles from all team members
    for (const userId of allPlayerIds) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;

        for (const roleId of playerRoleIds) {
            await removeRoleSafely(member, roleId);
        }
    }

    // Remove captain roles from the team captain
    if (captainId) {
        const captainMember = await guild.members.fetch(captainId).catch(() => null);
        if (captainMember) {
            for (const roleId of captainRoleIds) {
                await removeRoleSafely(captainMember, roleId);
            }
        }
    }
}

/** Safely remove a role from a member with full permission/hierarchy checks. */
async function removeRoleSafely(member, roleId) {
    if (!roleId) return;

    const role = member.guild.roles.cache.get(roleId);
    if (!role) return;

    const botMember = member.guild.members.me;
    if (!botMember) return;

    if (!botMember.permissions.has('ManageRoles')) return;
    if (role.managed) return;
    if (botMember.roles.highest.position <= role.position) return;
    if (!member.roles.cache.has(role.id)) return;

    await member.roles.remove(role).catch(() => null);
}
