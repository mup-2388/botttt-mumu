/**
 * setvicecaptain.js
 *
 * Set / remove the vice captain of a team IN A TOURNAMENT.
 *
 * Works for the server's DEFAULT tournament unless `tournament=<key>` is given.
 * The captain check uses the team you captain IN THAT TOURNAMENT — a stale
 * team from an old tournament can never block or hijack the command.
 *
 * Usage:
 *   .svc @user                              (or .setvicecaptain @user)
 *   .svc @user remove                       (remove the vice captain)
 *   .svc @user team=<Team Name>             (organizer, or captain of several teams)
 *   .svc @user tournament=<key>             (a tournament that isn't the default)
 *
 * WHO CAN RUN THIS:
 *   - Captain of the team in that tournament
 *   - Organizers (any team of that tournament; team=<name> or the target's team)
 *
 * WHAT IT WRITES:
 *   - TournamentTeam.viceCaptainID + TournamentPlayer.isViceCaptain
 *     (the tournament's own records — the source of truth for that tournament)
 *   - If the team still uses its GLOBAL captain in this tournament (no
 *     per-tournament captain), the global Team.viceCaptainID / Player flags
 *     are kept in sync for legacy consumers.
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

const { isOrganizer } = require('../../utils/isOrganizer');
const { getUserFromArgs } = require('../../utils/stringHelpers');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const {
    sameId,
    effectiveCaptainId,
    getUserTeamInTournament,
    getManagedTeamsInTournament,
    findTeamInTournamentByName,
    getRosterMembership,
    parseTeamTokenInTournament
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'setvicecaptain',
    description: 'Set the vice captain of your team (default tournament unless tournament=<key>).',
    usage: '.svc @user [remove] [team=<Team Name>] [tournament=<key>]',
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
                .setDescription('Team name (organizer: any team • captain: only if you captain several)')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const tournamentKey = parsedKey.explicit ? parsedKey.tournament.tournamentKey : null;

            const resolved = await resolveTournament(message.guild.id, tournamentKey);
            if (!resolved.tournament) return message.reply(resolved.error);

            const token = await parseTeamTokenInTournament(
                message.guild.id,
                resolved.tournament,
                parsedKey.rest
            );

            const target =
                message.mentions.users.first() ||
                await getUserFromArgs(message, token.rest.filter(a => a !== 'remove' && a !== 'clear'));

            if (!target) {
                return message.reply('❓ Usage: `.svc @user [remove] [team=<Team Name>] [tournament=<key>]`');
            }

            const remove = args.includes('remove') || args.includes('clear');

            return await runSetViceCaptain({
                guild: message.guild,
                actorId: message.author.id,
                targetUser: target,
                remove,
                teamName: token.teamName,
                tournament: resolved.tournament,
                explicit: resolved.explicit,
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
            const key = interaction.options.getString('tournament')?.toLowerCase() || null;

            const resolved = await resolveTournament(interaction.guild.id, key);
            if (!resolved.tournament) return interaction.editReply(resolved.error);

            return await runSetViceCaptain({
                guild: interaction.guild,
                actorId: interaction.user.id,
                targetUser: target,
                remove,
                teamName,
                tournament: resolved.tournament,
                explicit: resolved.explicit,
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
    tournament,
    explicit,
    reply
}) {
    const organizer = await isOrganizer(guild.id, actorId);
    const where = `**${tournament.name}** (\`${tournament.tournamentKey}\`)`;

    /* ── RESOLVE TEAM (always inside this tournament) ── */
    let team = null;
    let entry = null;

    if (teamName) {
        const found = await findTeamInTournamentByName(guild.id, tournament, teamName);

        if (!found) {
            return reply({ content: `❌ Team \`${teamName}\` is not registered in ${where}.` });
        }

        team = found.team;
        entry = found.entry;

        if (!organizer && !sameId(effectiveCaptainId(entry, team), actorId)) {
            return reply({ content: `🚫 You are not the captain of **${team.name}** in ${where}.` });
        }
    } else if (organizer) {
        // Organizer: the target's team in this tournament
        const targetCtx = await getUserTeamInTournament(guild.id, tournament, targetUser.id);

        if (!targetCtx) {
            return reply({
                content: `❌ ${targetUser} is not on any team in ${where}. Use \`team=<Team Name>\` to pick the team.`
            });
        }

        team = targetCtx.team;
        entry = targetCtx.entry;
    } else {
        const managed = (await getManagedTeamsInTournament(guild.id, tournament, actorId))
            .filter(x => sameId(effectiveCaptainId(x.entry, x.team), actorId));

        if (!managed.length) {
            return reply({
                content:
                    `❌ You are not a **Team Captain** of any team in ${where}.` +
                    (explicit ? '' : '\nManaging a team in another tournament? Add `tournament=<key>`.') +
                    '\nOrganizers can set any team with `team=<Team Name>`.'
            });
        }

        if (managed.length > 1) {
            const list = managed.map(x => `• **${x.team.name}**`).join('\n');
            return reply({
                content:
                    `🤔 You captain more than one team in ${where}:\n${list}\n\n` +
                    `Specify which one:\n` +
                    `Prefix: \`.svc @user team=<Team Name>\`\n` +
                    `Slash: \`/setvicecaptain user:<user> team:<Team Name>\``
            });
        }

        team = managed[0].team;
        entry = managed[0].entry;
    }

    const usesGlobalCaptain = !entry.captainID; // no per-tournament captain override

    /* ── REMOVE MODE ── */
    if (remove) {
        const hasTournamentVc =
            !!entry.viceCaptainID ||
            (usesGlobalCaptain && !!team.viceCaptainID);

        if (!hasTournamentVc) {
            return reply({
                content: `❌ **${team.name}** does not have a vice captain set in ${where}.`
            });
        }

        await TournamentTeam.updateOne(
            { _id: entry._id },
            { $set: { viceCaptainID: null } }
        );

        await TournamentPlayer.updateMany(
            { guildId: guild.id, tournamentId: tournament._id, teamId: team._id },
            { $set: { isViceCaptain: false } }
        );

        if (usesGlobalCaptain && team.viceCaptainID) {
            await Team.updateOne({ _id: team._id }, { $set: { viceCaptainID: null } });
            await Player.updateMany(
                { guildId: guild.id, teamId: team._id },
                { $set: { isViceCaptain: false } }
            );
        }

        const embed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('🗑️ VICE CAPTAIN REMOVED')
            .setDescription(
                `Tournament: ${where}\n` +
                `Team: **${team.name}**\n\n` +
                `Vice captain role has been removed.`
            )
            .setTimestamp();

        return reply({ embeds: [embed] });
    }

    /* ── SET MODE ── */

    // Captain can't also be vice captain
    if (sameId(effectiveCaptainId(entry, team), targetUser.id)) {
        return reply({
            content: '❌ The captain cannot also be the vice captain. Choose another team member.'
        });
    }

    // Target must be a registered player on this team IN THIS TOURNAMENT
    const { player: targetPlayer, tournamentPlayer: membership } =
        await getRosterMembership(guild.id, tournament, team._id, targetUser.id);

    if (!targetPlayer) {
        return reply({ content: `❌ ${targetUser} is not registered as a player.` });
    }

    if (!membership) {
        return reply({
            content:
                `❌ ${targetUser} is not in **${team.name}** (${tournament.name}).\n` +
                'Vice captain must be a member of the team in this tournament.'
        });
    }

    // Clear old vice captain flags (this tournament), set the new one
    await TournamentPlayer.updateMany(
        { guildId: guild.id, tournamentId: tournament._id, teamId: team._id },
        { $set: { isViceCaptain: false } }
    );

    await TournamentPlayer.updateOne(
        { _id: membership._id },
        { $set: { isViceCaptain: true } }
    );

    await TournamentTeam.updateOne(
        { _id: entry._id },
        { $set: { viceCaptainID: targetUser.id } }
    );

    // Team still on its global captain → keep the global records in sync
    if (usesGlobalCaptain) {
        await Team.updateOne({ _id: team._id }, { $set: { viceCaptainID: targetUser.id } });

        await Player.updateMany(
            { guildId: guild.id, teamId: team._id },
            { $set: { isViceCaptain: false } }
        );

        if (targetPlayer.teamId && String(targetPlayer.teamId) === String(team._id)) {
            await Player.updateOne({ _id: targetPlayer._id }, { $set: { isViceCaptain: true } });
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🥈 VICE CAPTAIN SET')
        .setDescription(
            `Tournament: ${where}\n` +
            `Team: **${team.name}**\n\n` +
            `Vice Captain: ${targetUser}\n` +
            `Set by: ${organizer ? 'Organizer' : 'Captain'}`
        )
        .setFooter({
            text: 'The vice captain has all team management permissions.'
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}
