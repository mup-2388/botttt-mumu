/**
 * removeteamfromtournament.js
 *
 * Remove a team from a specific tournament. Deactivates the team and its
 * players, and applies 3-0 walkover wins to all remaining opponents.
 *
 * Usage:  .removeteamfromtournament <key> <team name>
 * Slash:  /removeteamfromtournament key:<key> team:<team>
 *
 * Aliases: removefromtour, rtt, removetourteam
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const {
    Team,
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer,
    Fixture
} = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { optionalStep } = require('../../utils/optionalStep');
const { escapeRegex } = require('../../utils/stringHelpers');

module.exports = {
    name: 'removeteamfromtournament',
    description: 'Remove a team from a tournament and give opponents 3-0 walkover wins.',
    usage: '.removeteamfromtournament [key] <team name>',
    aliases: ['removefromtour', 'rtt', 'removetourteam'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('removeteamfromtournament')
        .setDescription('Remove a team from a specific tournament')
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team name')
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

            if (!parsedKey.rest.length) {
                return message.reply(
                    '❓ Usage: `.removeteamfromtournament [key] <team name>`\n' +
                    'Without a key the server default tournament is used.'
                );
            }

            return await runRemove({
                guild: message.guild,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                teamName: parsedKey.rest.join(' '),
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[removeteamfromtournament] prefix error:', error);
            return message.reply(
                '❌ Failed to remove team from tournament.\n`' + String(error?.message || error).slice(0, 200) + '`'
            );
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
                teamName: interaction.options.getString('team'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[removeteamfromtournament] slash error:', error);

            const reason = String(error?.message || error).slice(0, 200);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(
                    '❌ Failed to remove team from tournament.\n`' + reason + '`'
                );
            }

            return interaction.reply({
                content: '❌ Failed to remove team from tournament.\n`' + reason + '`',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Withdraw a team from a tournament:
 * 1. Deactivate TournamentTeam + TournamentPlayer entries
 * 2. Apply 3-0 walkovers to all unplayed fixtures
 * 3. Update opponent standings
 */
