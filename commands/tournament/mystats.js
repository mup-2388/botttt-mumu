/**
 * mystats.js
 *
 * View player stats with interactive views:
 * - Tournament / Event Stats (per-competition)
 * - All-Time Stats (career totals from UserProfile)
 * - Trophies (all trophies won)
 * - Awards (special awards like Ballon d'Or, Golden Boot, etc.)
 *
 * Supports both Tournaments and Freestyle Events (UCL etc)
 * Dropdown shows [TOURN] and [EVENT] labels.
 *
 * Usage:  .mystats [@user/userId]
 * Slash:  /mystats [user]
 *
 * Aliases: statsme, playerstats, stats, s
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const {
    Player,
    Team,
    TournamentPlayer,
    EventPlayer,
    EventSettings,
    UserProfile,
    ServerConfig,
    TournamentSettings
} = require('../../models/Tournament');

const {
    getDefaultTournament,
    getSelectableTournaments,
    getDefaultTournamentKey,
    getTournamentByKey
} = require('../../utils/getTournament');

const {
    getSelectableEvents,
    getEventByKey
} = require('../../utils/getEvent');

const { getUserFromArgs, escapeRegex } = require('../../utils/stringHelpers');
const { truncate, parseColor } = require('../../utils/displayHelpers');

const DEFAULT_TROPHY_EMOJI = '<:_Trophy:1507987705311793152>';

module.exports = {
    name: 'mystats',
    description: 'View your player stats.',
    usage: '.mystats [@user/userId]',
    aliases: ['statsme', 'playerstats', 'stats', 's'],
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('mystats')
        .setDescription('View your player stats')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Optional player to inspect')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            const target = await resolvePrefixTarget(message, args) || message.author;

            return await runMyStats({
                guild: message.guild,
                targetUserId: target.id,
                fallbackTag: target.tag || target.username || 'Unknown User',
                fallbackAvatar: target.displayAvatarURL
                    ? target.displayAvatarURL({ dynamic: true, size: 512 })
                    : message.author.displayAvatarURL({ dynamic: true, size: 512 }),
                viewerId: message.author.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[mystats] prefix error:', error);
            return message.reply('❌ Failed to load player stats.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const user = interaction.options.getUser('user') || interaction.user;

            return await runMyStats({
                guild: interaction.guild,
                targetUserId: user.id,
                fallbackTag: user.tag,
                fallbackAvatar: user.displayAvatarURL({ dynamic: true, size: 512 }),
                viewerId: interaction.user.id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[mystats] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to load player stats.');
            }

            return interaction.reply({ content: '❌ Failed to load player stats.', ephemeral: true });
        }
    }
};

/* ====================================================
   TARGET RESOLUTION (PREFIX)
==================================================== */

async function resolvePrefixTarget(message, args = []) {
    const mentionedUser = message.mentions.users.first();
    if (mentionedUser) return mentionedUser;

    if (args.length) {
        const resolved = await getUserFromArgs(message, args);
        if (resolved) return resolved;
    }

    return null;
}

/* ====================================================
   COMPETITION HELPERS
==================================================== */

