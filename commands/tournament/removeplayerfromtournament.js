/**
 * removeplayerfromtournament.js
 *
 * Remove a player from a specific tournament (deactivates their entry).
 * Does NOT delete the global player record.
 *
 * Usage:  .removeplayerfromtournament <key> @user
 * Slash:  /removeplayerfromtournament key:<key> user:<user>
 *
 * Aliases: rptt, removetournamentplayer
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const {
    Player,
    TournamentSettings,
    TournamentPlayer
} = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { getUserFromArgs } = require('../../utils/stringHelpers');

module.exports = {
    name: 'removeplayerfromtournament',
    description: 'Remove a player from a tournament.',
    usage: '.removeplayerfromtournament [key] @user',
    aliases: ['rptt', 'removetournamentplayer'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('removeplayerfromtournament')
        .setDescription('Remove a player from a tournament')
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
                    '❓ Usage: `.removeplayerfromtournament [key] @user`\n' +
                    'Without a key the server default tournament is used.'
                );
            }

            return await runRemove({
                guild: message.guild,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                discordID: user.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[removeplayerfromtournament] prefix error:', error);
            return message.reply('❌ Failed to remove player.');
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

            return await runRemove({
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                discordID: interaction.options.getUser('user').id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[removeplayerfromtournament] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to remove player.');
            }

            return interaction.reply({ content: '❌ Failed to remove player.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/** Deactivate a player's tournament entry. Does not delete the global player. */
async function runRemove({ guild, tournamentKey, discordID, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    const player = await Player.findOne({
        guildId: guild.id,
        discordID
    });

    if (!player) {
        return reply({ content: '❌ Global player profile not found.' });
    }

    const updated = await TournamentPlayer.findOneAndUpdate(
        {
            guildId: guild.id,
            tournamentId: tournament._id,
            playerId: player._id
        },
        { $set: { isActive: false } },
        { new: true }
    );

    if (!updated) {
        return reply({ content: `❌ ${player.name} is not in this tournament.` });
    }

    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🚫 PLAYER REMOVED FROM TOURNAMENT')
        .setDescription(
            `**${player.name}** has been removed from **${tournament.name}**.\n\n` +
            `👤 Linked User: <@${discordID}>\n` +
            `🏆 Tournament: \`${tournament.tournamentKey}\``
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}