async function runRemove({ guild, tournamentKey, teamName, reply }) {
    /* ── Find tournament ── */
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    /* ── Find team ── */
    const team = await Team.findOne({
        guildId: guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(teamName)}$`, 'i') }
    });

    if (!team) {
        return reply({ content: `❌ Team **${teamName}** not found.` });
    }

    /* ── Find tournament entry ── */
    const entry = await TournamentTeam.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        teamId: team._id,
        isActive: { $ne: false }
    });

    if (!entry) {
        const existing = await TournamentTeam.findOne({
            guildId: guild.id,
            tournamentId: tournament._id,
            teamId: team._id
        })
            .lean()
            .catch(() => null);

        if (existing) {
            return reply({
                content:
                    `ℹ️ **${team.name}** is already out of **${tournament.name}** — nothing changed.`
            });
        }

        return reply({
            content: `ℹ️ **${team.name}** is not part of **${tournament.name}** — nothing to remove.`
        });
    }

    /* ── Deactivate tournament team ── */
    entry.isActive = false;
    await entry.save();

    /* ── Deactivate tournament players ── */
    const playerUpdate = await TournamentPlayer.updateMany(
        {
            guildId: guild.id,
            tournamentId: tournament._id,
            teamId: team._id
        },
        { $set: { isActive: false } }
    );

    /* ── Apply walkovers to remaining fixtures (optional follow-up) ──
       The team is already withdrawn above, so a failure here must not turn
       the command into "❌ Failed to remove team from tournament". */
    const walkoverResult = await optionalStep(
        'removeteamfromtournament: walkovers',
        () =>
            applyWalkovers({
                guildId: guild.id,
                tournament,
                withdrawnTeam: team
            }),
        { updatedFixtures: 0, opponentWins: 0, withdrawnLosses: 0, failed: true }
    );

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🚫 TEAM WITHDRAWN FROM TOURNAMENT')
        .setDescription(
            `**${team.name}** has been removed from **${tournament.name}**.\n\n` +
            `${tournament.emoji || '🏆'} Key: \`${tournament.tournamentKey}\`\n` +
            `Players disabled: **${playerUpdate.modifiedCount || 0}**`
        )
        .addFields({
            name: 'Walkovers Applied',
            value: walkoverResult.failed
                ? '⚠️ Walkover step failed — fixtures were left unchanged (see the bot console).'
                : `Fixtures reported 3-0: **${walkoverResult.updatedFixtures}**\n` +
                  `Opponent standing wins: **${walkoverResult.opponentWins}**\n` +
                  `Withdrawn team losses: **${walkoverResult.withdrawnLosses}**`,
            inline: false
        })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   WALKOVER ENGINE
==================================================== */

/** Apply 3-0 walkover wins to all unplayed fixtures of the withdrawn team. */
async function applyWalkovers({ guildId, tournament, withdrawnTeam }) {
    const fixtures = await Fixture.find({
        guildId,
        tournamentId: tournament._id,
        status: { $ne: 'Played' },
        $or: [
            { homeTeamId: withdrawnTeam._id },
            { awayTeamId: withdrawnTeam._id },
            { homeTeam: withdrawnTeam.name },
            { awayTeam: withdrawnTeam.name }
        ]
    });

    let updatedFixtures = 0;
    let opponentWins = 0;
    let withdrawnLosses = 0;

    for (const fixture of fixtures) {
        const withdrawnIsHome =
            String(fixture.homeTeamId || '') === String(withdrawnTeam._id) ||
            fixture.homeTeam === withdrawnTeam.name;

        const withdrawnIsAway =
            String(fixture.awayTeamId || '') === String(withdrawnTeam._id) ||
            fixture.awayTeam === withdrawnTeam.name;

        if (!withdrawnIsHome && !withdrawnIsAway) continue;

        const opponentTeamId = withdrawnIsHome ? fixture.awayTeamId : fixture.homeTeamId;
        const withdrawnTeamId = withdrawnIsHome ? fixture.homeTeamId : fixture.awayTeamId;

        const opponentEntry = await TournamentTeam.findOne({
            guildId,
            tournamentId: tournament._id,
            teamId: opponentTeamId
        });

        const withdrawnEntry = await TournamentTeam.findOne({
            guildId,
            tournamentId: tournament._id,
            teamId: withdrawnTeamId
        });

        /* ── Update fixture result ── */
        fixture.status = 'Played';
        fixture.result = {
            ...(fixture.result || {}),
            home: withdrawnIsHome ? 0 : 3,
            away: withdrawnIsAway ? 0 : 3,
            extraTimeHome: null,
            extraTimeAway: null,
            penaltiesHome: null,
            penaltiesAway: null,
            winner: withdrawnIsHome ? fixture.awayTeam : fixture.homeTeam
        };
        fixture.notes = `Walkover: ${withdrawnTeam.name} withdrew from ${tournament.name}.`;
        fixture.reportedAt = new Date();

        await fixture.save();
        updatedFixtures++;

        /* ── Update standings ── */
        if (opponentEntry) {
            addWin(opponentEntry.stats, 3, 0, tournament);
            await opponentEntry.save();
            opponentWins++;
        }

        if (withdrawnEntry) {
            addLoss(withdrawnEntry.stats, 0, 3, tournament);
            await withdrawnEntry.save();
            withdrawnLosses++;
        }
    }

    return { updatedFixtures, opponentWins, withdrawnLosses };
}

/* ====================================================
   STANDING HELPERS
==================================================== */

function addWin(stats, gf, ga, tournament) {
    stats.played = (stats.played || 0) + 1;
    stats.wins = (stats.wins || 0) + 1;
    stats.gf = (stats.gf || 0) + gf;
    stats.ga = (stats.ga || 0) + ga;
    stats.points = (stats.points || 0) + (tournament.pointsWin ?? 3);
}

function addLoss(stats, gf, ga, tournament) {
    stats.played = (stats.played || 0) + 1;
    stats.losses = (stats.losses || 0) + 1;
    stats.gf = (stats.gf || 0) + gf;
    stats.ga = (stats.ga || 0) + ga;
    stats.points = (stats.points || 0) + (tournament.pointsLoss ?? 0);
}
