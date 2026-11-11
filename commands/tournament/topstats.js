/**
 * topstats.js
 *
 * View tournament + event leaderboards for player stats.
 * Paginated with category and competition dropdown selectors.
 * Supports both Tournaments and Freestyle Events (UCL etc)
 *
 * Usage:  .topstats [category]
 * Slash:  /topstats category:<value>
 * Aliases: top-stats, leaderstats, statleaders, lb
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
} = require('discord.js');

const {
    TournamentPlayer,
    EventPlayer
} = require('../../models/Tournament');

const {
    getDefaultTournament,
    getSelectableTournaments,
    getTournamentByKey
} = require('../../utils/getTournament');

const {
    getSelectableEvents,
    getEventByKey,
    getEventByChannel
} = require('../../utils/getEvent');

const PAGE_SIZE = 10;

const CATEGORIES = {
    goals: { label: 'GOALS', emoji: '⚽' },
    assists: { label: 'ASSISTS', emoji: '🎯' },
    ga: { label: 'G+A', emoji: '🔥' },
    saves: { label: 'SAVES', emoji: '🧤' },
    tackles: { label: 'TACKLES', emoji: '⚔️' },
    interceptions: { label: 'INTERCEPTIONS', emoji: '🛡️' },
    mvps: { label: 'MVPs', emoji: '👑' }
};

module.exports = {
    name: 'topstats',
    description: 'View tournament + event leaderboards for player stats.',
    usage: '.topstats [category]',
    aliases: ['top-stats', 'leaderstats', 'statleaders', 'lb'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('topstats')
        .setDescription('View tournament + event leaderboards')
        .addStringOption(opt =>
            opt.setName('category')
                .setDescription('Stat category')
                .setRequired(false)
                .addChoices(
                    { name: 'Goals', value: 'goals' },
                    { name: 'Assists', value: 'assists' },
                    { name: 'G+A', value: 'ga' },
                    { name: 'Saves', value: 'saves' },
                    { name: 'Tackles', value: 'tackles' },
                    { name: 'Interceptions', value: 'interceptions' },
                    { name: 'MVPs', value: 'mvps' }
                )
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            const category = normalizeCategory(args[0] || 'goals');

            return await runTopStats({
                guild: message.guild,
                category,
                userId: message.author.id,
                channelId: message.channel.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[topstats] prefix error:', error);
            return message.reply('❌ Failed to load top stats.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const category = normalizeCategory(interaction.options.getString('category') || 'goals');

            return await runTopStats({
                guild: interaction.guild,
                category,
                userId: interaction.user.id,
                channelId: interaction.channel.id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[topstats] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to load top stats.');
            }

            return interaction.reply({
                content: '❌ Failed to load top stats.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   COMPETITION HELPERS
==================================================== */

async function getAllCompetitions(guildId) {
    const [tournaments, events] = await Promise.all([
        getSelectableTournaments(guildId),
        getSelectableEvents(guildId)
    ]);

    const competitions = [];

    for (const t of tournaments) {
        competitions.push({
            type: 'tournament',
            key: t.tournamentKey,
            name: t.name || t.tournamentKey,
            doc: t,
            value: `tournament:${t.tournamentKey}`,
            label: `[TOURN] ${truncate(t.name || t.tournamentKey, 70)}`,
            description: `Key: ${t.tournamentKey}`,
            emoji: t.emoji || '🏆',
            createdAt: t.createdAt
        });
    }

    for (const e of events) {
        const closed = e.isActive === false;
        competitions.push({
            type: 'event',
            key: e.eventKey,
            name: e.name || e.eventKey,
            doc: e,
            value: `event:${e.eventKey}`,
            label: `${closed ? '[CLOSED EVENT]' : '[EVENT]'} ${truncate(e.name || e.eventKey, 65)}`,
            description: `Key: ${e.eventKey} | ${closed ? 'CLOSED' : 'active'}`,
            emoji: e.emoji || '🏆',
            createdAt: e.createdAt
        });
    }

    // Default tournament ALWAYS first (dropdown opens on it), then newest first.
    competitions.sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;

        const da = new Date(a.createdAt || 0).getTime();
        const db = new Date(b.createdAt || 0).getTime();
        return db - da;
    });

    return competitions;
}

function parseCompetitionValue(value) {
    if (!value) return null;
    const idx = value.indexOf(':');
    if (idx === -1) return { type: 'tournament', key: value };
    const type = value.slice(0, idx);
    const key = value.slice(idx + 1);
    if (!['tournament', 'event'].includes(type)) return { type: 'tournament', key: value };
    return { type, key };
}

async function getCompetitionByValue(guildId, value) {
    const parsed = parseCompetitionValue(value);
    if (!parsed) return null;

    if (parsed.type === 'event') {
        const ev = await getEventByKey(guildId, parsed.key);
        if (!ev) return null;
        return {
            type: 'event',
            key: ev.eventKey,
            name: ev.name,
            doc: ev,
            value: `event:${ev.eventKey}`
        };
    } else {
        const t = await getTournamentByKey(guildId, parsed.key);
        if (!t) return null;
        return {
            type: 'tournament',
            key: t.tournamentKey,
            name: t.name,
            doc: t,
            value: `tournament:${t.tournamentKey}`
        };
    }
}

