/**
 * pingteam.js
 *
 * Ping your team's Discord role. Captain/VC only.
 * Uses a manual 10s cooldown per user per guild.
 * Sends ONLY the role ping — no confirmation message.
 *
 * Works for the server's DEFAULT tournament unless `tournament=<key>` is given:
 * the team is the one you captain/vice-captain THERE.
 *
 * Usage:  .pingteam [tournament=<key>]
 * Slash:  /pingteam [tournament:<key>]
 *
 * Aliases: pt
 */

const { SlashCommandBuilder } = require('discord.js');
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const { resolveActorTeam } = require('../../utils/tournamentContext');

const COOLDOWN = 10 * 1000;
const cooldowns = new Map();

module.exports = {
    name: 'pingteam',
    description: 'Ping your team captain-only.',
    usage: '.pingteam [tournament=<key>]',
    aliases: ['pt'],
    hidden: false,
    cooldown: 10,

    data: new SlashCommandBuilder()
        .setName('pingteam')
        .setDescription('Ping your team captain-only')
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

            return await runPing({
                guild: message.guild,
                user: message.author,
                channel: message.channel,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[pingteam] prefix error:', error);
            return message.reply('❌ Failed to ping team.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            return await runPing({
                guild: interaction.guild,
                user: interaction.user,
                channel: interaction.channel,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[pingteam] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to ping team.');
            }

            return interaction.reply({ content: '❌ Failed to ping team.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/** Ping the team's Discord role. Only captain/VC of a team in the tournament can use this. */
async function runPing({ guild, user, channel, tournamentKey = null, reply }) {
    /* ── Cooldown check ── */
    const now = Date.now();
    const cooldownKey = `${guild.id}:${user.id}`;

    if (cooldowns.has(cooldownKey)) {
        const expires = cooldowns.get(cooldownKey);

        if (now < expires) {
            const remaining = Math.ceil((expires - now) / 1000);
            return reply({ content: `⏳ You can ping again in **${remaining}s**.` });
        }
    }

    /* ── Find the user's team in the tournament ── */
    const { tournament, ctx, error } = await resolveActorTeam({
        guildId: guild.id,
        userId: user.id,
        tournamentKey,
        need: 'manage',
        noun: 'ping your team'
    });

    if (error) return reply({ content: error });

    const team = ctx.team;

    /* ── Find matching Discord role ── */
    const role = guild.roles.cache.find(
        r => r.name.toLowerCase() === team.name.toLowerCase()
    );

    if (!role) {
        return reply({ content: `❌ Team role for **${team.name}** not found.` });
    }

    /* ── Ping and set cooldown ── */
    await channel.send({ content: `<@&${role.id}>` });

    cooldowns.set(cooldownKey, now + COOLDOWN);
}
