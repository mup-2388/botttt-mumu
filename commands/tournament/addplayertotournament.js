/**
 * addplayertotournament.js
 *
 * Manually add or re-add a player to a specific tournament.
 * Organizer only. Syncs the player using tournamentSync utils.
 *
 * Usage: .addplayertotournament <key> @user
 * Slash: /addplayertotournament key:<key> user:<user>
 *
 * Aliases: aptt, jointournamentplayer
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const { Player, Team, TournamentSettings } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { syncPlayerToTournament } = require('../../utils/tournamentSync');
const { getUserFromArgs } = require('../../utils/stringHelpers');

module.exports = {
    name: 'addplayertotournament',
    description: 'Manually add/re-add a player to a tournament.',
    usage: '.addplayertotournament [key] @user',
    aliases: ['aptt', 'jointournamentplayer'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('addplayertotournament')
        .setDescription('Add a player to a tournament')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Player user')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 You are not authorized.');
            }

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args);
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const user = message.mentions.users.first()
                || await getUserFromArgs(message, parsedKey.rest);

            if (!user) {
                return message.reply(
                    '❓ Usage: `.addplayertotournament [key] @user`\n' +
                    'Without a key the server default tournament is used.'
                );
            }

            return await runAdd({
                guild: message.guild,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                discordID: user.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[addplayertotournament] prefix error:', error);
            return message.reply('❌ Failed to add player to tournament.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 You are not authorized.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runAdd({
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                discordID: interaction.options.getUser('user').id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[addplayertotournament] slash error:', error);

            if (interaction.deferred || interaction.replied) {
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
   CORE LOGIC
==================================================== */

/**
 * Add a player to a tournament by key.
 * Validates: tournament exists, player exists, player has a team.
 */
async function runAdd({ guild, tournamentKey, discordID, reply }) {
    // ── Find tournament ──
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    // ── Find player ──
    const player = await Player.findOne({
        guildId: guild.id,
        discordID
    });

    if (!player) {
        return reply({ content: '❌ Global player profile not found.' });
    }

    // ── Find player's team ──
    const team = await Team.findOne({
        guildId: guild.id,
        _id: player.teamId
    });

    if (!team) {
        return reply({ content: '❌ Player is not assigned to any team.' });
    }

    // ── Sync player into tournament ──
    await syncPlayerToTournament(guild.id, tournament, player, team);

    // ── Response ──
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('✅ PLAYER ADDED TO TOURNAMENT')
        .setDescription(
            `**${player.name}** has been added to **${tournament.name}**.\n\n` +
            `👤 Linked User: <@${discordID}>\n` +
            `🏟️ Team: **${team.name}**\n` +
            `🏆 Tournament: \`${tournament.tournamentKey}\``
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}
