/**
 * freeagent.js
 *
 * Make a registered player a free agent without deleting their stats.
 * Removes them from their team IN THE DEFAULT TOURNAMENT (or `tournament=<key>`).
 * Cannot be used on a team captain — change captain first.
 *
 * Usage:  .freeagent @user [tournament=<key>]
 * Slash:  /freeagent user:<user> [tournament:<key>]
 *
 * Aliases: fa, makefreeagent
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Player } = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { getUserFromArgs } = require('../../utils/stringHelpers');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const {
    sameId,
    effectiveCaptainId,
    getUserTeamInTournament,
    assignPlayerToTeamInTournament
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'freeagent',
    description: 'Make a player a free agent without deleting stats.',
    usage: '.freeagent @user [tournament=<key>]',
    aliases: ['fa', 'makefreeagent'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('freeagent')
        .setDescription('Make a player a free agent without deleting stats')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Player to make free agent')
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

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 You are not authorized.');
            }

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const target =
                message.mentions.users.first() ||
                await getUserFromArgs(message, parsedKey.rest);

            if (!target) {
                return message.reply('❌ Usage: `.freeagent @user [tournament=<key>]`');
            }

            return await runFreeAgent({
                guild: message.guild,
                targetUser: target,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[freeagent] prefix error:', error);
            return message.reply('❌ Failed to make player free agent.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 You are not authorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const target = interaction.options.getUser('user');

            return await runFreeAgent({
                guild: interaction.guild,
                targetUser: target,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[freeagent] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to make player free agent.');
            }

            return interaction.reply({ content: '❌ Failed to make player free agent.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Convert a player to a free agent IN THE TOURNAMENT:
 * 1. Resolve tournament (explicit key, else the server default)
 * 2. Validate player exists and has a team there
 * 3. Block if player is captain (must change captain first)
 * 4. Update the tournament roster entry (global record follows when it should)
 */
async function runFreeAgent({ guild, targetUser, tournamentKey = null, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey);
    if (!resolved.tournament) return reply({ content: resolved.error });

    const tournament = resolved.tournament;

    const player = await Player.findOne({
        guildId: guild.id,
        discordID: targetUser.id
    });

    if (!player) {
        return reply({ content: `❌ ${targetUser} is not registered as a player.` });
    }

    const ctx = await getUserTeamInTournament(guild.id, tournament, targetUser.id);

    if (!ctx) {
        return reply({
            content: `❌ ${targetUser} is already a **FREE AGENT** in **${tournament.name}**.`
        });
    }

    const oldTeam = ctx.team;

    /* ── Block captain from becoming free agent directly ── */
    if (ctx.isCaptain || sameId(effectiveCaptainId(ctx.entry, oldTeam), targetUser.id)) {
        return reply({
            content:
                `❌ ${targetUser} is captain of **${oldTeam.name}**.\n` +
                `Change captain first with \`.cc @newCaptain\`, then try again.`
        });
    }

    await assignPlayerToTeamInTournament({
        guildId: guild.id,
        tournament,
        player,
        newTeam: null,
        oldTeamId: oldTeam._id
    });

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x95A5A6)
        .setTitle('✅ Free Agent Updated')
        .setDescription(
            `${targetUser} is now a **FREE AGENT** in **${tournament.name}**.\n` +
            `Removed from **${oldTeam.name}**.`
        )
        .setFooter({
            text: `Tournament: ${tournament.tournamentKey}`
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}
