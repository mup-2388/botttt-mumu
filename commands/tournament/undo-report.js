/**
 * undo-report.js
 *
 * Undo a reported match and reverse tournament stats.
 * Reverses team standings, player stats, and all-time profiles.
 *
 * Usage:  .undo-report [tournamentKey] <matchNumber>
 * Slash:  /undo-report key:<value> match:<number>
 * Aliases: undoreport, revertmatch
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Fixture,
    Player,
    TournamentTeam,
    TournamentPlayer,
    UserProfile
} = require('../../models/Tournament');

const {
    getDefaultTournament,
    getTournamentByKey
} = require('../../utils/getTournament');

const { updateAllLiveStandings } = require('../../utils/updateStandings');
const { updateLiveTopStats } = require('../../utils/updateTopStats');
const { refreshLiveMasterSchedules } = require('./master-schedule');
const { refreshLiveBracket } = require('./sendbracket');
const { isOrganizer } = require('../../utils/isOrganizer');

module.exports = {
    name: 'undo-report',
    description: 'Undo a reported match and reverse tournament stats.',
    usage: '.undo-report [tournamentKey] <matchNumber>',
    aliases: ['undoreport', 'revertmatch'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('undo-report')
        .setDescription('Undo a reported fixture')
        .addIntegerOption(opt =>
            opt.setName('match')
                .setDescription('Match number')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key (default: the default tournament)')
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

            if (!args.length) {
                return message.reply('❌ Usage: `.undo-report [tournamentKey] <matchNumber>`');
            }

            const parsed = parsePrefixArgs(args);

            if (!parsed.ok) {
                return message.reply(parsed.error);
            }

            return await runUndo({
                client: message.client,
                guild: message.guild,
                key: parsed.key,
                matchNumber: parsed.matchNumber,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[undo-report] prefix error:', error);
            return message.reply('❌ Failed to undo report.');
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

            await interaction.deferReply({ ephemeral: true });

            return await runUndo({
                client: interaction.client,
                guild: interaction.guild,
                key: interaction.options.getString('key')?.toLowerCase() || null,
                matchNumber: interaction.options.getInteger('match'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[undo-report] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to undo report.');
            }

            return interaction.reply({
                content: '❌ Failed to undo report.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   ARG PARSER
==================================================== */

function parsePrefixArgs(args) {
    let key = null;
    let matchNumber = null;

    if (args.length === 1) {
        matchNumber = parseInt(args[0], 10);
    } else {
        key = args[0].toLowerCase();
        matchNumber = parseInt(args[1], 10);
    }

    if (!matchNumber || Number.isNaN(matchNumber)) {
        return {
            ok: false,
            error: '❌ Invalid match number.'
        };
    }

    return {
        ok: true,
        key,
        matchNumber
    };
}

/* ====================================================
   CORE LOGIC
==================================================== */

async function runUndo({
    client,
    guild,
    key,
    matchNumber,
    reply
}) {
    const tournament = key
        ? await getTournamentByKey(guild.id, key)
        : await getDefaultTournament(guild.id);

    if (!tournament) {
        return reply({
            content: '❌ Tournament not found.'
        });
    }

    const fixture = await Fixture.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        matchNumber
    });

    if (!fixture) {
        return reply({
            content:
                `❌ Fixture #${matchNumber} not found in ` +
                `\`${tournament.tournamentKey}\`.`
        });
    }

    if (fixture.status !== 'Played') {
        return reply({
            content: '❌ This fixture is not reported yet.'
        });
    }

    const homeGoals = safeNumber(fixture.result?.home);
    const awayGoals = safeNumber(fixture.result?.away);

    const affectsStandings = ['league', 'group'].includes(fixture.phase);

    let teamStatsReversed = false;

    if (affectsStandings) {
        const homeTournamentTeam = await findTournamentTeamEntry({
            fixture,
            tournament,
            side: 'home'
        });

        const awayTournamentTeam = await findTournamentTeamEntry({
            fixture,
            tournament,
            side: 'away'
        });

        if (!homeTournamentTeam || !awayTournamentTeam) {
            return reply({
                content: '❌ Tournament team entries missing. Cannot safely reverse standings.'
            });
        }

        reverseTeamStats({
            stats: homeTournamentTeam.stats,
            goalsFor: homeGoals,
            goalsAgainst: awayGoals,
            tournament
        });

        reverseTeamStats({
            stats: awayTournamentTeam.stats,
            goalsFor: awayGoals,
            goalsAgainst: homeGoals,
            tournament
        });

        await homeTournamentTeam.save();
        await awayTournamentTeam.save();

        teamStatsReversed = true;
    }

    const playerReverseResult = await reverseFixturePlayerStats({
        guildId: guild.id,
        tournament,
        fixture
    });

    fixture.status = 'Pending';

    fixture.result = {
        home: null,
        away: null,
        extraTimeHome: null,
        extraTimeAway: null,
        penaltiesHome: null,
        penaltiesAway: null,
        winner: ''
    };

    fixture.playerStats = [];
    fixture.reportedBy = null;
    fixture.reportedAt = null;
    fixture.notes = fixture.notes || '';

    await fixture.save();

    /* ── Refresh live views ── */

    await updateAllLiveStandings(client, guild.id).catch(console.error);

    await updateLiveTopStats(
        client,
        guild.id,
        tournament.tournamentKey
    ).catch(console.error);

    await refreshLiveMasterSchedules(
        client,
        guild.id,
        tournament.tournamentKey
    ).catch(console.error);

    await refreshLiveBracket(
        client,
        guild.id,
        tournament.tournamentKey
    ).catch(console.error);

    if (global.io) {
        global.io.emit('update');
    }

    const embed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setTitle('↩️ MATCH REPORT UNDONE')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Fixture #**${fixture.matchNumber}**\n` +
            `**${fixture.homeTeam} vs ${fixture.awayTeam}**\n\n` +
            `Previous Score: **${homeGoals}-${awayGoals}**\n` +
            `Status Reset To: **Pending**`
        )
        .addFields(
            {
                name: 'Reverted',
                value:
                    `${teamStatsReversed ? '✅' : '➖'} Team standings\n` +
                    `${playerReverseResult.reversedPlayers > 0 ? '✅' : '➖'} Tournament player stats\n` +
                    `${playerReverseResult.reversedProfiles > 0 ? '✅' : '➖'} All-time stats`,
                inline: false
            },
            {
                name: 'Live Refresh',
                value:
                    '✅ Live standings refreshed\n' +
                    '✅ Live topstats refreshed\n' +
                    '✅ Master schedule refreshed\n' +
                    '✅ Live bracket refreshed',
                inline: false
            }
        )
        .setTimestamp();

    return reply({
        embeds: [embed]
    });
}

