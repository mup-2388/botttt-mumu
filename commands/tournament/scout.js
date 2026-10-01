/**
 * scout.js
 *
 * AI scouting report on a team: how they play, their danger man, their weak
 * spot and a one-line plan to beat them — built from real database facts.
 *
 * Usage:  .scout <team name> [tournament=<key>]
 * Slash:  /scout team:<name> [tournament:<key>]
 *
 * Aliases: scoutreport, opposition
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const { isOrganizer } = require('../../utils/isOrganizer');
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const { runTool } = require('../../utils/ai/tournamentTools');
const { buildScoutProse } = require('../../utils/ai/announcements');

module.exports = {
    name: 'scout',
    description: 'AI scouting report on any team.',
    usage: '.scout <team name>',
    aliases: ['scoutreport', 'opposition'],
    hidden: false,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('scout')
        .setDescription('AI scouting report on a team')
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team to scout')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        ),

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args);

            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const teamName = parsedKey.rest.join(' ').trim();

            if (!teamName) {
                return message.reply('❓ Usage: `.scout <team name>` — e.g. `.scout Reds`.');
            }

            return runScout({
                guild: message.guild,
                teamName,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: p => message.reply(p)
            });
        } catch (error) {
            console.error('[scout] prefix error:', error);
            return message.reply('❌ Failed to build the scouting report.');
        }
    },

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return runScout({
                guild: interaction.guild,
                teamName: interaction.options.getString('team'),
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: p => interaction.editReply(p)
            });
        } catch (error) {
            console.error('[scout] slash error:', error);

            const payload = { content: '❌ Failed to build the scouting report.' };

            if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
            return interaction.reply({ ...payload, ephemeral: true });
        }
    }
};

/* ====================================================
   CORE
==================================================== */

async function runScout({ guild, teamName, tournamentKey, reply }) {
    const ctx = { guildId: guild.id, userId: null, tournamentKey };
    const facts = await runTool('scout_report', { team: teamName }, ctx);

    if (facts?.error) {
        return reply({ content: `❌ ${facts.error}` });
    }

    const prose = await buildScoutProse({
        guildId: guild.id,
        teamName: facts.team,
        facts
    }).catch(() => null);

    const table = facts.table;
    const embed = new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle(`🔍 SCOUT REPORT — ${String(facts.team).toUpperCase()}`)
        .setDescription(
            (prose || 'No report available right now — here are the raw numbers.') +
            (facts.tournament ? `\n\n_${facts.tournament}_` : '')
        )
        .setTimestamp();

    if (table) {
        embed.addFields({
            name: '📊 League',
            value:
                `Position: **${table.position}** · ${table.played} played · **${table.points} pts**\n` +
                `${table.wins}W ${table.draws}D ${table.losses}L · GF ${table.gf} GA ${table.ga} (${table.gd >= 0 ? '+' : ''}${table.gd})`,
            inline: false
        });
    }

    if (facts.form?.sequence) {
        embed.addFields({
            name: '📈 Form (last 5)',
            value: `\`${facts.form.sequence}\` → ${facts.form.wins}W ${facts.form.draws}D ${facts.form.losses}L`,
            inline: true
        });
    }

    const stars = [];

    if (facts.topScorer) stars.push(`⚽ ${facts.topScorer.player} (${facts.topScorer.value})`);
    if (facts.topCreator) stars.push(`🎯 ${facts.topCreator.player} (${facts.topCreator.value})`);
    if (facts.keeper) stars.push(`🧤 ${facts.keeper.player} (${facts.keeper.value})`);
    if (stars.length) embed.addFields({ name: '⭐ Danger men', value: stars.join('\n'), inline: true });

    if (facts.recentResults?.length) {
        embed.addFields({
            name: '🗓️ Recent',
            value: facts.recentResults.slice(0, 5).map(r => `**${r.score}** vs ${r.opponent} (${r.outcome})`).join('\n'),
            inline: false
        });
    }

    if (facts.upcoming?.length) {
        embed.addFields({
            name: '⏭️ Next up',
            value: facts.upcoming.slice(0, 3).map(f => `#${f.matchNumber} vs **${f.opponent}** (${f.homeAway})`).join('\n'),
            inline: false
        });
    }

    return reply({ embeds: [embed] });
}
