/**
 * awardtrophy.js
 *
 * Award a tournament trophy (Winner/Runner Up) to a team and all its players.
 * Writes trophy entries to Team, TournamentTeam, and each player's UserProfile.
 *
 * Deduplication: pulls any existing trophy for the same tournament + team
 * before pushing the new one, so re-awarding is safe.
 *
 * Usage: .awardtrophy <tournamentKey> <team name> <champion|runner_up>
 * Slash: /awardtrophy key:<key> team:<name> type:<type>
 *
 * Aliases: give-trophy, givetrophy, trophyaward
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Team,
    Player,
    TournamentTeam,
    TournamentPlayer,
    UserProfile
} = require('../../models/Tournament');

const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { escapeRegex } = require('../../utils/stringHelpers');

/** Trophy types with display metadata */
const TROPHY_TYPES = {
    champion: { label: 'Winner', defaultEmoji: '<:midfield_league:1507806211918266368>' },
    runner_up: { label: 'Runner Up', defaultEmoji: '🥈' }
};

module.exports = {
    name: 'awardtrophy',
    description: 'Award a tournament trophy to a team and its players.',
    usage: '.awardtrophy [tournamentKey] <team name> <champion|runner_up>',
    aliases: ['give-trophy', 'givetrophy', 'trophyaward'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('awardtrophy')
        .setDescription('Award a trophy to a tournament team')
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team name')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('type')
                .setDescription('Trophy type')
                .setRequired(true)
                .addChoices(
                    { name: 'Winner', value: 'champion' },
                    { name: 'Runner Up', value: 'runner_up' }
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
                return message.reply('🚫 Unauthorized.');
            }

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args);
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            if (parsedKey.rest.length < 2) {
                return message.reply(
                    '❓ Usage: `.awardtrophy [tournamentKey] <team name> <champion|runner_up>`\n' +
                    'Example: `.awardtrophy league-s1 Simgas champion`\n' +
                    'Without a key the server default tournament is used.'
                );
            }

            const type = parsedKey.rest[parsedKey.rest.length - 1].toLowerCase();
            const teamName = parsedKey.rest.slice(0, -1).join(' ').trim();

            return await runAwardTrophy({
                guild: message.guild,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                teamName,
                type,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[awardtrophy] prefix error:', error);
            return message.reply('❌ Failed to award trophy.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runAwardTrophy({
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                teamName: interaction.options.getString('team'),
                type: interaction.options.getString('type'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[awardtrophy] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to award trophy.');
            }

            return interaction.reply({ content: '❌ Failed to award trophy.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Award a trophy to a team and all its tournament players.
 *
 * Dedup strategy: $pull existing trophies for this tournament + team first,
 * then $push the clean one. This makes re-awarding idempotent.
 */
async function runAwardTrophy({ guild, tournamentKey, teamName, type, reply }) {
    const trophyMeta = TROPHY_TYPES[type];

    if (!trophyMeta) {
        return reply({ content: '❌ Invalid trophy type. Use `champion` or `runner_up`.' });
    }

    // ── Find tournament ──
    // Awards are usually handed out after the tournament ended → include completed
    const resolved = await resolveTournament(guild.id, tournamentKey, { includeCompleted: true });

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    // ── Find team (case-insensitive) ──
    const team = await Team.findOne({
        guildId: guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(teamName)}$`, 'i') }
    });

    if (!team) {
        return reply({ content: `❌ Team **${teamName}** not found.` });
    }

    // ── Find tournament team entry ──
    const tournamentTeam = await TournamentTeam.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        $or: [
            { teamId: team._id },
            { teamNameSnapshot: team.name }
        ]
    });

    if (!tournamentTeam) {
        return reply({ content: `❌ **${team.name}** is not linked to \`${tournament.tournamentKey}\`.` });
    }

    // ── Find all tournament players ──
    const players = await TournamentPlayer.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        $or: [
            { teamId: team._id },
            { tournamentTeamId: tournamentTeam._id },
            { teamNameSnapshot: team.name }
        ]
    }).populate('playerId');

    if (!players.length) {
        return reply({
            content:
                `❌ No tournament players found for **${team.name}** in \`${tournament.tournamentKey}\`.\n` +
                'This means TournamentPlayer entries are not linked to this team.'
        });
    }

    // ── Build trophy payload ──
    const emoji = tournament.emoji || trophyMeta.defaultEmoji;

    const trophyPayload = {
        tournamentId: String(tournament._id),
        tournamentKey: tournament.tournamentKey,
        tournamentName: tournament.name,

        teamId: String(team._id),
        tournamentTeamId: String(tournamentTeam._id),
        teamName: team.name,

        type,
        name: trophyMeta.label,
        label: trophyMeta.label,
        title: `${tournament.name} ${trophyMeta.label}`,
        emoji,

        awardedAt: new Date()
    };

    // ── Award each player ──
    let awardedPlayers = 0;
    const skipped = [];

    for (const tp of players) {
        const globalPlayer =
            tp.playerId && typeof tp.playerId === 'object'
                ? tp.playerId
                : tp.playerId
                    ? await Player.findById(tp.playerId).catch(() => null)
                    : null;

        const discordID = tp.discordID || globalPlayer?.discordID || '';
        const displayName = tp.playerNameSnapshot || tp.name || globalPlayer?.name || 'Unknown Player';

        if (!discordID) {
            skipped.push(displayName);
            continue;
        }

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
                    awards: []
                },
                $set: { displayName },
                $pull: {
                    trophies: {
                        tournamentKey: tournament.tournamentKey,
                        teamName: team.name
                    }
                }
            },
            { upsert: true }
        );

        await UserProfile.updateOne(
            { guildId: guild.id, discordID },
            { $push: { trophies: trophyPayload } }
        );

        awardedPlayers++;
    }

    // ── Award to Team document (dedup + push) ──
    await Team.updateOne(
        { _id: team._id },
        { $pull: { trophies: { tournamentKey: tournament.tournamentKey } } }
    );

    await Team.updateOne(
        { _id: team._id },
        { $push: { trophies: trophyPayload } }
    );

    // ── Award to TournamentTeam document (dedup + push) ──
    await TournamentTeam.updateOne(
        { _id: tournamentTeam._id },
        { $pull: { trophies: { tournamentKey: tournament.tournamentKey } } }
    );

    await TournamentTeam.updateOne(
        { _id: tournamentTeam._id },
        { $push: { trophies: trophyPayload } }
    );

    // ── Response ──
    const embed = new EmbedBuilder()
        .setColor(type === 'champion' ? 0xF1C40F : 0xC0C0C0)
        .setTitle(`${emoji} TROPHY AWARDED`)
        .setDescription(
            `${emoji} **${tournament.name} ${trophyMeta.label}**\n\n` +
            `Team: **${team.name}**\n` +
            `Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Players found: **${players.length}**\n` +
            `Players awarded: **${awardedPlayers}**`
        )
        .setTimestamp();

    if (skipped.length) {
        embed.addFields({
            name: 'Skipped Players',
            value: skipped.slice(0, 20).join('\n'),
            inline: false
        });
    }

    return reply({ embeds: [embed] });
}
