/**
 * setvicecaptain.js
 *
 * Set the vice captain of a team — including per-tournament teams.
 *
 * Usage:
 *   .svc @user                          (or .setvicecaptain @user)
 *   .svc @user remove                   (to remove vice captain)
 *   .svc @user team=<Team Name>         (pick one of your teams)
 *
 * WHO CAN RUN THIS:
 *   - Captain of the team (global captain, or per-tournament captain)
 *   - Organizers (any team, via team=<name>)
 *
 * TWO SCOPES:
 *   - GLOBAL team (you captain it globally): sets Team.viceCaptainID,
 *     Player.isViceCaptain, and the flags on the team's tournament entries.
 *   - PER-TOURNAMENT team (you captain it in a tournament): sets
 *     TournamentTeam.viceCaptainID on the team's active tournament entries
 *     and TournamentPlayer.isViceCaptain in those tournaments. The target's
 *     global profile is NOT touched.
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

const {
    isOrganizer
} = require('../../utils/isOrganizer');
const {
    getCaptainTeams,
    isCaptainOfTeam,
    parseTeamToken
} = require('../../utils/teamResolver');
const { getUserFromArgs } = require('../../utils/stringHelpers');

module.exports = {
    name: 'setvicecaptain',
    description: 'Set the vice captain of your team (global or per-tournament).',
    usage: '.svc @user [remove] [team=<Team Name>]',
    aliases: ['svc', 'setvc', 'vicecaptain'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('setvicecaptain')
        .setDescription('Set the vice captain of your team')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Player to set as vice captain')
                .setRequired(true)
        )
        .addBooleanOption(opt =>
            opt.setName('remove')
                .setDescription('Remove vice captain instead')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team name (captain: one of your teams • organizer: any team)')
                .setRequired(false)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            const target =
                message.mentions.users.first() ||
                await getUserFromArgs(message, args);

            if (!target) {
                return message.reply('❓ Usage: `.svc @user [remove] [team=<Team Name>]`');
            }

            const remove = args.includes('remove') || args.includes('clear');
            const token = await parseTeamToken(message.guild.id, message.author.id, args);

            return await runSetViceCaptain({
                guild: message.guild,
                actorId: message.author.id,
                targetUser: target,
                remove,
                teamName: token.teamName,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[setvicecaptain] prefix error:', error);
            return message.reply('❌ Failed to set vice captain.');
        }
    },

    async slashExecute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: false });

            const target = interaction.options.getUser('user');
            const remove = interaction.options.getBoolean('remove') ?? false;
            const teamName = interaction.options.getString('team');

            return await runSetViceCaptain({
                guild: interaction.guild,
                actorId: interaction.user.id,
                targetUser: target,
                remove,
                teamName,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[setvicecaptain] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to set vice captain.');
            }

            return interaction.reply({
                content: '❌ Failed to set vice captain.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

async function runSetViceCaptain({
    guild,
    actorId,
    targetUser,
    remove,
    teamName,
    reply
}) {
    // ── CHECK PERMISSIONS / RESOLVE TEAM ──
    const organizer = await isOrganizer(guild.id, actorId);

    let team = null;
    let scope = 'global'; // 'global' | 'perTournament'

    if (organizer && !teamName) {
        // Organizer legacy path: operate on the target's global team
        if (remove) {
            team = await Team.findOne({
                guildId: guild.id,
                viceCaptainID: targetUser.id
            });

            if (!team) {
                const targetPlayer = await Player.findOne({
                    guildId: guild.id,
                    discordID: targetUser.id
                });

                if (!targetPlayer?.teamId) {
                    return reply({
                        content: `❌ ${targetUser} is not registered as a player in any team.`
                    });
                }

                team = await Team.findById(targetPlayer.teamId);
            }
        } else {
            const targetPlayer = await Player.findOne({
                guildId: guild.id,
                discordID: targetUser.id
            });

            if (!targetPlayer?.teamId) {
                return reply({
                    content: `❌ ${targetUser} is not registered as a player in any team.`
                });
            }

            team = await Team.findById(targetPlayer.teamId);
        }
    } else {
        const captainTeams = await getCaptainTeams(guild.id, actorId);

        if (teamName) {
            team = await Team.findOne({
                guildId: guild.id,
                name: { $regex: new RegExp(`^${escapeName(teamName)}$`, 'i') }
            });

            if (!team) {
                const list = captainTeams.length
                    ? `\nYour teams:\n${captainTeams.map(t => `• **${t.name}**`).join('\n')}`
                    : '';
                return reply({ content: `❌ Team not found: \`${teamName}\`${list}` });
            }

            if (!organizer && !(await isCaptainOfTeam(actorId, team))) {
                const list = captainTeams.length
                    ? `\nYour teams:\n${captainTeams.map(t => `• **${t.name}**`).join('\n')}`
                    : '';
                return reply({
                    content: `🚫 **${team.name}** is not your team.${list}`
                });
            }

            scope = team.captainID ? 'global' : 'perTournament';
        } else {
            const globalTeam = captainTeams.find(t => String(t.captainID) === String(actorId));

            if (globalTeam) {
                team = globalTeam;
                scope = 'global';
            } else {
                const perTournamentTeams = captainTeams.filter(
                    t => String(t.captainID) !== String(actorId)
                );

                if (perTournamentTeams.length === 1) {
                    team = perTournamentTeams[0];
                    scope = 'perTournament';
                } else if (perTournamentTeams.length > 1) {
                    const list = perTournamentTeams
                        .map(t => `• **${t.name}**`)
                        .join('\n');
                    return reply({
                        content:
                            `🤔 You captain more than one team:\n${list}\n\n` +
                            `Specify which one:\n` +
                            `Prefix: \`.svc @user team=<Team Name>\`\n` +
                            `Slash: \`/setvicecaptain user:<user> team:<Team Name>\``
                    });
                } else {
                    return reply({
                        content: '❌ You are not a **Team Captain** of any team yet.\nOrganizers can set any team with `team=<Team Name>`.'
                    });
                }
            }
        }
    }

    if (!team) {
        return reply({ content: '❌ Could not find a team.' });
    }

    // ── LOAD AFFECTED TOURNAMENT ENTRIES (per-tournament scope) ──
    let affected = [];
    if (scope === 'perTournament') {
        affected = await TournamentTeam.find({
            guildId: guild.id,
            teamId: team._id,
            isActive: true
        });

        if (!affected.length) {
            return reply({
                content: `❌ **${team.name}** has no active tournament entries, so it has no per-tournament vice captain to ${remove ? 'remove' : 'set'}.`
            });
        }
    }

    // ── REMOVE MODE ──
    if (remove) {
        if (scope === 'global') {
            if (!team.viceCaptainID) {
                return reply({
                    content: `❌ **${team.name}** does not have a vice captain set.`
                });
            }

            await Team.updateOne(
                { _id: team._id },
                { $set: { viceCaptainID: null } }
            );

            await Player.updateMany(
                { guildId: guild.id, teamId: team._id },
                { $set: { isViceCaptain: false } }
            );

            await TournamentPlayer.updateMany(
                { guildId: guild.id, teamId: team._id },
                { $set: { isViceCaptain: false } }
            );
        } else {
            const withVc = affected.filter(e => e.viceCaptainID);
            if (!withVc.length) {
                return reply({
                    content: `❌ **${team.name}** does not have a vice captain set in its tournaments.`
                });
            }

            for (const entry of withVc) {
                await TournamentTeam.updateOne(
                    { _id: entry._id },
                    { $set: { viceCaptainID: null } }
                );
                await TournamentPlayer.updateMany(
                    {
                        guildId: guild.id,
                        teamId: team._id,
                        tournamentId: entry.tournamentId
                    },
                    { $set: { isViceCaptain: false } }
                );
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('🗑️ VICE CAPTAIN REMOVED')
            .setDescription(
                `Team: **${team.name}**` +
                (scope === 'perTournament' ? '\nScope: Per-tournament (its active tournaments)' : '') +
                `\n\nVice captain role has been removed.`
            )
            .setTimestamp();

        return reply({ embeds: [embed] });
    }

    // ── SET MODE ──

    // Captain can't also be vice captain
    if (scope === 'global' && String(team.captainID) === String(targetUser.id)) {
        return reply({
            content: '❌ The captain cannot also be the vice captain. Choose another team member.'
        });
    }
    if (scope === 'perTournament' && affected.some(e => String(e.captainID) === String(targetUser.id))) {
        return reply({
            content: `❌ ${targetUser} is the captain of **${team.name}** in a tournament — they can't also be its vice captain.`
        });
    }

    // Target must be a registered player
    const targetPlayer = await Player.findOne({
        guildId: guild.id,
        discordID: targetUser.id
    });

    if (!targetPlayer) {
        return reply({
            content: `❌ ${targetUser} is not registered as a player.`
        });
    }

    if (scope === 'global') {
        // Target must be on the same team (global membership)
        if (!targetPlayer.teamId || String(targetPlayer.teamId) !== String(team._id)) {
            return reply({
                content:
                    `❌ ${targetUser} is not in **${team.name}**.\n` +
                    'Vice captain must be a member of the same team.'
            });
        }

        // Clear old vice captain flags
        await Player.updateMany(
            { guildId: guild.id, teamId: team._id },
            { $set: { isViceCaptain: false } }
        );

        await TournamentPlayer.updateMany(
            { guildId: guild.id, teamId: team._id },
            { $set: { isViceCaptain: false } }
        );

        // Set new vice captain
        await Team.updateOne(
            { _id: team._id },
            { $set: { viceCaptainID: targetUser.id } }
        );

        await Player.updateOne(
            { _id: targetPlayer._id },
            { $set: { isViceCaptain: true } }
        );

        await TournamentPlayer.updateMany(
            { guildId: guild.id, teamId: team._id, playerId: targetPlayer._id },
            { $set: { isViceCaptain: true } }
        );
    } else {
        // Per-tournament: target must be in the team's tournament roster
        const membership = await TournamentPlayer.findOne({
            guildId: guild.id,
            teamId: team._id,
            playerId: targetPlayer._id,
            isActive: true
        });

        if (!membership) {
            return reply({
                content:
                    `❌ ${targetUser} is not in **${team.name}** (its tournament roster).\n` +
                    'Vice captain must be a member of the team in this tournament.'
            });
        }

        for (const entry of affected) {
            await TournamentPlayer.updateMany(
                {
                    guildId: guild.id,
                    teamId: team._id,
                    tournamentId: entry.tournamentId,
                    isActive: true
                },
                { $set: { isViceCaptain: false } }
            );

            await TournamentPlayer.updateMany(
                {
                    guildId: guild.id,
                    teamId: team._id,
                    tournamentId: entry.tournamentId,
                    playerId: targetPlayer._id,
                    isActive: true
                },
                { $set: { isViceCaptain: true } }
            );
        }

        await TournamentTeam.updateMany(
            { guildId: guild.id, teamId: team._id, isActive: true },
            { $set: { viceCaptainID: targetUser.id } }
        );
    }

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🥈 VICE CAPTAIN SET')
        .setDescription(
            `Team: **${team.name}**` +
            (scope === 'perTournament'
                ? `\nScope: Per-tournament (its active tournaments)`
                : '') +
            `\n\nVice Captain: ${targetUser}\n` +
            `Set by: ${organizer ? 'Organizer' : 'Captain'}`
        )
        .setFooter({
            text: 'The vice captain has all team management permissions.'
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   HELPERS
==================================================== */

function escapeName(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
