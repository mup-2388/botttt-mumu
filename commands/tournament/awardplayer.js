/**
 * awardplayer.js
 *
 * Award an individual player (Ballon d'Or, Golden Boot, etc.).
 * Saves to the player's UserProfile for tracking across tournaments.
 *
 * Usage: .awardplayer <key> @user <award>
 * Slash: /awardplayer key:<key> user:<user> award:<type>
 *
 * Aliases: giveaward, awarduser
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Player, TournamentSettings, UserProfile } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { getUserFromArgs } = require('../../utils/stringHelpers');

/** Valid award types with display labels */
const VALID_AWARDS = {
    ballon_dor: "🏆 Ballon d'Or",
    golden_boot: '⚽ Golden Boot',
    golden_glove: '🧤 Golden Glove',
    playmaker: '🎯 Playmaker'
};

module.exports = {
    name: 'awardplayer',
    description: 'Award a player.',
    usage: '.awardplayer [key] @user <award>',
    aliases: ['giveaward', 'awarduser'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('awardplayer')
        .setDescription('Award a player')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Target user')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('award')
                .setDescription('Award type')
                .setRequired(true)
                .addChoices(
                    { name: "Ballon d'Or", value: 'ballon_dor' },
                    { name: 'Golden Boot', value: 'golden_boot' },
                    { name: 'Golden Glove', value: 'golden_glove' },
                    { name: 'Playmaker', value: 'playmaker' }
                )
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

            // Args: [key] user_or_username award_type
            // Pass only the user-position args to getUserFromArgs
            const user = message.mentions.users.first()
                || await getUserFromArgs(message, parsedKey.rest.slice(0, -1));

            const award = parsedKey.rest[parsedKey.rest.length - 1]?.toLowerCase();

            if (!parsedKey.rest.length || !user || !VALID_AWARDS[award]) {
                return message.reply(
                    '❓ Usage: `.awardplayer [key] @user <ballon_dor/golden_boot/golden_glove/playmaker>`\n' +
                    'Without a key the server default tournament is used.'
                );
            }

            return await runAward({
                guild: message.guild,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                discordID: user.id,
                awardType: award,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[awardplayer] prefix error:', error);
            return message.reply('❌ Failed to award player.');
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

            return await runAward({
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                discordID: interaction.options.getUser('user').id,
                awardType: interaction.options.getString('award'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[awardplayer] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to award player.');
            }

            return interaction.reply({ content: '❌ Failed to award player.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Award a player for a tournament.
 * Upserts the UserProfile and pushes the award entry.
 */
async function runAward({ guild, tournamentKey, discordID, awardType, reply }) {
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
        return reply({ content: '❌ Player not found.' });
    }

    // ── Remove any existing award of this type for this tournament (prevent duplicates) ──
    await UserProfile.updateOne(
        { guildId: guild.id, discordID },
        {
            $pull: {
                awards: {
                    tournamentKey: tournament.tournamentKey,
                    awardType
                }
            }
        }
    );

    // ── Upsert profile with the award ──
    await UserProfile.findOneAndUpdate(
        { guildId: guild.id, discordID },
        {
            $setOnInsert: {
                guildId: guild.id,
                discordID,
                allTimeStats: {
                    played: 0, goals: 0, assists: 0, saves: 0,
                    tackles: 0, interceptions: 0, yc: 0, rc: 0, mvps: 0
                },
                trophies: []
            },
            $set: { displayName: player.name },
            $push: {
                awards: {
                    tournamentId: tournament._id,
                    tournamentKey: tournament.tournamentKey,
                    tournamentName: tournament.name,
                    awardType,
                    title: VALID_AWARDS[awardType],
                    awardedAt: new Date()
                }
            }
        },
        { upsert: true, new: true }
    );

    // ── Response ──
    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🏅 PLAYER AWARDED')
        .setDescription(
            `👤 Player: **${player.name}**\n` +
            `🏆 Award: **${VALID_AWARDS[awardType]}**\n` +
            `🎯 Tournament: **${tournament.name}**`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}
