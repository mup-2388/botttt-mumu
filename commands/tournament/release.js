/**
 * release.js
 *
 * Release a player from your team as captain. Makes them a free agent.
 * Cannot release yourself (change captain first). Cannot release captains.
 *
 * Works for the server's DEFAULT tournament unless `tournament=<key>` is given.
 * Captain / roster checks use the team the user is on IN THAT TOURNAMENT.
 *
 * Usage:  .release @user [tournament=<key>]
 * Slash:  /release user:<user> [tournament:<key>]
 *
 * Aliases: dropplayer, kickplayer
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Player,
    TournamentPlayer,
    ServerConfig
} = require('../../models/Tournament');

const { getUserFromArgs } = require('../../utils/stringHelpers');
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const {
    resolveActorTeam,
    getRosterMembership,
    effectiveCaptainId,
    sameId
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'release',
    description: 'Release a player from your team as captain.',
    usage: '.release @user',
    aliases: ['dropplayer', 'kickplayer'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('release')
        .setDescription('Release a player from your team')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Player to release')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const target =
                message.mentions.users.first() ||
                await getUserFromArgs(message, parsedKey.rest);

            if (!target) {
                return message.reply('❌ Usage: `.release @user [tournament=<key>]`');
            }

            return await runRelease({
                guild: message.guild,
                actorId: message.author.id,
                targetUser: target,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[release] prefix error:', error);
            return message.reply('❌ Failed to release player.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const target = interaction.options.getUser('user');

            return await runRelease({
                guild: interaction.guild,
                actorId: interaction.user.id,
                targetUser: target,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[release] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to release player.');
            }

            return interaction.reply({ content: '❌ Failed to release player.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Release a player from the captain's team IN THE TOURNAMENT:
 * 1. Resolve tournament (explicit key, else the server default)
 * 2. Validate actor is captain of a team in that tournament
 * 3. Validate target is on the same team (in that tournament) and not captain
 * 4. Make the target a free agent in that tournament
 * 5. Global Player record: detached only if it still points at this team
 */
async function runRelease({ guild, actorId, targetUser, tournamentKey = null, reply }) {
    // ── Transfer lock check ──
    const config = await ServerConfig.findOne({ guildId: guild.id }).lean();
    if (config?.transfersLocked) {
        return reply({ content: '🔒 Transfers are **locked**. The transfer window is currently closed.' });
    }

    /* ── Find actor's team in the tournament ── */
    const { tournament, ctx, error } = await resolveActorTeam({
        guildId: guild.id,
        userId: actorId,
        tournamentKey,
        need: 'captain',
        noun: 'release players'
    });

    if (error) return reply({ content: error });

    const { team, entry } = ctx;

    /* ── Can't release yourself ── */
    if (String(actorId) === String(targetUser.id)) {
        return reply({
            content:
                '❌ You cannot release yourself while you are captain.\n' +
                'Use `.cc @newCaptain` first.'
        });
    }

    /* ── Find target player on this team (in this tournament) ── */
    const { player: targetPlayer, tournamentPlayer: targetEntry } =
        await getRosterMembership(guild.id, tournament, team._id, targetUser.id);

    if (!targetPlayer) {
        return reply({ content: `❌ ${targetUser} is not registered as a player.` });
    }

    if (!targetEntry) {
        return reply({ content: `❌ ${targetUser} is not in **${team.name}** (${tournament.name}).` });
    }

    /* ── Can't release the captain ── */
    if (
        targetEntry.isCaptain ||
        sameId(effectiveCaptainId(entry, team), targetUser.id)
    ) {
        return reply({
            content:
                `❌ ${targetUser} is the captain of **${team.name}**.\n` +
                'Use `.cc @newCaptain` first.'
        });
    }

    /* ── Free agent in THIS tournament ── */
    await TournamentPlayer.updateOne(
        { _id: targetEntry._id },
        {
            $set: {
                teamId: null,
                teamNameSnapshot: 'FREE AGENT',
                isCaptain: false,
                isViceCaptain: false
            }
        }
    );

    // A released vice captain must not keep the per-tournament VC seat
    if (sameId(entry.viceCaptainID, targetUser.id)) {
        entry.viceCaptainID = null;
        await entry.save();
    }

    /* ── Global player record: only if it still points at this team ── */
    if (targetPlayer.teamId && String(targetPlayer.teamId) === String(team._id)) {
        await Player.updateOne(
            { _id: targetPlayer._id },
            {
                $set: {
                    teamId: null,
                    teamNameSnapshot: 'FREE AGENT',
                    isCaptain: false,
                    isViceCaptain: false
                }
            }
        );

        if (sameId(team.viceCaptainID, targetUser.id)) {
            team.viceCaptainID = null;
            await team.save();
        }
    }

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x95A5A6)
        .setTitle('✅ Player Released')
        .setDescription(
            `${targetUser} has been released from **${team.name}**.\n` +
            `They are now a **FREE AGENT** in **${tournament.name}**.`
        )
        .setFooter({
            text: `Tournament: ${tournament.tournamentKey}`
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}
