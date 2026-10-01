/**
 * digest.js
 *
 * Daily league digest: results, top performers, what didn't happen, what's next
 * — written by the AI with a bit of roast, from real database facts.
 *
 * Usage:  .digest [days] [tournament=<key>]
 * Slash:  /digest [days:<n>]
 *
 * Aliases: dailydigest, roundup
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const { Fixture, Team } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { runTool } = require('../../utils/ai/tournamentTools');
const { buildDigestProse } = require('../../utils/ai/announcements');
const { discordFull, discordRelative } = require('../../utils/istTime');

module.exports = {
    name: 'digest',
    description: 'Daily league digest: results, stars, missed matches, what is next.',
    usage: '.digest [days]',
    aliases: ['dailydigest', 'roundup'],
    hidden: false,
    cooldown: 15,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('digest')
        .setDescription('Daily league digest written by the AI')
        .addIntegerOption(opt =>
            opt.setName('days')
                .setDescription('How many days back to cover (default 1)')
                .setRequired(false)
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

            const days = Math.min(Math.max(Number(parsedKey.rest[0]) || 1, 1), 14);

            return runDigest({
                guild: message.guild,
                days,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[digest] prefix error:', error);
            return message.reply('❌ Failed to build the digest.');
        }
    },

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return runDigest({
                guild: interaction.guild,
                days: Math.min(Math.max(interaction.options.getInteger('days') || 1, 1), 14),
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[digest] slash error:', error);

            const payload = { content: '❌ Failed to build the digest.' };

            if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
            return interaction.reply({ ...payload, ephemeral: true });
        }
    }
};

/* ====================================================
   CORE
==================================================== */

async function runDigest({ guild, days, tournamentKey, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey, { includeCompleted: true });

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;
    const ctx = { guildId: guild.id, userId: null, tournamentKey: tournament.tournamentKey };

    const since = new Date(Date.now() - days * 24 * 3600_000);

    /* ── Results in the window ── */
    const played = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        status: 'Played',
        updatedAt: { $gte: since }
    }).sort({ updatedAt: -1 }).lean();

    /* ── Matches that should have happened but didn't ── */
    const missed = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        status: 'Pending',
        scheduledAt: { $ne: null, $lt: new Date() }
    }).sort({ scheduledAt: 1 }).limit(10).lean();

    /* ── Next up ── */
    const upcoming = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        status: { $in: ['Pending', 'Live'] },
        $or: [
            { scheduledAt: { $gte: new Date() } },
            { scheduledAt: null }
        ]
    }).sort({ scheduledAt: 1, matchNumber: 1 }).limit(5).lean();

    /* ── Top performers (season leaders, labelled as such) ── */
    const [scorers, assisters, keepers, table] = await Promise.all([
        runTool('leaders', { metric: 'goals', limit: 3 }, ctx),
        runTool('leaders', { metric: 'assists', limit: 3 }, ctx),
        runTool('leaders', { metric: 'saves', limit: 3 }, ctx),
        runTool('standings', {}, ctx)
    ]);

    /* ── Goals per match for the highlights line ── */
    const results = played.slice(0, 8).map(f => ({
        match: f.matchNumber,
        home: f.homeTeam,
        away: f.awayTeam,
        score: `${f.result?.home ?? '-'}-${f.result?.away ?? '-'}`
    }));

    const biggest = played
        .map(f => ({
            match: f.matchNumber,
            teams: `${f.homeTeam} ${f.result?.home ?? '-'}-${f.result?.away ?? '-'} ${f.awayTeam}`,
            margin: Math.abs((f.result?.home ?? 0) - (f.result?.away ?? 0)),
            goals: (f.result?.home ?? 0) + (f.result?.away ?? 0)
        }))
        .sort((a, b) => b.goals - a.goals || b.margin - a.margin)[0] || null;

    const facts = {
        days,
        tournament: tournament.name,
        playedCount: played.length,
        results,
        biggestScore: biggest,
        missedCount: missed.length,
        missed: missed.slice(0, 5).map(f => ({
            match: f.matchNumber,
            teams: `${f.homeTeam} vs ${f.awayTeam}`,
            wasDue: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : null
        })),
        upcoming: upcoming.map(f => ({
            match: f.matchNumber,
            teams: `${f.homeTeam} vs ${f.awayTeam}`,
            at: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : null,
            venue: f.venueName || null
        })),
        topScorers: scorers.leaders || [],
        topAssisters: assisters.leaders || [],
        topKeepers: keepers.leaders || [],
        tableTop: (table.table || []).slice(0, 4)
    };

    const prose = await buildDigestProse({
        guildId: guild.id,
        tournamentName: tournament.name,
        facts
    }).catch(() => null);

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`📰 ${tournament.emoji || '🏆'} ${String(tournament.name).toUpperCase()} — DAILY DIGEST`)
        .setTimestamp();

    if (prose) {
        embed.setDescription(prose.slice(0, 3800));
    }

    if (facts.playedCount) {
        embed.addFields({
            name: '⚽ Results',
            value: results.slice(0, 6).map(r => `**#${r.match}** ${r.home} **${r.score}** ${r.away}`).join('\n') || '—',
            inline: false
        });
    } else {
        embed.addFields({ name: '⚽ Results', value: `No matches were played in the last ${days} day(s). 😴`, inline: false });
    }

    if (biggest) {
        embed.addFields({ name: '🔥 Game of the day', value: `**#${biggest.match}** · ${biggest.teams} (${biggest.goals} goals)`, inline: false });
    }

    const starLines = [];

    if (scorers.leaders?.length) {
        starLines.push(`🥇 ${scorers.leaders.map(l => `${l.player} (${l.value})`).join(', ')} — golden boot`);
    }

    if (assisters.leaders?.length) {
        starLines.push(`🎯 ${assisters.leaders.map(l => `${l.player} (${l.value})`).join(', ')} — assists`);
    }

    if (keepers.leaders?.length) {
        starLines.push(`🧤 ${keepers.leaders.map(l => `${l.player} (${l.value})`).join(', ')} — saves`);
    }

    if (starLines.length) {
        embed.addFields({ name: '🌟 Top performers', value: starLines.join('\n'), inline: false });
    }

    if (missed.length) {
        embed.addFields({
            name: '🚫 Didn\'t happen',
            value: missed.slice(0, 5).map(f => `**#${f.matchNumber}** ${f.homeTeam} vs ${f.awayTeam} — was due ${discordRelative(f.scheduledAt)}`).join('\n'),
            inline: false
        });
    }

    if (upcoming.length) {
        embed.addFields({
            name: '📅 Next up',
            value: upcoming.map(f =>
                `**#${f.matchNumber}** ${f.homeTeam} vs ${f.awayTeam} — ` +
                (f.scheduledAt ? `${discordFull(f.scheduledAt)} (${discordRelative(f.scheduledAt)})` : 'time TBD') +
                (f.venueName ? ` · ${f.venueName}` : '')
            ).join('\n'),
            inline: false
        });
    }

    if (table.table?.length) {
        embed.addFields({
            name: '📊 Table (top 4)',
            value: table.table.slice(0, 4).map(r => `**${r.pos}.** ${r.team} — ${r.points} pts (${r.wins}W ${r.draws}D ${r.losses}L)`).join('\n'),
            inline: false
        });
    }

    embed.setFooter({ text: `${tournament.name} · last ${days} day(s) · times in your timezone` });

    return reply({ embeds: [embed] });
}
