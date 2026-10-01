/**
 * messageteam.js
 *
 * Send a DM to every player on your team (captain/VC only).
 * Skips the sender, tracks delivery success/failure.
 *
 * Works for the server's DEFAULT tournament unless `tournament=<key>` is given.
 *
 * Usage:  .mt <message> [tournament=<key>]
 * Slash:  /messageteam message:<message> [tournament:<key>]
 *
 * Aliases: mt
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { TournamentPlayer } = require('../../models/Tournament');
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const { resolveActorTeam, sameId } = require('../../utils/tournamentContext');

module.exports = {
    name: 'messageteam',
    aliases: ['mt'],
    description: 'Send a DM to every player in your team.',
    hidden: false,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('messageteam')
        .setDescription('Message your entire team')
        .addStringOption(opt =>
            opt.setName('message')
                .setDescription('Message to send')
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

    async execute(message, args) {
        try {
            if (!message.guild) return;

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const content = parsedKey.rest.join(' ').trim();

            if (!content) {
                return message.reply('❓ Usage: `.mt Your message here [tournament=<key>]`');
            }

            return await runMessageTeam({
                guild: message.guild,
                captainId: message.author.id,
                content,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[messageteam] prefix error:', error);
            return message.reply('❌ Failed to send team message.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            const content = interaction.options.getString('message');

            await interaction.deferReply({ ephemeral: true });

            return await runMessageTeam({
                guild: interaction.guild,
                captainId: interaction.user.id,
                content,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[messageteam] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to send team message.');
            }

            return interaction.reply({ content: '❌ Failed to send team message.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * DM every player on the actor's team IN THE TOURNAMENT.
 * 1. Resolve the tournament (explicit key, else the server default)
 * 2. Find the actor's team there (captain / VC only)
 * 3. Load the tournament roster
 * 4. Send DM embed to each (skip sender)
 */
async function runMessageTeam({ guild, captainId, content, tournamentKey = null, reply }) {
    const { tournament, ctx, error } = await resolveActorTeam({
        guildId: guild.id,
        userId: captainId,
        tournamentKey,
        need: 'manage',
        noun: 'message your team'
    });

    if (error) return reply({ content: error });

    const team = ctx.team;
    const isViceCaptain = ctx.isVice;

    /* ── Load the team's roster in this tournament ── */
    const entries = await TournamentPlayer.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        teamId: team._id,
        isActive: true
    }).populate('playerId');

    const players = entries
        .map(e => e.playerId)
        .filter(Boolean);

    if (!players.length) {
        return reply({ content: `❌ No players found in **${team.name}** for **${tournament.name}**.` });
    }

    /* ── Send DM to each player (skip sender) ── */
    let success = 0;
    let failed = 0;

    const senderRole = isViceCaptain ? 'vice captain' : 'captain';

    const dmEmbed = new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle(`📢 Team Message — ${team.name}`)
        .setDescription(content)
        .setFooter({ text: `Sent by your ${senderRole} • ${tournament.name}` })
        .setTimestamp();

    for (const player of players) {
        try {
            if (!player.discordID || player.discordID === captainId) continue;

            const user = await guild.client.users.fetch(player.discordID);
            if (!user) { failed++; continue; }

            await user.send({ embeds: [dmEmbed] });
            success++;
        } catch {
            failed++;
        }
    }

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('✅ Team Message Sent')
        .setDescription(
            `Team: **${team.name}**\n\n` +
            `Delivered: **${success}**\n` +
            `Failed: **${failed}**`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}
