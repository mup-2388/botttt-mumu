/**
 * teamreport.js
 *
 * Team report: how they play, their danger man, their weak spot and a one-line
 * plan to beat them — built from real database facts.
 *
 * (Named `teamreport`, not `scout`: "scouting" sounds like a club scouting a
 *  player, this is a report on a whole team.)
 *
 * Usage:  .teamreport <team name> [tournament=<key>]
 * Slash:  /teamreport team:<name> [tournament:<key>]
 *
 * Aliases: treport, opposition
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const { isOrganizer } = require('../../utils/isOrganizer');
const { slotEmoji, vsLine } = require('../../utils/ai/emojiSlots');
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const { runTool } = require('../../utils/ai/tournamentTools');
const { buildTeamReportProse } = require('../../utils/ai/announcements');

module.exports = {
    name: 'teamreport',
    description: 'Team report: form, danger men and what is next for any team.',
    usage: '.teamreport <team name>',
    aliases: ['treport', 'opposition'],
    hidden: false,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('teamreport')
        .setDescription('Team report: form, danger men and what is next')
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team to analyse')
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
                return message.reply('❓ Usage: `.teamreport <team name>` — e.g. `.teamreport Reds`.');
            }

            return runTeamReport({
                guild: message.guild,
                teamName,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: p => message.reply(p)
            });
        } catch (error) {
            console.error('[teamreport] prefix error:', error);
            return message.reply('❌ Failed to build the team report.');
        }
    },

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return runTeamReport({
                guild: interaction.guild,
                teamName: interaction.options.getString('team'),
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: p => interaction.editReply(p)
            });
        } catch (error) {
            console.error('[teamreport] slash error:', error);

            const payload = { content: '❌ Failed to build the team report.' };

            if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
            return interaction.reply({ ...payload, ephemeral: true });
        }
    }
};

/* ====================================================
   CORE
==================================================== */

async function runTeamReport({ guild, teamName, tournamentKey, reply }) {
    const ctx = { guildId: guild.id, userId: null, tournamentKey };
    const facts = await runTool('team_report', { team: teamName }, ctx);

    if (facts?.error) {
        return reply({ content: `❌ ${facts.error}` });
    }

    const prose = await buildTeamReportProse({
        guildId: guild.id,
        teamName: facts.team,
        facts
    }).catch(() => null);

    const table = facts.table;
    const embed = new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle(`${slotEmoji('report', guild.id) || '📋'} TEAM REPORT — ${String(facts.team).toUpperCase()}`)
        .setDescription(
            (prose || 'No report available right now — here are the raw numbers.') +
            (facts.tournament ? `\n\n_${facts.tournament}_` : '')
        )
        .setTimestamp();

    if (table) {
        embed.addFields({
            name: `${slotEmoji('goals', guild.id)} League`,
            value:
                `Position: **${table.position}** · ${table.played} played · **${table.points} pts**\n` +
                `${table.wins}W ${table.draws}D ${table.losses}L · ${slotEmoji('goals', guild.id)} GF ${table.gf} GA ${table.ga} (${table.gd >= 0 ? '+' : ''}${table.gd})`,
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

    if (facts.topScorer) stars.push(`${slotEmoji('goals', guild.id)} ${facts.topScorer.player} (${facts.topScorer.value})`);
    if (facts.topCreator) stars.push(`${slotEmoji('assists', guild.id)} ${facts.topCreator.player} (${facts.topCreator.value})`);
    if (facts.keeper) stars.push(`${slotEmoji('saves', guild.id)} ${facts.keeper.player} (${facts.keeper.value})`);
    if (stars.length) embed.addFields({ name: '⭐ Danger men', value: stars.join('\n'), inline: true });

    if (facts.recentResults?.length) {
        embed.addFields({
            name: `${slotEmoji('calendar', guild.id)} Recent`,
            value: facts.recentResults.slice(0, 5).map(r => `**${r.score}** · ${vsLine(facts.team, r.opponent, guild.id)} (${r.outcome})`).join('\n'),
            inline: false
        });
    }

    if (facts.upcoming?.length) {
        embed.addFields({
            name: `${slotEmoji('calendar', guild.id) || '⏭️'} Next up`,
            value: facts.upcoming.slice(0, 3).map(f =>
                `#${f.matchNumber} · ${vsLine(facts.team, f.opponent, guild.id)} (${f.homeAway})` +
                (f.reserved ? ` · ${slotEmoji('reserve', guild.id)} Reserved` : '')
            ).join('\n'),
            inline: false
        });
    }

    return reply({ embeds: [embed] });
}
