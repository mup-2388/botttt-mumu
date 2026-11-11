/**
 * resetstats.js
 *
 * Reset tournament player stats and/or team standings.
 * Three modes: players only, teams only, or all.
 * Requires explicit confirmation to prevent accidents.
 *
 * Usage:  .resetstats <tournamentKey> confirm [--players|--teams|--all]
 * Slash:  /resetstats key:<key> confirm:true [mode]
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const {
    TournamentSettings,
    TournamentPlayer,
    TournamentTeam
} = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');

module.exports = {
    name: 'resetstats',
    description: 'Reset tournament player stats and/or team standings.',
    usage: '.resetstats [tournamentKey] confirm [--players|--teams|--all]',
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('resetstats')
        .setDescription('Reset stats for a specific tournament')
        .addBooleanOption(opt =>
            opt.setName('confirm')
                .setDescription('Required safety confirmation')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('mode')
                .setDescription('What to reset')
                .setRequired(false)
                .addChoices(
                    { name: 'Players Only', value: 'players' },
                    { name: 'Teams Only', value: 'teams' },
                    { name: 'All Tournament Stats', value: 'all' }
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
                return message.reply('🚫 **Access Denied.** This is a high-level admin command.');
            }

            const parsed = await parsePrefixArgs(message.guild.id, args);
            if (!parsed.ok) return message.reply(parsed.error);

            const waitMsg = await message.reply('⏳ **Resetting tournament stats...** Please wait.');

            const result = await runReset({
                guildId: message.guild.id,
                tournamentKey: parsed.tournamentKey,
                mode: parsed.mode
            });

            return waitMsg.edit({
                content: null,
                embeds: [buildSuccessEmbed({ ...result, mode: parsed.mode, actorTag: message.author.tag })]
            });
        } catch (error) {
            console.error('[resetstats] prefix error:', error);

            if (String(error?.message || '').startsWith('❌')) {
                return message.reply(error.message);
            }

            return message.reply('❌ **Database Error:** Failed to reset statistics.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 **Access Denied.** This is a high-level admin command.',
                    ephemeral: true
                });
            }

            const confirm = interaction.options.getBoolean('confirm');

            if (!confirm) {
                return interaction.reply({
                    content: '⚠️ You must set `confirm` to `true` to run this reset.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            const result = await runReset({
                guildId: interaction.guild.id,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                mode: interaction.options.getString('mode') || 'all'
            });

            return interaction.editReply({
                embeds: [buildSuccessEmbed({
                    ...result,
                    mode: interaction.options.getString('mode') || 'all',
                    actorTag: interaction.user.tag
                })]
            });
        } catch (error) {
            console.error('[resetstats] slash error:', error);

            const friendly = String(error?.message || '').startsWith('❌')
                ? error.message
                : '❌ **Database Error:** Failed to reset statistics.';

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(friendly);
            }

            return interaction.reply({ content: friendly, ephemeral: true });
        }
    }
};

/* ====================================================
   PREFIX ARG PARSER
==================================================== */

async function parsePrefixArgs(guildId, args) {
    if (!args.length) {
        return {
            ok: false,
            error:
                '❌ Usage: `.resetstats [tournamentKey] confirm [--players|--teams|--all]`\n' +
                'Example: `.resetstats league-s1 confirm --all`\n' +
                'Without a key the server default tournament is used.'
        };
    }

    const parsedKey = await extractTournamentFromArgs(guildId, args);

    if (parsedKey.explicit && parsedKey.error) {
        return { ok: false, error: parsedKey.error };
    }

    const confirm = parsedKey.rest.some(a => String(a).toLowerCase() === 'confirm');
    const rest = parsedKey.rest.filter(a => String(a).toLowerCase() !== 'confirm');

    let mode = 'all';
    for (const arg of rest) {
        const value = String(arg).replace(/^--/, '').toLowerCase();
        if (['players', 'teams', 'all'].includes(value)) mode = value;
    }

    if (!confirm) {
        return {
            ok: false,
            error:
                '⚠️ You must add `confirm` to run this reset.\n\n' +
                'Example: `.resetstats league-s1 confirm --all`\n' +
                'Default tournament: `.resetstats confirm --all`'
        };
    }

    return {
        ok: true,
        tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
        mode
    };
}

/* ====================================================
   CORE LOGIC
==================================================== */

/** Reset player stats, team standings, or both for a tournament. */
async function runReset({ guildId, tournamentKey, mode }) {
    const resolved = await resolveTournament(guildId, tournamentKey);

    if (!resolved.tournament) {
        throw new Error(resolved.error || `❌ Tournament \`${tournamentKey}\` not found.`);
    }

    const tournament = resolved.tournament;

    let playerResult = { matchedCount: 0, modifiedCount: 0 };
    let teamResult = { matchedCount: 0, modifiedCount: 0 };

    /* ── Reset player stats ── */
    if (mode === 'players' || mode === 'all') {
        playerResult = await TournamentPlayer.updateMany(
            { guildId, tournamentId: tournament._id },
            {
                $set: {
                    'stats.played': 0,
                    'stats.goals': 0,
                    'stats.assists': 0,
                    'stats.saves': 0,
                    'stats.tackles': 0,
                    'stats.interceptions': 0,
                    'stats.yc': 0,
                    'stats.rc': 0,
                    'stats.mvps': 0
                }
            }
        );
    }

    /* ── Reset team standings ── */
    if (mode === 'teams' || mode === 'all') {
        teamResult = await TournamentTeam.updateMany(
            { guildId, tournamentId: tournament._id },
            {
                $set: {
                    'stats.played': 0,
                    'stats.wins': 0,
                    'stats.draws': 0,
                    'stats.losses': 0,
                    'stats.gf': 0,
                    'stats.ga': 0,
                    'stats.points': 0
                }
            }
        );
    }

    return {
        tournament,
        matchedPlayers: playerResult.matchedCount ?? 0,
        modifiedPlayers: playerResult.modifiedCount ?? 0,
        matchedTeams: teamResult.matchedCount ?? 0,
        modifiedTeams: teamResult.modifiedCount ?? 0
    };
}

/* ====================================================
   EMBED BUILDER
==================================================== */

function buildSuccessEmbed({ tournament, matchedPlayers, modifiedPlayers, matchedTeams, modifiedTeams, mode, actorTag }) {
    return new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('🧹 TOURNAMENT STATS RESET')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Mode: **${mode}**`
        )
        .addFields(
            {
                name: 'Player Stats Reset',
                value:
                    mode === 'players' || mode === 'all'
                        ? `Matched: **${matchedPlayers}**\nModified: **${modifiedPlayers}**`
                        : 'Skipped',
                inline: true
            },
            {
                name: 'Team Standings Reset',
                value:
                    mode === 'teams' || mode === 'all'
                        ? `Matched: **${matchedTeams}**\nModified: **${modifiedTeams}**`
                        : 'Skipped',
                inline: true
            },
            {
                name: 'Unaffected',
                value:
                    'Global teams, global players, all-time stats, trophies, awards, fixtures, logos, colors, stadiums, and tournament settings were not deleted.',
                inline: false
            }
        )
        .setFooter({ text: `Action performed by ${actorTag}` })
        .setTimestamp();
}
