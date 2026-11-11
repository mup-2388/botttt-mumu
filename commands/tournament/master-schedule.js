/**
 * master-schedule.js
 *
 * View the full tournament fixture list with pagination and tournament switching.
 * Organizer-only. Supports live schedule refresh for broadcast channels.
 *
 * Usage:  .master-schedule [phase]
 * Slash:  /master-schedule [phase]
 *
 * Aliases: masterschedule, fullschedule, allfixtures
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} = require('discord.js');

const { Fixture, Team } = require('../../models/Tournament');
const {
    getDefaultTournament,
    getSelectableTournaments,
    getTournamentByKey
} = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { prettyPhase, truncate } = require('../../utils/displayHelpers');
const { vsLine, slotEmoji } = require('../../utils/ai/emojiSlots');
const { isReserved, reservedBadge } = require('../../utils/reservedMatches');
const { extractRoundNumber } = require('../../utils/fixtureBuilder');

const LIVE_KEY = 'live_master_schedule';

module.exports = {
    name: 'master-schedule',
    description: 'View full tournament fixture list.',
    usage: '.master-schedule [phase]',
    aliases: ['masterschedule', 'fullschedule', 'allfixtures'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('master-schedule')
        .setDescription('View full tournament fixture list')
        .addStringOption(opt =>
            opt.setName('phase')
                .setDescription('Optional phase filter')
                .setRequired(false)
                .addChoices(
                    { name: 'League', value: 'league' },
                    { name: 'Group', value: 'group' },
                    { name: 'Qualifier', value: 'qualifier' },
                    { name: 'Eliminator', value: 'eliminator' },
                    { name: 'Quarter Final', value: 'quarterfinal' },
                    { name: 'Semi Final', value: 'semifinal' },
                    { name: 'Final', value: 'final' },
                    { name: 'Custom', value: 'custom' }
                )
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

            return await runMasterSchedule({
                client: message.client,
                guild: message.guild,
                userId: message.author.id,
                phase: args[0]?.toLowerCase() || null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[master-schedule] prefix error:', error);
            return message.reply('❌ Failed to load full schedule.');
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

            return await runMasterSchedule({
                client: interaction.client,
                guild: interaction.guild,
                userId: interaction.user.id,
                phase: interaction.options.getString('phase'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[master-schedule] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to load full schedule.');
            }

            return interaction.reply({ content: '❌ Failed to load full schedule.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

async function runMasterSchedule({ client, guild, userId, phase, reply }) {
    const tournaments = await getSelectableTournaments(guild.id);
    if (!tournaments.length) return reply({ content: '📭 No active tournaments found.' });

    let tournament = await getDefaultTournament(guild.id);

    if (!tournament) {
        return reply({ content: '⚠️ No default tournament is set. Set a default tournament, then open the master schedule again.' });
    }

    let state = await buildState({ guild, tournament, tournaments, phase });

    const sent = await reply({
        embeds: [buildEmbed(state)],
        components: buildComponents(state)
    });

    rememberLiveSchedule(client, guild.id, sent, {
        userId,
        phase,
        tournamentKey: tournament.tournamentKey
    });

    if (!sent?.createMessageComponentCollector) return;

    const collector = sent.createMessageComponentCollector({ time: 10 * 60 * 1000 });

    collector.on('collect', async interaction => {
        if (interaction.user.id !== userId) {
            return interaction.reply({ content: 'Not your menu.', ephemeral: true });
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'ms_tournament') {
            const selected = await getTournamentByKey(guild.id, interaction.values[0]);
            if (selected) tournament = selected;
            state = await buildState({ guild, tournament, tournaments, phase });
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'ms_prev') state.page = Math.max(0, state.page - 1);
            if (interaction.customId === 'ms_next') state.page = Math.min(state.pages.length - 1, state.page + 1);
        }

        rememberLiveSchedule(client, guild.id, interaction.message, {
            userId,
            phase,
            tournamentKey: tournament.tournamentKey,
            page: state.page
        });

        await interaction.update({
            embeds: [buildEmbed(state)],
            components: buildComponents(state)
        });
    });

    collector.on('end', async () => {
        await sent.edit({ components: buildComponents(state, true) }).catch(() => null);
    });
}

/* ====================================================
   STATE BUILDER
==================================================== */

async function buildState({ guild, tournament, tournaments, phase }) {
    const query = {
        guildId: guild.id,
        tournamentId: tournament._id
    };

    if (phase) query.phase = phase;

    const [fixtures, teams] = await Promise.all([
        Fixture.find(query).sort({ matchNumber: 1, leg: 1 }).lean(),
        Team.find({ guildId: guild.id }).select('name stadium').lean()
    ]);

    const stadiumMap = new Map(
        teams.map(t => [String(t.name).toLowerCase(), t.stadium || 'Home Ground'])
    );

    const pages = buildMatchdayPages(fixtures);

    const firstPendingPage = pages.findIndex(page =>
        page.fixtures.some(f => f.status === 'Pending' || f.status === 'Live')
    );

    return {
        guild,
        tournament,
        tournaments,
        phase,
        pages: pages.length ? pages : [{ label: 'No Fixtures', fixtures: [] }],
        page: firstPendingPage >= 0 ? firstPendingPage : 0,
        stadiumMap
    };
}

