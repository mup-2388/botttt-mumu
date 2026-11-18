/**
 * delete-all-teams.js
 *
 * Preview and permanently remove every server-wide Team record in the current
 * Discord server. Players on those teams are archived for stats/history, then
 * removed from the live Player collection instead of becoming free agents.
 *
 * Usage:  .deleteallteams            -> preview
 *         .deleteallteams confirm   -> delete
 * Slash:  /delete-all-teams confirm:false|true
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    escapeMarkdown
} = require('discord.js');

const {
    Team,
    Player,
    PlayerArchive,
    TournamentSettings,
    TournamentTeam,
    Fixture
} = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { getDefaultTournament } = require('../../utils/getTournament');
const { optionalStep } = require('../../utils/optionalStep');

const PREVIEW_TEAM_LIMIT = 20;
const TEAM_NAME_DISPLAY_LIMIT = 80;

module.exports = {
    name: 'delete-all-teams',
    description: 'Preview or remove all server teams and their live player profiles while preserving history.',
    usage: '.deleteallteams [confirm]',
    aliases: ['deleteallteams'],
    // Keep this destructive utility behind prefix access if the global slash
    // command cap is full; the deployer prioritizes visible commands.
    hidden: true,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('delete-all-teams')
        .setDescription('Preview or remove all server teams; player stats and history are preserved')
        .addBooleanOption(option =>
            option.setName('confirm')
                .setDescription('false = preview only; true = remove teams and their live player profiles')
                .setRequired(true)
        ),

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const tokens = args.map(argument => String(argument).trim().toLowerCase());
            const validTokens = tokens.every(token => token === 'confirm' || token === '--confirm');
            if (!validTokens || tokens.length > 1) {
                return message.reply('❓ Use `.deleteallteams` to preview, then `.deleteallteams confirm` to delete.');
            }

            return await runDeleteAllTeams({
                guild: message.guild,
                confirm: tokens.length === 1,
                actorTag: message.author.tag || message.author.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[delete-all-teams] prefix error:', error);
            return message.reply('❌ Failed to process the server-team cleanup.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({
                    content: '❌ This command can only be used in a server.',
                    ephemeral: true
                });
            }

            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runDeleteAllTeams({
                guild: interaction.guild,
                confirm: interaction.options.getBoolean('confirm') === true,
                actorTag: interaction.user.tag || interaction.user.id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[delete-all-teams] slash error:', error);

            const payload = { content: '❌ Failed to process the server-team cleanup.' };
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(payload);
            }
            return interaction.reply({ ...payload, ephemeral: true });
        }
    }
};

async function runDeleteAllTeams({ guild, confirm, actorTag, reply }) {
    const scope = await getCleanupScope(guild.id);
    const { teams } = scope;

    if (!teams.length) {
        return reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x95A5A6)
                    .setTitle('No Teams Found')
                    .setDescription('There are no server-wide teams to remove. No changes were made.')
                    .setTimestamp()
            ]
        });
    }

    if (!confirm) {
        const listedTeams = teams
            .slice(0, PREVIEW_TEAM_LIMIT)
            .map(team => `• ${safeTeamName(team.name)}`)
            .join('\n');
        const remainingCount = teams.length - Math.min(teams.length, PREVIEW_TEAM_LIMIT);
        const moreTeams = remainingCount > 0 ? `\n…and ${remainingCount} more` : '';

        const embed = new EmbedBuilder()
            .setColor(0xF39C12)
            .setTitle('⚠️ DELETE ALL SERVER TEAMS — PREVIEW')
            .setDescription(
                `Global teams in this server: **${teams.length}**\n` +
                `${listedTeams}${moreTeams}\n\n` +
                `Global player profiles to remove: **${scope.playerCount}**\n` +
                `Active tournament-team entries to deactivate: **${scope.tournamentTeamCount}**\n` +
                `Unplayed fixtures to cancel: **${scope.fixtureCount}**\n\n` +
                '**Nothing has been changed.** Re-run `.deleteallteams confirm` (slash: `confirm:true`) to proceed.'
            )
            .addFields(
                {
                    name: 'What confirmation will do',
                    value:
                        'Delete this server’s global Team records and archive then remove Player records attached to those teams. ' +
                        'Those players will **not** become free agents. Active tournament-team entries will be deactivated, ' +
                        'unplayed fixtures cancelled, and configured Discord role cleanup attempted. Team-level legacy stats are removed with each Team record.'
                },
                {
                    name: 'What will be preserved',
                    value:
                        'Player stat snapshots, tournament/event player rows and stats, all-time profiles, trophies, awards, ' +
                        'and played fixtures. Other servers’ records are outside this cleanup.'
                }
            )
            .setFooter({ text: `Preview requested by ${safeTeamName(actorTag || 'Organizer')}` })
            .setTimestamp();

        return reply({ embeds: [embed] });
    }

    let teamsDeleted = 0;
    let playersDeleted = 0;
    let playerSnapshotsPreserved = 0;
    let tournamentTeamsDeactivated = 0;
    let fixturesCancelled = 0;
    let failedTeam = null;
    let failure = null;
    const playerDiscordIds = new Set();
    const captainIds = new Set();

    for (const team of teams) {
        try {
            const players = await Player.find({
                guildId: guild.id,
                teamId: team._id
            }).lean();

            if (players.length) {
                await PlayerArchive.bulkWrite(
                    players.map(player => ({
                        updateOne: {
                            filter: {
                                guildId: guild.id,
                                originalPlayerId: player._id
                            },
                            update: {
                                $setOnInsert: {
                                    guildId: guild.id,
                                    originalPlayerId: player._id,
                                    name: player.name,
                                    discordID: player.discordID || null,
                                    discordUsername: player.discordUsername || null,
                                    formerTeamId: player.teamId || team._id,
                                    formerTeamName: player.teamNameSnapshot || team.name,
                                    isCaptain: Boolean(player.isCaptain),
                                    isViceCaptain: Boolean(player.isViceCaptain),
                                    stats: player.stats || {},
                                    archivedAt: new Date()
                                }
                            },
                            upsert: true
                        }
                    })),
                    { ordered: true }
                );
                playerSnapshotsPreserved += players.length;
            }

            if (scope.activeTournamentIds.length) {
                const tournamentTeamResult = await TournamentTeam.updateMany(
                    {
                        guildId: guild.id,
                        tournamentId: { $in: scope.activeTournamentIds },
                        teamId: team._id,
                        isActive: true
                    },
                    { $set: { isActive: false, removedAt: new Date() } }
                );
                tournamentTeamsDeactivated += modifiedCount(tournamentTeamResult);

                const fixtureResult = await Fixture.updateMany(
                    {
                        guildId: guild.id,
                        tournamentId: { $in: scope.activeTournamentIds },
                        status: { $nin: ['Played', 'Cancelled'] },
                        $or: [
                            { homeTeamId: team._id },
                            { awayTeamId: team._id },
                            { homeTeam: team.name },
                            { awayTeam: team.name }
                        ]
                    },
                    {
                        $set: {
                            status: 'Cancelled',
                            notes: `Cancelled because ${team.name} was removed.`
                        }
                    }
                );
                fixturesCancelled += modifiedCount(fixtureResult);
            }

            if (players.length) {
                const playerDeleteResult = await Player.deleteMany({
                    guildId: guild.id,
                    _id: { $in: players.map(player => player._id) }
                });
                playersDeleted += playerDeleteResult.deletedCount || 0;

                for (const player of players) {
                    if (player.discordID) playerDiscordIds.add(String(player.discordID));
                }
            }

            const teamDeleteResult = await Team.deleteOne({ guildId: guild.id, _id: team._id });
            if (!teamDeleteResult.deletedCount) {
                throw new Error('Team record was not deleted');
            }
            teamsDeleted++;
            if (team.captainID) captainIds.add(String(team.captainID));
        } catch (error) {
            failedTeam = team.name;
            failure = error;
            break;
        }
    }

    await optionalStep(
        'delete-all-teams: Discord role cleanup',
        () => removeTeamRoles({
            guild,
            playerDiscordIds: [...playerDiscordIds],
            captainIds: [...captainIds]
        }),
        null
    );

    const completed = !failure && teamsDeleted === teams.length;
    const embed = new EmbedBuilder()
        .setColor(completed ? 0x2ECC71 : 0xE74C3C)
        .setTitle(completed ? '🗑️ SERVER TEAMS REMOVED' : '⚠️ TEAM REMOVAL PARTIALLY COMPLETED')
        .setDescription(
            `Team records removed: **${teamsDeleted}** of **${teams.length}**\n` +
            `Global Player records removed: **${playersDeleted}**\n` +
            `Player stat snapshots preserved: **${playerSnapshotsPreserved}**\n` +
            `Active tournament-team entries deactivated: **${tournamentTeamsDeactivated}**\n` +
            `Unplayed fixtures cancelled: **${fixturesCancelled}**\n\n` +
            'Team-level legacy stats were removed with the Team documents. Removed team members were **not** converted to free agents. ' +
            'Tournament/event stats, all-time profiles, trophies, awards, and played results were left intact.\n\n' +
            (failure
                ? `Stopped on **${safeTeamName(failedTeam)}**: ${safeTeamName(failure.message || 'database error')}. ` +
                  'Some updates for that team may already have applied; preview again before retrying.'
                : 'Configured Discord role cleanup was attempted.')
        )
        .setFooter({ text: `Action performed by ${safeTeamName(actorTag || 'Organizer')}` })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

async function getCleanupScope(guildId) {
    const teams = await Team.find({ guildId })
        .select('_id name captainID')
        .sort({ name: 1 })
        .lean();

    if (!teams.length) {
        return {
            teams,
            activeTournamentIds: [],
            playerCount: 0,
            tournamentTeamCount: 0,
            fixtureCount: 0
        };
    }

    const teamIds = teams.map(team => team._id);
    const teamNames = teams.map(team => team.name);
    const activeTournaments = await TournamentSettings.find({
        guildId,
        currentPhase: { $ne: 'completed' }
    }).select('_id').lean();
    const activeTournamentIds = activeTournaments.map(tournament => tournament._id);

    const [playerCount, tournamentTeamCount, fixtureCount] = await Promise.all([
        Player.countDocuments({ guildId, teamId: { $in: teamIds } }),
        activeTournamentIds.length
            ? TournamentTeam.countDocuments({
                guildId,
                tournamentId: { $in: activeTournamentIds },
                teamId: { $in: teamIds },
                isActive: true
            })
            : 0,
        activeTournamentIds.length
            ? Fixture.countDocuments({
                guildId,
                tournamentId: { $in: activeTournamentIds },
                status: { $nin: ['Played', 'Cancelled'] },
                $or: [
                    { homeTeamId: { $in: teamIds } },
                    { awayTeamId: { $in: teamIds } },
                    { homeTeam: { $in: teamNames } },
                    { awayTeam: { $in: teamNames } }
                ]
            })
            : 0
    ]);

    return {
        teams,
        activeTournamentIds,
        playerCount,
        tournamentTeamCount,
        fixtureCount
    };
}

async function removeTeamRoles({ guild, playerDiscordIds, captainIds }) {
    if (!playerDiscordIds.length && !captainIds.length) return;

    const defaultTournament = await getDefaultTournament(guild.id, { includeCompleted: true })
        .catch(() => null);
    if (!defaultTournament) return;

    const playerRoleId = defaultTournament.tournamentPlayerRoleId || '';
    const captainRoleId = defaultTournament.captainRoleId || '';
    const playerIds = new Set(playerDiscordIds.map(String));
    const captainIdSet = new Set(captainIds.map(String));
    const allUserIds = new Set([...playerIds, ...captainIdSet]);

    for (const userId of allUserIds) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;

        if (playerIds.has(userId)) await removeRoleSafely(member, playerRoleId);
        if (captainIdSet.has(userId)) await removeRoleSafely(member, captainRoleId);
    }
}

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

function modifiedCount(result) {
    return result?.modifiedCount ?? result?.nModified ?? 0;
}

function safeTeamName(value) {
    const text = String(value || 'Unknown')
        .replace(/@/g, '@\u200b')
        .replace(/</g, '‹')
        .replace(/>/g, '›')
        .replace(/[\r\n]+/g, ' ');
    const escaped = escapeMarkdown(text);
    return escaped.length > TEAM_NAME_DISPLAY_LIMIT
        ? `${escaped.slice(0, TEAM_NAME_DISPLAY_LIMIT - 1)}…`
        : escaped;
}

module.exports.runDeleteAllTeams = runDeleteAllTeams;