/* ====================================================
   CORE LOGIC
==================================================== */

async function runTopStats({
    guild,
    category,
    userId,
    channelId,
    reply
}) {
    if (!guild) {
        return reply({ content: '❌ This command can only be used in a server.' });
    }

    if (!CATEGORIES[category]) {
        return reply({ content: '❌ Invalid category.' });
    }

    const competitions = await getAllCompetitions(guild.id);

    if (!competitions.length) {
        return reply({ content: '📭 No tournaments or events found.' });
    }

    // Determine default competition
    // Priority: channel-bound event > default tournament > first competition
    let selectedCompetition = null;

    const eventByChannel = await getEventByChannel(guild.id, channelId).catch(() => null);
    if (eventByChannel) {
        selectedCompetition = {
            type: 'event',
            key: eventByChannel.eventKey,
            name: eventByChannel.name,
            doc: eventByChannel,
            value: `event:${eventByChannel.eventKey}`
        };
    } else {
        const defaultTournament = await getDefaultTournament(guild.id);
        if (defaultTournament) {
            selectedCompetition = {
                type: 'tournament',
                key: defaultTournament.tournamentKey,
                name: defaultTournament.name,
                doc: defaultTournament,
                value: `tournament:${defaultTournament.tournamentKey}`
            };
        } else {
            const first = competitions[0];
            selectedCompetition = {
                type: first.type,
                key: first.key,
                name: first.name,
                doc: first.doc,
                value: first.value
            };
        }
    }

    let selectedCategory = category;
    let page = 0;

    const payload = await buildTopStatsPayload({
        guildId: guild.id,
        competition: selectedCompetition,
        competitions,
        category: selectedCategory,
        page
    });

    const msg = await reply(payload);

    if (!msg?.createMessageComponentCollector) return;

    const collector = msg.createMessageComponentCollector({
        time: 600000
    });

    collector.on('collect', async interaction => {
        try {
            if (interaction.user.id !== userId) {
                return interaction.reply({
                    content: 'Not your menu.',
                    ephemeral: true
                });
            }

            if (interaction.isButton()) {
                if (interaction.customId === 'topstats_prev') page--;
                if (interaction.customId === 'topstats_next') page++;
            }

            if (interaction.isStringSelectMenu()) {
                if (interaction.customId === 'topstats_category') {
                    selectedCategory = interaction.values[0];
                    page = 0;
                }

                if (interaction.customId === 'topstats_tournament') {
                    const comp = await getCompetitionByValue(guild.id, interaction.values[0]);
                    if (comp) selectedCompetition = comp;
                    page = 0;
                }
            }

            const updatedPayload = await buildTopStatsPayload({
                guildId: guild.id,
                competition: selectedCompetition,
                competitions,
                category: selectedCategory,
                page
            });

            await interaction.update(updatedPayload);
        } catch (error) {
            console.error('[topstats] collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Failed to update leaderboard.',
                    ephemeral: true
                }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        try {
            await msg.edit({
                components: []
            }).catch(() => null);
        } catch {}
    });
}

/* ====================================================
   PAYLOAD BUILDER
==================================================== */

async function buildTopStatsPayload({
    guildId,
    competition,
    competitions,
    category,
    page
}) {
    const isTournament = competition.type === 'tournament';
    const Model = isTournament ? TournamentPlayer : EventPlayer;
    const queryFilter = {
        guildId,
        [isTournament ? 'tournamentId' : 'eventId']: competition.doc._id,
        isActive: true,
        ...(category === 'ga'
            ? {
                $or: [
                    { 'stats.goals': { $gt: 0 } },
                    { 'stats.assists': { $gt: 0 } }
                ]
            }
            : { [`stats.${category}`]: { $gt: 0 } })
    };

    let query = Model.find(queryFilter).populate('playerId');
    if (isTournament) query = query.populate('teamId');

    if (category !== 'ga') {
        query = query.sort({
            [`stats.${category}`]: -1,
            'stats.played': 1,
            playerNameSnapshot: 1
        });
    }

    let rows = await query.lean();
    if (category === 'ga') rows.sort(compareGoalContributions);

    const pages = chunk(rows, PAGE_SIZE);
    const totalPages = Math.max(pages.length, 1);

    page = Math.max(0, Math.min(page, totalPages - 1));

    const embed = buildEmbed({
        competition,
        category,
        rows,
        page,
        totalPages,
        list: pages[page] || []
    });

    return {
        embeds: [embed],
        components: [
            buildCompetitionDropdown(competitions, competition.value),
            buildCategoryDropdown(category),
            buildPaginationButtons(page, totalPages)
        ]
    };
}

/* ====================================================
   EMBED BUILDER
==================================================== */

function buildEmbed({
    competition,
    category,
    rows,
    page,
    totalPages,
    list
}) {
    const meta = CATEGORIES[category];
    const isEvent = competition.type === 'event';

    const table = list.length
        ? list.map((entry, index) => {
            const rank = String(page * PAGE_SIZE + index + 1).padStart(2, '0');
            const name = truncate(entry.playerNameSnapshot || entry.playerId?.name || 'Unknown', 16).padEnd(16, ' ');
            const stat = String(getCategoryStat(entry, category)).padStart(2, '0');

            return `${rank} | ${name} | ${stat}`;
        }).join('\n')
        : 'No records yet.';

    const activeTalents = list.length
        ? list.map((entry, index) => {
            const rank = page * PAGE_SIZE + index + 1;
            const discordID = entry.playerId?.discordID;
            const name = entry.playerNameSnapshot || entry.playerId?.name || 'Unknown';

            return discordID
                ? `[${rank}] <@${discordID}>`
                : `[${rank}] ${name}`;
        }).join(' • ')
        : '—';

    const isClosed = isEvent && competition.doc.isActive === false;
    const typeLabel = isEvent ? (isClosed ? '[CLOSED EVENT]' : '[EVENT]') : '[TOURN]';
    const compEmoji = competition.doc.emoji || '🏆';
    const statusLine = isEvent ? (isClosed ? '🔴 CLOSED — stats kept' : competition.doc.channelId ? '🟢 ACTIVE' : '🟡 UNBOUND') : '';

    return new EmbedBuilder()
        .setColor(isClosed ? 0x95A5A6 : isEvent ? 0x9B59B6 : 0xFEBE10)
        .setTitle(`${meta.emoji} ${meta.label} LEADERBOARD ${isEvent ? (isClosed ? '— CLOSED EVENT' : '— EVENT') : ''}`)
        .setDescription(
            `${compEmoji} ${typeLabel} **${competition.name}**\n` +
            `Key: \`${competition.key}\`${isEvent ? `\nStatus: ${statusLine}` : ''}\n\n` +
            '```' +
            'RANK | PLAYER           | STAT\n' +
            '--------------------------------\n' +
            table +
            '```'
        )
        .addFields({
            name: '✨ Active Talents',
            value: activeTalents
        })
        .setFooter({
            text: `Page ${page + 1} of ${totalPages} • Total Contributors: ${rows.length} • ${typeLabel} ${competition.key}`
        })
        .setTimestamp();
}

/* ====================================================
   COMPONENT BUILDERS
==================================================== */

function buildCompetitionDropdown(competitions, selectedValue) {
    const options = competitions.slice(0, 25).map(comp => ({
        label: truncate(comp.label, 100),
        description: truncate(comp.description, 100),
        value: comp.value,
        default: comp.value === selectedValue
    }));

    if (!options.length) {
        options.push({
            label: 'No competitions',
            description: 'No tournaments or events',
            value: 'tournament:none',
            default: true
        });
    }

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('topstats_tournament')
            .setPlaceholder('Select tournament / event')
            .addOptions(options)
    );
}