/* ====================================================
   EMBED & COMPONENTS
==================================================== */

function buildEmbed(state) {
    const current = state.pages[state.page];
    const tournamentEmoji = state.tournament.emoji || '🏆';

    const embed = new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle(`${slotEmoji('calendar', state.guild.id)} MASTER SCHEDULE — ${state.tournament.name.toUpperCase()}`)
        .setDescription(
            `Showing: **${tournamentEmoji} ${current.label}**\n` +
            `Page **${state.page + 1}/${state.pages.length}**`
        )
        .setTimestamp();

    embed.addFields({
        name: `${tournamentEmoji} ${current.label}`,
        value: current.fixtures.length
            ? current.fixtures.map(f => formatFixture(f, state.stadiumMap, state.guild.id)).join('\n\n')
            : 'No fixtures found.',
        inline: false
    });

    return embed;
}

function buildComponents(state, disabled = false) {
    return [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('ms_tournament')
                .setPlaceholder('Select tournament')
                .setDisabled(disabled)
                .addOptions(
                    state.tournaments.slice(0, 25).map(t => ({
                        label: truncate(t.name || t.tournamentKey, 80),
                        description: `Key: ${t.tournamentKey}`,
                        value: t.tournamentKey,
                        default: t.tournamentKey === state.tournament.tournamentKey
                    }))
                )
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ms_prev')
                .setLabel('⬅️ Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled || state.page <= 0),
            new ButtonBuilder()
                .setCustomId('ms_next')
                .setLabel('Next ➡️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled || state.page >= state.pages.length - 1)
        )
    ];
}

/* ====================================================
   PAGE BUILDER
==================================================== */

function buildMatchdayPages(fixtures) {
    const map = new Map();

    for (const fixture of fixtures) {
        const key = fixture.roundLabel || prettyPhase(fixture.phase);

        if (!map.has(key)) {
            map.set(key, {
                label: key,
                sort: extractRoundNumber(key) || fixture.matchNumber || 0,
                fixtures: []
            });
        }

        map.get(key).fixtures.push(fixture);
    }

    return Array.from(map.values())
        .sort((a, b) => a.sort - b.sort)
        .map(page => ({
            ...page,
            fixtures: page.fixtures.sort((a, b) => (a.matchNumber || 0) - (b.matchNumber || 0))
        }));
}

/* ====================================================
   FORMATTING
==================================================== */

function formatFixture(fixture, stadiumMap, guildId = fixture.guildId) {
    const stadium =
        fixture.venueType === 'neutral'
            ? fixture.venueName || 'Neutral Ground'
            : stadiumMap.get(String(fixture.homeTeam || '').toLowerCase()) || fixture.venueName || 'Home Ground';

    const matchup = fixture.status === 'Played'
        ? `${fixture.homeTeam} **${slotEmoji('goals', guildId)} ${fixture.result?.home ?? '-'}-${fixture.result?.away ?? '-'} ${slotEmoji('goals', guildId)}** ${fixture.awayTeam}`
        : vsLine(fixture.homeTeam, fixture.awayTeam, guildId);
    const badge = isReserved(fixture) ? `\n${reservedBadge(fixture, { guildId })}` : '';

    return (
        `**#${fixture.matchNumber} • ${matchup}**\n` +
        `🏟️ ${stadium} • 📍 ${fixture.status}${badge}`
    );
}

/* ====================================================
   LIVE SCHEDULE TRACKING
==================================================== */

function rememberLiveSchedule(client, guildId, message, data) {
    if (!client.liveSettings) return;

    const key = `${LIVE_KEY}:${guildId}`;
    const list = client.liveSettings.get(key) || [];
    const filtered = list.filter(item => item.messageId !== message.id);

    filtered.push({
        channelId: message.channel.id,
        messageId: message.id,
        ...data
    });

    client.liveSettings.set(key, filtered);
}

/**
 * Refresh all live master schedule messages for a tournament.
 * Called after fixture changes (report, edit, force, etc.).
 */
async function refreshLiveMasterSchedules(client, guildId, tournamentKey) {
    if (!client.liveSettings) return;

    const key = `${LIVE_KEY}:${guildId}`;
    const list = client.liveSettings.get(key) || [];
    const fresh = [];

    for (const item of list) {
        try {
            if (item.tournamentKey !== tournamentKey) {
                fresh.push(item);
                continue;
            }

            const guild = await client.guilds.fetch(guildId);
            const channel = await client.channels.fetch(item.channelId);
            const message = await channel.messages.fetch(item.messageId);

            const tournaments = await getSelectableTournaments(guildId);
            const tournament = await getTournamentByKey(guildId, tournamentKey);
            if (!tournament) continue;

            const state = await buildState({ guild, tournament, tournaments, phase: item.phase });
            state.page = Math.min(item.page ?? state.page, state.pages.length - 1);

            await message.edit({
                embeds: [buildEmbed(state)],
                components: buildComponents(state)
            });

            fresh.push(item);
        } catch {
            // Message deleted or channel gone — skip
        }
    }

    client.liveSettings.set(key, fresh);
}

module.exports.refreshLiveMasterSchedules = refreshLiveMasterSchedules;
