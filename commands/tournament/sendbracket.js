/**
 * sendbracket.js
 *
 * Send a live-updating knockout bracket embed for a tournament.
 * The bracket is stored in client.liveSettings and can be refreshed
 * via the exported refreshLiveBracket function.
 *
 * Supports single-leg and two-legged ties, aggregate scoring,
 * and penalty shootout resolution.
 *
 * Usage:  .sendbracket [tournamentKey]
 * Slash:  /sendbracket [key]
 *
 * Aliases: livebracket, postbracket
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Fixture } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { prettyPhase } = require('../../utils/displayHelpers');
const {
    getDefaultTournament,
    getTournamentByKey,
    extractTournamentFromArgs
} = require('../../utils/getTournament');

module.exports = {
    name: 'sendbracket',
    description: 'Send a tournament knockout bracket.',
    usage: '.sendbracket [tournamentKey]',
    aliases: ['livebracket', 'postbracket'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('sendbracket')
        .setDescription('Send tournament bracket')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const parsed = await extractTournamentFromArgs(message.guild.id, args);

            if (parsed.explicit && parsed.error) {
                return message.reply(parsed.error);
            }

            const tournament = parsed.tournament;

            if (!tournament) {
                return message.reply('❌ Tournament not found.');
            }

            /* ── Generate & send bracket embed ── */
            const embed = await generateBracketEmbed(message.guild.id, tournament.tournamentKey);

            const sent = await message.channel.send({ embeds: [embed] });

            /* ── Store live bracket reference ── */
            if (message.client.liveSettings) {
                message.client.liveSettings.set(
                    getLiveBracketKey(message.guild.id, tournament.tournamentKey),
                    {
                        channelId: sent.channel.id,
                        messageId: sent.id,
                        tournamentKey: tournament.tournamentKey
                    }
                );
            }

            return message.reply('✅ Live bracket message sent and linked.');
        } catch (error) {
            console.error('[sendbracket] prefix error:', error);
            return message.reply('❌ Failed to send bracket.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 Unauthorized.',
                    ephemeral: true
                });
            }

            const key = interaction.options.getString('key')?.toLowerCase() || null;

            const tournament = key
                ? await getTournamentByKey(interaction.guild.id, key)
                : await getDefaultTournament(interaction.guild.id);

            if (!tournament) {
                return interaction.reply({
                    content: '❌ Tournament not found.',
                    ephemeral: true
                });
            }

            /* ── Generate & send bracket embed ── */
            const embed = await generateBracketEmbed(interaction.guild.id, tournament.tournamentKey);

            const sent = await interaction.channel.send({ embeds: [embed] });

            /* ── Store live bracket reference ── */
            if (interaction.client.liveSettings) {
                interaction.client.liveSettings.set(
                    getLiveBracketKey(interaction.guild.id, tournament.tournamentKey),
                    {
                        channelId: sent.channel.id,
                        messageId: sent.id,
                        tournamentKey: tournament.tournamentKey
                    }
                );
            }

            return interaction.reply({
                content: '✅ Live bracket message sent and linked.',
                ephemeral: true
            });
        } catch (error) {
            console.error('[sendbracket] slash error:', error);

            if (interaction.replied || interaction.deferred) {
                return interaction.editReply('❌ Failed to send bracket.');
            }

            return interaction.reply({
                content: '❌ Failed to send bracket.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   BRACKET EMBED GENERATOR
==================================================== */

/**
 * Build a bracket embed from knockout fixtures.
 * Groups fixtures by phase (qualifier → eliminator → QF → SF → Final).
 * Supports single-leg and two-legged ties with aggregate scoring.
 */
async function generateBracketEmbed(guildId, tournamentKey = null) {
    const tournament = tournamentKey
        ? await getTournamentByKey(guildId, tournamentKey)
        : await getDefaultTournament(guildId);

    if (!tournament) {
        return new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('❌ BRACKET ERROR')
            .setDescription('Tournament not found.');
    }

    /* ── Load knockout fixtures ── */
    const fixtures = await Fixture.find({
        guildId,
        tournamentId: tournament._id,
        phase: { $in: ['qualifier', 'eliminator', 'roundof16', 'quarterfinal', 'semifinal', 'final'] }
    }).sort({ phase: 1, matchNumber: 1, leg: 1 });

    const embed = new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle(`${tournament.emoji || '🏆'} ${tournament.name.toUpperCase()} — LIVE BRACKET`)
        .setDescription(
            fixtures.length
                ? `Key: \`${tournament.tournamentKey}\`\nKnockout bracket generated from tournament fixtures.`
                : `Key: \`${tournament.tournamentKey}\`\nNo knockout fixtures found yet.`
        )
        .setTimestamp();

    if (!fixtures.length) {
        embed.addFields({
            name: 'Bracket',
            value: 'No knockout rounds available yet.',
            inline: false
        });
        return embed;
    }

    /* ── Group by phase ── */
    const grouped = groupFixturesByPhase(fixtures);
    const phaseOrder = ['qualifier', 'eliminator', 'roundof16', 'quarterfinal', 'semifinal', 'final'];

    for (const phase of phaseOrder) {
        const phaseFixtures = grouped[phase] || [];
        if (!phaseFixtures.length) continue;

        embed.addFields({
            name: prettyPhase(phase),
            value: formatPhaseBlock(phaseFixtures),
            inline: false
        });
    }

    return embed;
}

/* ====================================================
   LIVE BRACKET REFRESH
==================================================== */

/**
 * Refresh an existing live bracket message.
 * Called by other commands (e.g. advanceknockout) after bracket changes.
 */
async function refreshLiveBracket(client, guildId, tournamentKey) {
    if (!client?.liveSettings) return;

    const key = getLiveBracketKey(guildId, tournamentKey);
    const saved = client.liveSettings.get(key);

    if (!saved) return;

    try {
        const channel = await client.channels.fetch(saved.channelId).catch(() => null);
        if (!channel) {
            client.liveSettings.delete(key);
            return;
        }

        const message = await channel.messages.fetch(saved.messageId).catch(() => null);
        if (!message) {
            client.liveSettings.delete(key);
            return;
        }

        const embed = await generateBracketEmbed(guildId, tournamentKey);
        await message.edit({ embeds: [embed] });
    } catch (error) {
        console.error('[sendbracket] refreshLiveBracket error:', error);
        client.liveSettings.delete(key);
    }
}

/* ====================================================
   FORMATTING HELPERS
==================================================== */

/** Group an array of fixtures into an object keyed by phase. */
function groupFixturesByPhase(fixtures) {
    const grouped = {};

    for (const fixture of fixtures) {
        if (!grouped[fixture.phase]) grouped[fixture.phase] = [];
        grouped[fixture.phase].push(fixture);
    }

    return grouped;
}

/** Group fixtures into ties (by aggregateTieKey, roundLabel, or unique key). */
function groupFixturesByTie(fixtures) {
    const map = new Map();

    for (const fixture of fixtures) {
        const key =
            fixture.aggregateTieKey ||
            fixture.roundLabel ||
            `${fixture.phase}_${fixture.matchNumber}`;

        if (!map.has(key)) map.set(key, []);
        map.get(key).push(fixture);
    }

    return Array.from(map.values());
}

/** Format all fixtures for one phase into a text block. */
function formatPhaseBlock(fixtures) {
    const ties = groupFixturesByTie(fixtures);

    return ties
        .map((tie, index) => {
            if (tie.length === 1) {
                return formatSingleFixture(tie[0], index + 1);
            }

            return formatTwoLegTie(
                [...tie].sort((a, b) => (a.leg || 1) - (b.leg || 1)),
                index + 1
            );
        })
        .join('\n\n');
}

/** Format a single-leg tie. */
function formatSingleFixture(fixture, tieNumber) {
    const score = displayFixtureScore(fixture);
    const winner = resolveWinnerText(fixture);

    return (
        `**Tie ${tieNumber}**\n` +
        `• ${fixture.homeTeam} ${score} ${fixture.awayTeam}\n` +
        `${winner ? `• Winner: **${winner}**` : `• Status: **${fixture.status}**`}`
    );
}

/** Format a two-legged tie with aggregate score. */
function formatTwoLegTie(fixtures, tieNumber) {
    const [leg1, leg2] = fixtures;
    const aggregateWinner = resolveAggregateWinner(fixtures);

    return (
        `**Tie ${tieNumber}**\n` +
        `• Leg 1: ${leg1.homeTeam} ${displayFixtureScore(leg1)} ${leg1.awayTeam}\n` +
        `• Leg 2: ${leg2.homeTeam} ${displayFixtureScore(leg2)} ${leg2.awayTeam}\n` +
        `${aggregateWinner ? `• Winner: **${aggregateWinner}**` : `• Status: **${leg1.status}/${leg2.status}**`}`
    );
}

/* ====================================================
   SCORE & WINNER RESOLUTION
==================================================== */

/** Display the score for a single fixture, or 'vs' if not played. */
function displayFixtureScore(fixture) {
    if (!fixture || fixture.status !== 'Played') return 'vs';

    const home = fixture?.result?.home;
    const away = fixture?.result?.away;

    if (home === null || away === null || typeof home === 'undefined' || typeof away === 'undefined') {
        return 'vs';
    }

    let text = `${home}-${away}`;

    const pHome = fixture?.result?.penaltiesHome;
    const pAway = fixture?.result?.penaltiesAway;

    if (pHome !== null && pAway !== null && typeof pHome !== 'undefined' && typeof pAway !== 'undefined') {
        text += ` | Pens ${pHome}-${pAway}`;
    }

    return text;
}

/** Resolve the winner text for a single fixture. */
function resolveWinnerText(fixture) {
    if (fixture?.result?.winner) return fixture.result.winner;
    if (fixture.status !== 'Played') return '';

    const home = fixture?.result?.home;
    const away = fixture?.result?.away;

    if (home > away) return fixture.homeTeam;
    if (away > home) return fixture.awayTeam;

    const pHome = fixture?.result?.penaltiesHome;
    const pAway = fixture?.result?.penaltiesAway;

    if (pHome > pAway) return fixture.homeTeam;
    if (pAway > pHome) return fixture.awayTeam;

    return '';
}

/** Resolve the aggregate winner across a two-legged tie. */
function resolveAggregateWinner(fixtures) {
    if (fixtures.length < 2) return '';

    const [leg1, leg2] = fixtures;

    if (leg1.status !== 'Played' || leg2.status !== 'Played') return '';

    const teamA = leg1.homeTeam;
    const teamB = leg1.awayTeam;

    const teamATotal =
        (leg1.result?.home || 0) +
        (leg2.homeTeam === teamA ? (leg2.result?.home || 0) : (leg2.result?.away || 0));

    const teamBTotal =
        (leg1.result?.away || 0) +
        (leg2.homeTeam === teamB ? (leg2.result?.home || 0) : (leg2.result?.away || 0));

    if (teamATotal > teamBTotal) return teamA;
    if (teamBTotal > teamATotal) return teamB;

    /* ── Check penalties on leg 2 ── */
    const pHome = leg2.result?.penaltiesHome;
    const pAway = leg2.result?.penaltiesAway;

    if (pHome !== null && pAway !== null && typeof pHome !== 'undefined' && typeof pAway !== 'undefined') {
        if (leg2.homeTeam === teamA) {
            if (pHome > pAway) return teamA;
            if (pAway > pHome) return teamB;
        } else {
            if (pHome > pAway) return teamB;
            if (pAway > pHome) return teamA;
        }
    }

    return leg2.result?.winner || '';
}

/* ====================================================
   KEY HELPERS
==================================================== */

/** Build the liveSettings key for a bracket. */
function getLiveBracketKey(guildId, tournamentKey) {
    return `live_bracket:${guildId}:${tournamentKey}`;
}

/* ====================================================
   EXPORTS FOR EXTERNAL USE
==================================================== */

module.exports.generateBracketEmbed = generateBracketEmbed;
module.exports.refreshLiveBracket = refreshLiveBracket;
