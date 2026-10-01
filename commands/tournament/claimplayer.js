/**
 * claimplayer.js
 *
 * Sign a free agent (unregistered or teamless player) to your team.
 * Captain or Vice Captain only.
 * Works inside the server's DEFAULT tournament unless `tournament=<key>` is
 * given. "Free agent" = not on any team IN THAT TOURNAMENT.
 *
 * Usage: .claimplayer @user [tournament=<key>]
 * Slash: /claimplayer user:<user> [tournament:<key>]
 *
 * Aliases: sign, signplayer
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Player,
    ServerConfig
} = require('../../models/Tournament');

const { getUserFromArgs } = require('../../utils/stringHelpers');
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const {
    resolveActorTeam,
    getUserTeamInTournament,
    assignPlayerToTeamInTournament
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'claimplayer',
    description: 'Sign a free agent to your team as captain.',
    usage: '.claimplayer @user [tournament=<key>]',
    aliases: ['sign', 'signplayer'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('claimplayer')
        .setDescription('Sign a free agent to your team')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Free agent to sign')
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

            const target = message.mentions.users.first() || await getUserFromArgs(message, parsedKey.rest);

            if (!target) {
                return message.reply('❌ Usage: `.claimplayer @user [tournament=<key>]`');
            }

            return await runClaimPlayer({
                guild: message.guild,
                actorId: message.author.id,
                targetUser: target,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[claimplayer] prefix error:', error);
            return message.reply('❌ Failed to claim player.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const target = interaction.options.getUser('user');

            return await runClaimPlayer({
                guild: interaction.guild,
                actorId: interaction.user.id,
                targetUser: target,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[claimplayer] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to claim player.');
            }

            return interaction.reply({
                content: '❌ Failed to claim player.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Claim a free agent for the actor's team IN THE TOURNAMENT.
 * Validates: actor is captain/VC there, target is registered and has no team there.
 */
async function runClaimPlayer({ guild, actorId, targetUser, tournamentKey = null, reply }) {
    // ── Transfer lock check ──
    const config = await ServerConfig.findOne({ guildId: guild.id }).lean();
    if (config?.transfersLocked) {
        return reply({ content: '🔒 Transfers are **locked**. The transfer window is currently closed.' });
    }

    // ── Verify actor is captain/VC in the tournament ──
    const { tournament, ctx, error } = await resolveActorTeam({
        guildId: guild.id,
        userId: actorId,
        tournamentKey,
        need: 'manage',
        noun: 'claim free agents'
    });

    if (error) return reply({ content: error });

    const { team } = ctx;

    // ── Find target player ──
    const targetPlayer = await Player.findOne({
        guildId: guild.id,
        discordID: targetUser.id
    });

    if (!targetPlayer) {
        return reply({ content: `❌ ${targetUser} is not registered as a player.` });
    }

    const targetCtx = await getUserTeamInTournament(guild.id, tournament, targetUser.id);

    if (targetCtx) {
        return reply({
            content:
                `❌ ${targetUser} is not a free agent in **${tournament.name}** ` +
                `(they play for **${targetCtx.team.name}**).\n` +
                'Use `.transfer @user` if the player belongs to another team.'
        });
    }

    // ── Sign the player in this tournament ──
    await assignPlayerToTeamInTournament({
        guildId: guild.id,
        tournament,
        player: targetPlayer,
        newTeam: team,
        oldTeamId: null
    });

    // The global record follows this signing if the player is currently teamless
    // or still points at a team that is not registered in this tournament
    // (e.g. a leftover from an old tournament).
    if (targetPlayer.teamId && String(targetPlayer.teamId) !== String(team._id)) {
        await Player.updateOne(
            { _id: targetPlayer._id },
            {
                $set: {
                    teamId: team._id,
                    teamNameSnapshot: team.name,
                    isCaptain: false,
                    isViceCaptain: false
                }
            }
        );
    }

    // ── Response ──
    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ PLAYER SIGNED')
        .setDescription(
            `${targetUser} has joined **${team.name}**.\n\n` +
            `Tournament: **${tournament.name}** (\`${tournament.tournamentKey}\`)`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}