/* ====================================================
   TEAM LOOKUP
==================================================== */

async function findTournamentTeamEntry({
    fixture,
    tournament,
    side
}) {
    const tournamentTeamId =
        side === 'home'
            ? fixture.homeTournamentTeamId
            : fixture.awayTournamentTeamId;

    const teamId =
        side === 'home'
            ? fixture.homeTeamId
            : fixture.awayTeamId;

    const teamName =
        side === 'home'
            ? fixture.homeTeam
            : fixture.awayTeam;

    if (tournamentTeamId) {
        const byTournamentTeamId = await TournamentTeam.findOne({
            _id: tournamentTeamId,
            guildId: fixture.guildId,
            tournamentId: tournament._id
        });

        if (byTournamentTeamId) return byTournamentTeamId;
    }

    if (teamId) {
        const byTeamId = await TournamentTeam.findOne({
            guildId: fixture.guildId,
            tournamentId: tournament._id,
            teamId
        });

        if (byTeamId) return byTeamId;
    }

    return TournamentTeam.findOne({
        guildId: fixture.guildId,
        tournamentId: tournament._id,
        teamNameSnapshot: teamName
    });
}

/* ====================================================
   STATS REVERSAL
==================================================== */

function reverseTeamStats({
    stats,
    goalsFor,
    goalsAgainst,
    tournament
}) {
    stats.played = Math.max(0, (stats.played || 0) - 1);

    stats.gf = Math.max(0, (stats.gf || 0) - goalsFor);
    stats.ga = Math.max(0, (stats.ga || 0) - goalsAgainst);

    if (goalsFor > goalsAgainst) {
        stats.wins = Math.max(0, (stats.wins || 0) - 1);
        stats.points = Math.max(
            0,
            (stats.points || 0) - (tournament.pointsWin ?? 3)
        );
    } else if (goalsFor < goalsAgainst) {
        stats.losses = Math.max(0, (stats.losses || 0) - 1);
        stats.points = Math.max(
            0,
            (stats.points || 0) - (tournament.pointsLoss ?? 0)
        );
    } else {
        stats.draws = Math.max(0, (stats.draws || 0) - 1);
        stats.points = Math.max(
            0,
            (stats.points || 0) - (tournament.pointsDraw ?? 1)
        );
    }
}

async function reverseFixturePlayerStats({
    guildId,
    tournament,
    fixture
}) {
    const statEntries = Array.isArray(fixture.playerStats)
        ? fixture.playerStats
        : [];

    let reversedPlayers = 0;
    let reversedProfiles = 0;

    for (const entry of statEntries) {
        const player = entry.playerId
            ? await Player.findById(entry.playerId)
            : null;

        const playerId = player?._id || entry.playerId;

        if (!playerId) continue;

        const tournamentPlayer = await TournamentPlayer.findOne({
            guildId,
            tournamentId: tournament._id,
            playerId
        });

        if (tournamentPlayer?.stats) {
            reversePlayerStats(tournamentPlayer.stats, entry);
            await tournamentPlayer.save();
            reversedPlayers++;
        }

        const discordID = player?.discordID || entry.discordID;

        if (discordID) {
            const profile = await UserProfile.findOne({
                guildId,
                discordID
            });

            if (profile?.allTimeStats) {
                reversePlayerStats(profile.allTimeStats, entry);
                await profile.save();
                reversedProfiles++;
            }
        }
    }

    return {
        reversedPlayers,
        reversedProfiles
    };
}

function reversePlayerStats(stats, entry) {
    stats.played = Math.max(
        0,
        (stats.played || 0) - safeNumber(entry.played || 1)
    );

    stats.goals = Math.max(
        0,
        (stats.goals || 0) - safeNumber(entry.goals)
    );

    stats.assists = Math.max(
        0,
        (stats.assists || 0) - safeNumber(entry.assists)
    );

    stats.saves = Math.max(
        0,
        (stats.saves || 0) - safeNumber(entry.saves)
    );

    stats.tackles = Math.max(
        0,
        (stats.tackles || 0) - safeNumber(entry.tackles)
    );

    stats.interceptions = Math.max(
        0,
        (stats.interceptions || 0) - safeNumber(entry.interceptions)
    );

    stats.mvps = Math.max(
        0,
        (stats.mvps || 0) - safeNumber(entry.mvps)
    );

    stats.yc = Math.max(
        0,
        (stats.yc || 0) - safeNumber(entry.yc)
    );

    stats.rc = Math.max(
        0,
        (stats.rc || 0) - safeNumber(entry.rc)
    );
}

/* ====================================================
   HELPERS
==================================================== */

function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}
