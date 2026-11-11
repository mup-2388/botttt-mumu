/**
 * removestats.js
 *
 * Remove raw match stats from a tournament. Parses CSV-like stat lines
 * (discordID, goals, assists, interceptions, tackles, saves) and subtracts
 * from TournamentPlayer + UserProfile allTimeStats.
 *
 * Prefix supports: direct text, replied message, or code block extraction.
 * Slash requires raw stats text in the option.
 *
 * Usage:  .removestats [key] <raw stats or reply>
 * Slash:  /removestats key:<key> stats:<raw text>
 *
 * Aliases: rs, undostats
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const {
    Player,
    TournamentSettings,
    TournamentPlayer,
    UserProfile
} = require('../../models/Tournament');

const { updateLiveTopStats } = require('../../utils/updateTopStats');
const { getDefaultTournament, getTournamentByKey } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');

module.exports = {
    name: 'removestats',
    description: 'Remove raw match stats from a tournament.',
    usage: '.removestats [key] [raw stats]',
    aliases: ['rs', 'undostats'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('removestats')
        .setDescription('Remove raw stats from tournament players')
        .addStringOption(opt =>
            opt.setName('stats')
                .setDescription('Raw stats text (discordID, goals, assists, interceptions, tackles, saves)')
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
                return message.reply('🚫 Unauthorized.');
            }

            const possibleKey = args[0]?.toLowerCase();

            const tournament = await resolveTournament(message.guild.id, possibleKey);

            if (!tournament) {
                return message.reply(
                    '❌ Tournament not found. Set a default tournament or use `.rs <tournamentKey>`.'
                );
            }

            const firstArgIsKey = Boolean(possibleKey && possibleKey === tournament.tournamentKey);

            let rawText = await getRawStatsFromMessage(message, args, firstArgIsKey);

            // Fallback: try replied message
            if (!rawText && message.reference?.messageId) {
                const replied = await message.channel.messages
                    .fetch(message.reference.messageId)
                    .catch(() => null);

                if (replied?.content) rawText = extractRawStatsBlock(replied.content);
            }

            if (!rawText) {
                return message.reply('❌ No raw stats text found.');
            }

            const waitMsg = await message.reply('⏳ Removing match stats...');

            return await runRemoveStats({
                guild: message.guild,
                tournament,
                rawText,
                organizerUser: message.author,
                respondFinal: payload => waitMsg.edit(payload)
            });
        } catch (error) {
            console.error('[removestats] prefix error:', error);
            return message.reply('❌ Failed to remove stats.');
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

            const tournamentKey = interaction.options.getString('key')?.toLowerCase() || null;
            const rawText = interaction.options.getString('stats');

            if (!rawText) {
                return interaction.editReply('❌ Raw stats text is required.');
            }

            const tournament = await resolveTournament(interaction.guild.id, tournamentKey);

            if (!tournament) {
                return interaction.editReply(
                    '❌ Tournament not found. Set a default tournament or pass a key.'
                );
            }

            return await runRemoveStats({
                guild: interaction.guild,
                tournament,
                rawText,
                organizerUser: interaction.user,
                respondFinal: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[removestats] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to remove stats.');
            }

            return interaction.reply({ content: '❌ Failed to remove stats.', ephemeral: true });
        }
    }
};

/* ====================================================
   TOURNAMENT RESOLUTION
==================================================== */

async function resolveTournament(guildId, key) {
    if (key) {
        const found = await getTournamentByKey(guildId, key, { includeCompleted: true });
        if (found) return found;
    }

    return getDefaultTournament(guildId, { includeCompleted: true });
}

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Parse raw stat lines and subtract from TournamentPlayer + UserProfile.
 * DMs the detailed report to the organizer, then confirms in channel.
 */