async function getAllCompetitions(guildId) {
    const [tournaments, events] = await Promise.all([
        getSelectableTournaments(guildId, { includeCompleted: true }),
        getSelectableEvents(guildId)
    ]);

    const competitions = [];

    const defaultKey = await getDefaultTournamentKey(guildId).catch(() => null);

    for (const t of tournaments) {
        const isDefault = defaultKey && String(t.tournamentKey).toLowerCase() === defaultKey;

        competitions.push({
            type: 'tournament',
            key: t.tournamentKey,
            name: t.name || t.tournamentKey,
            doc: t,
            isDefault,
            value: `tournament:${t.tournamentKey}`,
            label: `[TOURN${isDefault ? ' · DEFAULT' : ''}] ${truncate(t.name || t.tournamentKey, 70)}`,
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
            description: `Key: ${e.eventKey} | ${closed ? 'CLOSED' : e.channelId ? 'bound' : 'unbound'} | ${e.isActive ? 'active' : 'closed'}`,
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
    if (idx === -1) {
        // Legacy: assume tournament
        return { type: 'tournament', key: value };
    }
    const type = value.slice(0, idx);
    const key = value.slice(idx + 1);
    if (!['tournament', 'event'].includes(type)) {
        return { type: 'tournament', key: value };
    }
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
        const t = await getTournamentByKey(guildId, parsed.key, { includeCompleted: true });
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

async function runMyStats({ guild, targetUserId, fallbackTag, fallbackAvatar, viewerId, reply }) {
    const globalPlayer = await Player.findOne({
        guildId: guild.id,
        discordID: targetUserId
    }).populate('teamId');

    if (!globalPlayer) {
        return reply({ content: '❌ No player profile found.' });
    }

    const competitions = await getAllCompetitions(guild.id);

    if (!competitions.length) {
        return reply({ content: '❌ No tournaments or events found.' });
    }

    // Determine default selection: default tournament > first tournament > first event
    let selectedCompetition = null;

    const defaultTournament = await getDefaultTournament(guild.id, { includeCompleted: true });
    if (defaultTournament) {
        selectedCompetition = {
            type: 'tournament',
            key: defaultTournament.tournamentKey,
            name: defaultTournament.name,
            doc: defaultTournament,
            value: `tournament:${defaultTournament.tournamentKey}`
        };
    } else {
        // Pick first competition
        const first = competitions[0];
        selectedCompetition = {
            type: first.type,
            key: first.key,
            name: first.name,
            doc: first.doc,
            value: first.value
        };
    }

    let view = 'tournament';

    const payload = await buildPayload({
        guild,
        globalPlayer,
        selectedCompetition,
        competitions,
        view,
        fallbackTag,
        fallbackAvatar
    });

    const msg = await reply(payload);

    if (!msg?.createMessageComponentCollector) return;

    const collector = msg.createMessageComponentCollector({ time: 600000 });

    collector.on('collect', async interaction => {
        try {
            if (interaction.user.id !== viewerId) {
                return interaction.reply({ content: 'Not your menu.', ephemeral: true });
            }

            if (interaction.isStringSelectMenu() && interaction.customId === 'mystats_tournament') {
                const newComp = await getCompetitionByValue(guild.id, interaction.values[0]);
                if (newComp) selectedCompetition = newComp;
                view = 'tournament';
            }

            if (interaction.isButton()) {
                if (interaction.customId === 'mystats_tournament_view') view = 'tournament';
                if (interaction.customId === 'mystats_alltime') view = 'alltime';
                if (interaction.customId === 'mystats_trophies') view = 'trophies';
                if (interaction.customId === 'mystats_awards') view = 'awards';
            }

            const updatedPayload = await buildPayload({
                guild,
                globalPlayer,
                selectedCompetition,
                competitions,
                view,
                fallbackTag,
                fallbackAvatar
            });

            await interaction.update(updatedPayload);
        } catch (error) {
            console.error('[mystats] collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Failed to update stats view.', ephemeral: true }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        await msg.edit({ components: [] }).catch(() => null);
    });
}

/* ====================================================
   PAYLOAD BUILDER
==================================================== */

async function buildPayload({ guild, globalPlayer, selectedCompetition, competitions, view, fallbackTag, fallbackAvatar }) {
    const config = await ServerConfig.findOne({ guildId: guild.id }).lean();

    const profile = await UserProfile.findOne({
        guildId: guild.id,
        discordID: globalPlayer.discordID
    }).lean();

    const globalProfiles = await UserProfile.find({
        discordID: globalPlayer.discordID
    }).lean();

    const globalTrophies = [];
    const globalAwards = [];
    const guildNameMap = new Map();

    for (const gp of globalProfiles) {
        if (gp.guildId && !guildNameMap.has(gp.guildId)) {
            const g = guild.client.guilds.cache.get(gp.guildId);
            guildNameMap.set(gp.guildId, g?.name || 'Unknown Server');
        }

        if (Array.isArray(gp.trophies)) {
            for (const t of gp.trophies) {
                t._sourceGuildId = gp.guildId;
                globalTrophies.push(t);
            }
        }
        if (Array.isArray(gp.awards)) {
            for (const a of gp.awards) {
                a._sourceGuildId = gp.guildId;
                globalAwards.push(a);
            }
        }
    }

    let tournamentPlayer = null;
    let eventPlayer = null;

    if (selectedCompetition?.type === 'tournament') {
        tournamentPlayer = await TournamentPlayer.findOne({
            guildId: guild.id,
            tournamentId: selectedCompetition.doc._id,
            playerId: globalPlayer._id,
            isActive: true
        }).lean();
    } else if (selectedCompetition?.type === 'event') {
        eventPlayer = await EventPlayer.findOne({
            guildId: guild.id,
            eventId: selectedCompetition.doc._id,
            playerId: globalPlayer._id,
            isActive: true
        }).lean();
    }

    const emojis = getEmojiPack(config);
    const tournamentEmojiMap = await getTournamentEmojiMap(guild.id);
    const eventEmojiMap = await getEventEmojiMap(guild.id);

    /*
     * The team shown for a tournament must be the team the player is on
     * IN THAT TOURNAMENT — never a stale global team from an old tournament.
     */
    let tournamentTeam = null;

    if (selectedCompetition?.type === 'tournament') {
        const rosterTeamId = tournamentPlayer?.teamId || null;
        const rosterName = tournamentPlayer?.teamNameSnapshot
            && tournamentPlayer.teamNameSnapshot !== 'FREE AGENT'
            ? tournamentPlayer.teamNameSnapshot
            : null;

        if (rosterTeamId) {
            tournamentTeam = await Team.findOne({ guildId: guild.id, _id: rosterTeamId }).lean();

            if (!tournamentTeam && rosterName) {
                tournamentTeam = await Team.findOne({
                    guildId: guild.id,
                    name: { $regex: new RegExp(`^${escapeRegex(rosterName)}$`, 'i') }
                }).lean();
            }
        } else if (rosterName) {
            tournamentTeam = await Team.findOne({
                guildId: guild.id,
                name: { $regex: new RegExp(`^${escapeRegex(rosterName)}$`, 'i') }
            }).lean();
        }
    }

    const embed =
        view === 'alltime'
            ? buildAllTimeEmbed({ guild, globalPlayer, profile, emojis, fallbackTag, fallbackAvatar })
            : view === 'trophies'
                ? buildTrophiesEmbed({ guild, globalPlayer, profile, emojis, tournamentEmojiMap, fallbackTag, fallbackAvatar, globalTrophies, guildNameMap })
                : view === 'awards'
                    ? buildAwardsEmbed({ guild, globalPlayer, profile, emojis, fallbackTag, fallbackAvatar, globalAwards, guildNameMap })
                    : selectedCompetition?.type === 'event'
                        ? buildEventEmbed({ guild, globalPlayer, event: selectedCompetition.doc, eventPlayer, emojis, fallbackTag, fallbackAvatar })
                        : buildTournamentEmbed({ guild, globalPlayer, tournament: selectedCompetition.doc, tournamentPlayer, tournamentTeam, emojis, fallbackTag, fallbackAvatar });

    return {
        embeds: [embed],
        components: [
            buildCompetitionDropdown(competitions, selectedCompetition?.value),
            buildButtons(view)
        ]
    };
}

/* ====================================================
   EMBED BUILDERS
==================================================== */

function buildTournamentEmbed({ guild, globalPlayer, tournament, tournamentPlayer, tournamentTeam = null, emojis, fallbackTag, fallbackAvatar }) {
    // Team inside THIS tournament (per-tournament roster), not the global teamId
    const team = tournamentTeam || null;
    const teamName =
        team?.name ||
        (tournamentPlayer?.teamNameSnapshot && tournamentPlayer.teamNameSnapshot !== 'FREE AGENT'
            ? tournamentPlayer.teamNameSnapshot
            : tournamentPlayer
                ? 'FREE AGENT'
                : 'No Team');
    const teamColor = parseColor(team?.color, null);
    const stats = tournamentPlayer?.stats || {};
    const contributions = (stats.goals || 0) + (stats.assists || 0);
    const tournamentEmoji = tournament.emoji || '🏆';

    return new EmbedBuilder()
        .setColor(teamColor || 0xFEBE10)
        .setAuthor({
            name: `${teamName} Profile`,
            iconURL: team?.logoURL || guild.iconURL() || fallbackAvatar
        })
        .setTitle(`🥇 PLAYER CARD: ${globalPlayer.name.toUpperCase()}`)
        .setDescription(
            `${tournamentEmoji} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\``
        )
        .setThumbnail(fallbackAvatar || guild.iconURL())
        .addFields(
            {
                name: '👤 Player Info',
                value:
                    `User: <@${globalPlayer.discordID}>\n` +
                    `Team: **${teamName}**\n` +
                    `Captain: **${(tournamentPlayer?.isCaptain ?? (String(team?.captainID) === String(globalPlayer.discordID))) ? 'Yes' : 'No'}**`,
                inline: false
            },
            { name: `${emojis.stats.played} Matches Played`, value: `\`${stats.played || 0}\``, inline: false },
            { name: `${emojis.stats.mvps} MVPs`, value: `\`${stats.mvps || 0}\``, inline: true },
            { name: `${emojis.stats.goals} Goals`, value: `\`${stats.goals || 0}\``, inline: true },
            { name: `${emojis.stats.assists} Assists`, value: `\`${stats.assists || 0}\``, inline: true },
            { name: `${emojis.stats.saves} Saves`, value: `\`${stats.saves || 0}\``, inline: true },
            { name: `${emojis.stats.tackles} Tackles`, value: `\`${stats.tackles || 0}\``, inline: true },
            { name: `${emojis.stats.interceptions} Interceptions`, value: `\`${stats.interceptions || 0}\``, inline: true },
            { name: `${emojis.stats.ga} G+A`, value: `\`${contributions}\``, inline: true }
        )
        .setFooter({ text: fallbackTag })
        .setTimestamp();
}

function buildEventEmbed({ guild, globalPlayer, event, eventPlayer, emojis, fallbackTag, fallbackAvatar }) {
    const stats = eventPlayer?.stats || {};
    const contributions = (stats.goals || 0) + (stats.assists || 0);
    const eventEmoji = event.emoji || '🏆';
    const channelInfo = event.channelId ? `<#${event.channelId}>` : '`not bound`';
    const closed = event.isActive === false;
    const statusLine = closed ? '🔴 CLOSED — stats kept, no new updates' : event.channelId ? '🟢 ACTIVE' : '🟡 UNBOUND';

    return new EmbedBuilder()
        .setColor(closed ? 0x95A5A6 : 0x9B59B6)
        .setAuthor({
            name: `${event.name} — Event Stats ${closed ? '[CLOSED]' : ''}`,
            iconURL: guild.iconURL() || fallbackAvatar
        })
        .setTitle(`🎮 EVENT CARD: ${globalPlayer.name.toUpperCase()}`)
        .setDescription(
            `${eventEmoji} Event: **${event.name}**\n` +
            `Key: \`${event.eventKey}\`\n` +
            `Status: ${statusLine}\n` +
            `Channel: ${channelInfo}\n` +
            `Type: \`${closed ? '[CLOSED EVENT]' : '[EVENT]'}\``
        )
        .setThumbnail(fallbackAvatar || guild.iconURL())
        .addFields(
            {
                name: '👤 Player Info',
                value:
                    `User: <@${globalPlayer.discordID}>\n` +
                    `Event: **${event.name}**\n` +
                    `Tracked: **${eventPlayer ? 'Yes' : 'No stats yet'}**`,
                inline: false
            },
            { name: `${emojis.stats.played} Matches Played`, value: `\`${stats.played || 0}\``, inline: false },
            { name: `${emojis.stats.mvps} MVPs`, value: `\`${stats.mvps || 0}\``, inline: true },
            { name: `${emojis.stats.goals} Goals`, value: `\`${stats.goals || 0}\``, inline: true },
            { name: `${emojis.stats.assists} Assists`, value: `\`${stats.assists || 0}\``, inline: true },
            { name: `${emojis.stats.saves} Saves`, value: `\`${stats.saves || 0}\``, inline: true },
            { name: `${emojis.stats.tackles} Tackles`, value: `\`${stats.tackles || 0}\``, inline: true },
            { name: `${emojis.stats.interceptions} Interceptions`, value: `\`${stats.interceptions || 0}\``, inline: true },
            { name: `${emojis.stats.ga} G+A`, value: `\`${contributions}\``, inline: true }
        )
        .setFooter({ text: `${fallbackTag} • [EVENT] ${event.eventKey}` })
        .setTimestamp();
}

function buildAllTimeEmbed({ guild, globalPlayer, profile, emojis, fallbackTag, fallbackAvatar }) {
    const stats = profile?.allTimeStats || {};
    const contributions = (stats.goals || 0) + (stats.assists || 0);

    return new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`🌍 ALL-TIME STATS — ${globalPlayer.name.toUpperCase()}`)
        .setThumbnail(fallbackAvatar || guild.iconURL())
        .addFields(
            { name: `${emojis.stats.played} Career Matches`, value: `\`${stats.played || 0}\``, inline: false },
            { name: `${emojis.stats.goals} Goals`, value: `\`${stats.goals || 0}\``, inline: true },
            { name: `${emojis.stats.assists} Assists`, value: `\`${stats.assists || 0}\``, inline: true },
            { name: `${emojis.stats.mvps} MVPs`, value: `\`${stats.mvps || 0}\``, inline: true },
            { name: `${emojis.stats.saves} Saves`, value: `\`${stats.saves || 0}\``, inline: true },
            { name: `${emojis.stats.tackles} Tackles`, value: `\`${stats.tackles || 0}\``, inline: true },
            { name: `${emojis.stats.interceptions} Interceptions`, value: `\`${stats.interceptions || 0}\``, inline: true },
            { name: `${emojis.stats.ga} G+A`, value: `\`${contributions}\``, inline: true }
        )
        .setFooter({ text: fallbackTag })
        .setTimestamp();
}

function buildTrophiesEmbed({ guild, globalPlayer, profile, emojis, tournamentEmojiMap, fallbackTag, fallbackAvatar, globalTrophies, guildNameMap }) {
    const trophyLines = (globalTrophies || [])
        .slice(0, 25)
        .map(trophy => formatTrophyLine(trophy, emojis, tournamentEmojiMap, guild.id, guildNameMap))
        .filter(Boolean);

    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle(`${emojis.trophy.default} TROPHIES — ${globalPlayer.name.toUpperCase()}`)
        .setThumbnail(fallbackAvatar || guild.iconURL())
        .setDescription(trophyLines.length ? trophyLines.join('\n') : 'No trophies won yet.')
        .setFooter({ text: fallbackTag })
        .setTimestamp();
}

function buildAwardsEmbed({ guild, globalPlayer, profile, emojis, fallbackTag, fallbackAvatar, globalAwards, guildNameMap }) {
    const awards = globalAwards || [];

    return new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🏅 AWARDS — ${globalPlayer.name.toUpperCase()}`)
        .setThumbnail(fallbackAvatar || guild.iconURL())
        .setDescription(
            awards.length
                ? awards.slice(0, 25).map(award => {
                    const awardEmoji = award.emoji || emojis.awards[award.awardType] || '🏅';
                    const awardName = award.name || cleanAwardTitle(award.title) || prettyAwardType(award.awardType);
                    const tournamentName = award.tournamentName || award.tournamentKey || 'Tournament';
                    const serverLabel = buildServerLabel(award._sourceGuildId, guild.id, guildNameMap);

                    return `${awardEmoji} **${tournamentName} ${awardName}**${serverLabel}`;
                }).join('\n')
                : 'No awards earned yet.'
        )
        .setFooter({ text: fallbackTag })
        .setTimestamp();
}

/* ====================================================
   UI COMPONENTS
==================================================== */

function buildCompetitionDropdown(competitions, selectedValue) {
    // Discord limits 25 options
    const options = competitions.slice(0, 25).map(comp => ({
        label: truncate(comp.label, 100),
        description: truncate(comp.description, 100),
        value: comp.value,
        default: comp.value === selectedValue,
        emoji: comp.emoji && comp.emoji.length < 10 ? comp.emoji : undefined
    }));

    // Ensure at least one option
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
            .setCustomId('mystats_tournament')
            .setPlaceholder('Select tournament / event')
            .addOptions(options)
    );
}

function buildButtons(view) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('mystats_tournament_view')
            .setLabel('Competition Stats')
            .setStyle(view === 'tournament' ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('mystats_alltime')
            .setLabel('All-Time')
            .setStyle(view === 'alltime' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('mystats_trophies')
            .setLabel('Trophies')
            .setStyle(view === 'trophies' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('mystats_awards')
            .setLabel('Awards')
            .setStyle(view === 'awards' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
}

/* ====================================================
   EMOJI CONFIG
==================================================== */

function getEmojiPack(config) {
    return {
        stats: {
            played: config?.emojis?.stats?.played || '<:Stadium:1487010283506630776>',
            goals: config?.emojis?.stats?.goals || '<:Goal:1488855482142556180>',
            assists: config?.emojis?.stats?.assists || '<:Assist:1488530563500605532>',
            saves: config?.emojis?.stats?.saves || '<:saves:1488530642127028358>',
            tackles: config?.emojis?.stats?.tackles || '<:tackles:1488530871668703255>',
            interceptions: config?.emojis?.stats?.interceptions || '🧠',
            mvps: config?.emojis?.stats?.mvps || '<:mvp:1488530468184920195>',
            ga: config?.emojis?.stats?.ga || '🔥'
        },
        awards: {
            ballon_dor: config?.emojis?.awards?.ballon_dor || '🏆',
            golden_boot: config?.emojis?.awards?.golden_boot || '⚽',
            golden_glove: config?.emojis?.awards?.golden_glove || '🧤',
            playmaker: config?.emojis?.awards?.playmaker || '🎯'
        },
        trophy: {
            default: (config?.emojis?.trophy?.default || config?.emojis?.trophies?.default) === '🏆'
                ? DEFAULT_TROPHY_EMOJI
                : (config?.emojis?.trophy?.default || config?.emojis?.trophies?.default || DEFAULT_TROPHY_EMOJI),
            champion: (config?.emojis?.trophy?.champion || config?.emojis?.trophies?.champion) === '🏆'
                ? DEFAULT_TROPHY_EMOJI
                : (config?.emojis?.trophy?.champion || config?.emojis?.trophies?.champion || DEFAULT_TROPHY_EMOJI),
            runner_up: config?.emojis?.trophy?.runner_up || config?.emojis?.trophies?.runner_up || '🥈'
        }
    };
}

async function getTournamentEmojiMap(guildId) {
    const tournaments = await TournamentSettings.find({ guildId })
        .select('tournamentKey emoji')
        .lean()
        .catch(() => []);

    const map = new Map();
    for (const tournament of tournaments) {
        if (tournament.tournamentKey && tournament.emoji) {
            map.set(tournament.tournamentKey, tournament.emoji);
        }
    }
    return map;
}

async function getEventEmojiMap(guildId) {
    const events = await EventSettings.find({ guildId })
        .select('eventKey emoji')
        .lean()
        .catch(() => []);

    const map = new Map();
    for (const ev of events) {
        if (ev.eventKey && ev.emoji) {
            map.set(ev.eventKey, ev.emoji);
        }
    }
    return map;
}

/* ====================================================
   TROPHY & AWARD FORMATTING
==================================================== */

function buildServerLabel(sourceGuildId, currentGuildId, guildNameMap) {
    if (!sourceGuildId || sourceGuildId === currentGuildId) return '';

    const serverName = guildNameMap?.get(sourceGuildId) || 'Unknown Server';

    return ` — ${serverName}`;
}

function formatTrophyLine(trophy, emojis, tournamentEmojiMap, currentGuildId, guildNameMap) {
    const clean = normalizeTrophy(trophy, emojis, tournamentEmojiMap);
    if (!clean) return null;

    const serverLabel = buildServerLabel(trophy._sourceGuildId, currentGuildId, guildNameMap);

    return `${clean.emoji} **${clean.tournamentName} ${clean.label}**${serverLabel}`;
}

function normalizeTrophy(trophy, emojis, tournamentEmojiMap) {
    if (!trophy) return null;

    const tournamentName = trophy.tournamentName || trophy.tournamentKey || 'Tournament';
    const tournamentKey = trophy.tournamentKey || '';

    let label = '';

    if (trophy.type === 'champion') label = 'Winner';
    else if (trophy.type === 'runner_up') label = 'Runner Up';
    else if (String(trophy.name || '').toLowerCase() === 'winner') label = 'Winner';
    else if (String(trophy.name || '').toLowerCase() === 'runner up') label = 'Runner Up';
    else if (String(trophy.label || '').toLowerCase() === 'winner') label = 'Winner';
    else if (String(trophy.label || '').toLowerCase() === 'runner up') label = 'Runner Up';
    else if (String(trophy.title || '').toLowerCase().includes('winner')) label = 'Winner';
    else if (String(trophy.title || '').toLowerCase().includes('runner up')) label = 'Runner Up';

    if (!label) return null;

    const tournamentEmoji = tournamentKey && tournamentEmojiMap?.get(tournamentKey)
        ? tournamentEmojiMap.get(tournamentKey)
        : null;

    const savedEmoji = String(trophy.emoji || '').trim();
    const genericWinnerEmojis = new Set(['🏆', '🏅', '🥇']);
    const genericRunnerEmojis = new Set(['🥈', '🏅']);

    let emoji;

    if (label === 'Winner') {
        emoji =
            tournamentEmoji ||
            (savedEmoji && !genericWinnerEmojis.has(savedEmoji) ? savedEmoji : null) ||
            emojis?.trophy?.champion ||
            emojis?.trophy?.default ||
            DEFAULT_TROPHY_EMOJI;
    } else if (label === 'Runner Up') {
        emoji =
            tournamentEmoji ||
            (savedEmoji && !genericRunnerEmojis.has(savedEmoji) ? savedEmoji : null) ||
            emojis?.trophy?.runner_up ||
            '🥈';
    } else {
        emoji = tournamentEmoji || savedEmoji || emojis?.trophy?.default || DEFAULT_TROPHY_EMOJI;
    }

    return { tournamentName, label, emoji };
}

function cleanAwardTitle(title) {
    let value = String(title || '').trim();
    if (!value) return '';

    value = value
        .replace(/<a?:\w+:\d+>/g, '')
        .replace(/[🏆⚽🧤🎯🏅🥇🥈🥉]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return value;
}

function prettyAwardType(type) {
    const map = {
        ballon_dor: "Ballon d'Or",
        golden_boot: 'Golden Boot',
        golden_glove: 'Golden Glove',
        playmaker: 'Playmaker'
    };

    return map[type] || 'Award';
}