function buildCategoryDropdown(selectedCategory) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('topstats_category')
            .setPlaceholder('Select stat category')
            .addOptions(
                Object.entries(CATEGORIES).map(([key, data]) => ({
                    label: data.label,
                    emoji: data.emoji,
                    value: key,
                    default: key === selectedCategory
                }))
            )
    );
}

function buildPaginationButtons(page, totalPages) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('topstats_prev')
            .setLabel('⬅️ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),

        new ButtonBuilder()
            .setCustomId('topstats_next')
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page >= totalPages - 1)
    );
}

/* ====================================================
   HELPERS
==================================================== */

function chunk(array, size) {
    const result = [];

    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }

    return result;
}

function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 3) + '...' : value;
}

function normalizeCategory(category) {
    const normalized = String(category || 'goals').trim().toLowerCase().replace(/[\s+]/g, '');
    return normalized === 'goalsassists' ? 'ga' : normalized;
}

function getCategoryStat(entry, category) {
    if (category === 'ga') {
        return (Number(entry.stats?.goals) || 0) + (Number(entry.stats?.assists) || 0);
    }
    return Number(entry.stats?.[category]) || 0;
}

function compareGoalContributions(a, b) {
    const contributionDifference = getCategoryStat(b, 'ga') - getCategoryStat(a, 'ga');
    if (contributionDifference) return contributionDifference;

    const playedDifference = (Number(a.stats?.played) || 0) - (Number(b.stats?.played) || 0);
    if (playedDifference) return playedDifference;

    const aName = String(a.playerNameSnapshot || a.playerId?.name || '');
    const bName = String(b.playerNameSnapshot || b.playerId?.name || '');
    return aName.localeCompare(bName);
}

module.exports.CATEGORIES = CATEGORIES;
module.exports.buildTopStatsPayload = buildTopStatsPayload;
module.exports.normalizeCategory = normalizeCategory;