async function runRemoveStats({ guild, tournament, rawText, organizerUser, respondFinal }) {
    const lines = rawText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    let updatedPlayers = 0;
    let skippedPlayers = 0;

    const removedLines = [];
    const skippedLines = [];

    const totals = {
        played: 0,
        goals: 0,
        assists: 0,
        interceptions: 0,
        tackles: 0,
        saves: 0
    };

    for (const line of lines) {
        const parsed = parseRawStatLine(line);

        if (!parsed.ok) {
            skippedPlayers++;
            skippedLines.push(`Invalid line: ${line}`);
            continue;
        }

        const { discordID, goals, assists, interceptions, tackles, saves } = parsed.data;

        const player = await Player.findOne({
            guildId: guild.id,
            discordID
        });

        if (!player) {
            skippedPlayers++;
            skippedLines.push(`Player not found: ${discordID}`);
            continue;
        }

        const tournamentPlayer = await TournamentPlayer.findOne({
            guildId: guild.id,
            tournamentId: tournament._id,
            playerId: player._id,
            isActive: true
        });

        if (!tournamentPlayer) {
            skippedPlayers++;
            skippedLines.push(`${player.name} is not active in ${tournament.tournamentKey}`);
            continue;
        }

        const removed = subtractStatsObject(
            tournamentPlayer.stats,
            { goals, assists, interceptions, tackles, saves },
            true
        );

        await tournamentPlayer.save();

        await subtractFromUserProfile({
            guildId: guild.id,
            discordID,
            statsToRemove: { goals, assists, interceptions, tackles, saves }
        });

        updatedPlayers++;

        totals.played += removed.played;
        totals.goals += removed.goals;
        totals.assists += removed.assists;
        totals.interceptions += removed.interceptions;
        totals.tackles += removed.tackles;
        totals.saves += removed.saves;

        removedLines.push(`${player.name}: ${buildRemovedText(removed)}`);
    }

    /* ── Update live stats ── */
    await updateLiveTopStats(
        global.client || guild.client,
        guild.id,
        tournament.tournamentKey
    ).catch(console.error);

    if (global.io) {
        global.io.emit('update');
    }

    /* ── DM detailed report to organizer ── */
    const embed = new EmbedBuilder()
        .setColor(updatedPlayers > 0 ? 0xE67E22 : 0xE74C3C)
        .setTitle('➖ MATCH STATS REMOVED')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Updated Players: **${updatedPlayers}**\n` +
            `Skipped: **${skippedPlayers}**`
        )
        .addFields(
            {
                name: 'Totals Removed',
                value:
                    `⚽ Goals: **${totals.goals}**\n` +
                    `🎯 Assists: **${totals.assists}**\n` +
                    `🧠 Interceptions: **${totals.interceptions}**\n` +
                    `⚔️ Tackles: **${totals.tackles}**\n` +
                    `🧤 Saves: **${totals.saves}**\n` +
                    `🏟️ Played: **${totals.played}**`,
                inline: false
            },
            {
                name: 'Updated Players',
                value: removedLines.length
                    ? removedLines.slice(0, 35).join('\n')
                    : 'No stats removed.',
                inline: false
            },
            {
                name: 'Skipped',
                value: skippedLines.length
                    ? skippedLines.slice(0, 20).join('\n')
                    : 'None',
                inline: false
            }
        )
        .setFooter({ text: `${tournament.name} • ${tournament.tournamentKey}` })
        .setTimestamp();

    await organizerUser
        .send({ embeds: [embed] })
        .catch(() => null);

    return respondFinal({ content: '✅ Stats Removed', embeds: [] });
}

/* ====================================================
   RAW TEXT EXTRACTION
==================================================== */

/** Get raw stats text from the message content or a replied message. */
async function getRawStatsFromMessage(message, args, firstArgIsKey) {
    const replied = message.reference?.messageId
        ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null)
        : null;

    if (replied?.content) {
        return extractRawStatsBlock(replied.content);
    }

    const contentArgs = firstArgIsKey ? args.slice(1) : args;

    if (!contentArgs.length) return '';

    return contentArgs.join(' ');
}

/** Extract stats block from code block or lines starting with a Discord ID. */
function extractRawStatsBlock(content) {
    const codeBlockMatch = content.match(/```(?:\w+)?\n?([\s\S]*?)```/);

    if (codeBlockMatch) {
        return codeBlockMatch[1].trim();
    }

    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^\d{17,20}\s*,/.test(line))
        .join('\n');
}

/* ====================================================
   STAT SUBTRACTION
==================================================== */

/** Subtract stats from a UserProfile's allTimeStats. */
async function subtractFromUserProfile({ guildId, discordID, statsToRemove }) {
    const profile = await UserProfile.findOne({ guildId, discordID });

    if (!profile) return;

    subtractStatsObject(profile.allTimeStats, statsToRemove, true);

    await profile.save();
}

/**
 * Subtract stats from a stats object. Clamps to 0 (no negatives).
 * Returns the actual amounts removed.
 */
function subtractStatsObject(targetStats, statsToRemove, removePlayed) {
    if (!targetStats) return emptyRemoved();

    const removed = emptyRemoved();

    if (removePlayed) {
        removed.played = Math.min(targetStats.played || 0, 1);
        targetStats.played = Math.max(0, (targetStats.played || 0) - 1);
    }

    for (const key of ['goals', 'assists', 'tackles', 'interceptions', 'saves']) {
        const amount = statsToRemove[key] || 0;
        const current = targetStats[key] || 0;

        const removeAmount = Math.min(current, amount);

        targetStats[key] = Math.max(0, current - removeAmount);
        removed[key] = removeAmount;
    }

    return removed;
}

function emptyRemoved() {
    return { played: 0, goals: 0, assists: 0, tackles: 0, interceptions: 0, saves: 0 };
}

/* ====================================================
   FORMATTING HELPERS
==================================================== */

/** Parse a CSV stat line: discordID, goals, assists, interceptions, tackles, saves. */
function parseRawStatLine(line) {
    const parts = line.split(',').map(part => part.trim());

    if (parts.length < 6) {
        return { ok: false };
    }

    const [rawId, rawGoals, rawAssists, rawInterceptions, rawTackles, rawSaves] = parts;

    const discordID = rawId.replace(/[<@!>]/g, '');

    if (!/^\d{17,20}$/.test(discordID)) {
        return { ok: false };
    }

    return {
        ok: true,
        data: {
            discordID,
            goals: safeInt(rawGoals),
            assists: safeInt(rawAssists),
            interceptions: safeInt(rawInterceptions),
            tackles: safeInt(rawTackles),
            saves: safeInt(rawSaves)
        }
    };
}

function safeInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function buildRemovedText(stats) {
    const parts = [];

    if (stats.played) parts.push('-1 played');
    if (stats.goals) parts.push(`-${stats.goals} goals`);
    if (stats.assists) parts.push(`-${stats.assists} assists`);
    if (stats.tackles) parts.push(`-${stats.tackles} tackles`);
    if (stats.interceptions) parts.push(`-${stats.interceptions} interceptions`);
    if (stats.saves) parts.push(`-${stats.saves} saves`);

    return parts.length ? parts.join(', ') : 'nothing removed';
}
