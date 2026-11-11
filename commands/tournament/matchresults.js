/**
 * matchresults.js
 *
 * View completed match results with pagination and tournament switching.
 * Organizer-only. Shows scores, extra time, penalties, and winners.
 *
 * Usage:  .matchresults [phase]
 * Slash:  /matchresults [phase]
 *
 * Aliases: results, completedmatches, pastresults
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

const { Fixture } = require('../../models/Tournament');
const {
    getDefaultTournament,
    getSelectableTournaments,
    getTournamentByKey
} = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { prettyPhase, truncate } = require('../../utils/displayHelpers');
const { slotEmoji } = require('../../utils/ai/emojiSlots');

const PAGE_SIZE = 10;

module.exports = {
    name: 'matchresults',
    description: 'View completed match results.',
    usage: '.matchresults [phase]',
    aliases: ['results', 'completedmatches', 'pastresults'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('matchresults')
        .setDescription('View completed match results')
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

            return await runMatchResults({
                guild: message.guild,
                userId: message.author.id,
                phase: args[0]?.toLowerCase() || null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[matchresults] prefix error:', error);
            return message.reply('❌ Failed to load match results.');
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

            return await runMatchResults({
                guild: interaction.guild,
                userId: interaction.user.id,
                phase: interaction.options.getString('phase'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[matchresults] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to load match results.');
            }

            return interaction.reply({ content: '❌ Failed to load match results.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

async function runMatchResults({ guild, userId, phase, reply }) {
    const tournaments = await getSelectableTournaments(guild.id);
    if (!tournaments.length) return reply({ content: '📭 No active tournaments found.' });

    let tournament = await getDefaultTournament(guild.id) || tournaments[0];
    let state = await buildState({ guild, tournament, tournaments, phase, page: 0 });

    const msg = await reply({
        embeds: [buildEmbed(state)],
        components: buildComponents(state)
    });

    if (!msg?.createMessageComponentCollector) return;

    const collector = msg.createMessageComponentCollector({ time: 10 * 60 * 1000 });

    collector.on('collect', async interaction => {
        try {
            if (interaction.user.id !== userId) {
                return interaction.reply({ content: 'Not your menu.', ephemeral: true });
            }

            if (interaction.isStringSelectMenu() && interaction.customId === 'mr_tournament') {
                const selected = await getTournamentByKey(guild.id, interaction.values[0]);
                if (selected) tournament = selected;
                state = await buildState({ guild, tournament, tournaments, phase, page: 0 });
            }

            if (interaction.isButton()) {
                if (interaction.customId === 'mr_prev') state.page = Math.max(0, state.page - 1);
                if (interaction.customId === 'mr_next') state.page = Math.min(state.totalPages - 1, state.page + 1);
            }

            await interaction.update({
                embeds: [buildEmbed(state)],
                components: buildComponents(state)
            });
        } catch (error) {
            console.error('[matchresults] collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Failed to update results.', ephemeral: true }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        await msg.edit({ components: buildComponents(state, true) }).catch(() => null);
    });
}

/* ====================================================
   STATE BUILDER
==================================================== */

async function buildState({ guild, tournament, tournaments, phase, page }) {
    const query = {
        guildId: guild.id,
        tournamentId: tournament._id,
        status: 'Played'
    };

    if (phase) query.phase = phase;

    const fixtures = await Fixture.find(query)
        .sort({ updatedAt: -1, matchNumber: -1, leg: 1 })
        .lean();

    const totalPages = Math.max(1, Math.ceil(fixtures.length / PAGE_SIZE));

    return {
        guild,
        tournament,
        tournaments,
        phase,
        fixtures,
        page: Math.min(page, totalPages - 1),
        totalPages
    };
}

/* ====================================================
   EMBED & COMPONENTS
==================================================== */

function buildEmbed(state) {
    const { tournament, phase, fixtures, page, totalPages } = state;
    const tournamentEmoji = tournament.emoji || '🏆';
    const start = page * PAGE_SIZE;
    const current = fixtures.slice(start, start + PAGE_SIZE);

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(`📋 MATCH RESULTS — ${tournament.name.toUpperCase()}`)
        .setDescription(
            `${tournamentEmoji} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n` +
            `${phase ? `Phase: **${prettyPhase(phase)}**\n` : ''}` +
            `Page **${page + 1}/${totalPages}**`
        )
        .setTimestamp();

    embed.addFields({
        name: 'Results',
        value: current.length
            ? current.map(f => formatResultLine(f, state.guild.id)).join('\n\n')
            : phase
                ? `📭 No played results found for **${prettyPhase(phase)}**.`
                : '📭 No played match results found yet.',
        inline: false
    });

    if (fixtures.length > PAGE_SIZE) {
        embed.setFooter({
            text: `Showing ${start + 1}-${Math.min(start + PAGE_SIZE, fixtures.length)} of ${fixtures.length} played results`
        });
    }

    return embed;
}

function buildComponents(state, disabled = false) {
    return [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('mr_tournament')
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
                .setCustomId('mr_prev')
                .setLabel('⬅️ Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled || state.page <= 0),
            new ButtonBuilder()
                .setCustomId('mr_next')
                .setLabel('Next ➡️')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled || state.page >= state.totalPages - 1)
        )
    ];
}

/* ====================================================
   FORMATTING
==================================================== */

function formatResultLine(fixture, guildId) {
    const home = fixture?.result?.home ?? 0;
    const away = fixture?.result?.away ?? 0;

    const goal = slotEmoji('goals', guildId);

    let line =
        `**#${fixture.matchNumber || '-'} • ${fixture.homeTeam} ${goal} ${home}-${away} ${goal} ${fixture.awayTeam}**\n` +
        `${prettyPhase(fixture.phase)}${fixture.groupKey ? ` • Group ${fixture.groupKey}` : ''}`;

    const etHome = fixture?.result?.extraTimeHome;
    const etAway = fixture?.result?.extraTimeAway;

    if (etHome != null && etAway != null) {
        line += ` • ET ${etHome}-${etAway}`;
    }

    const pHome = fixture?.result?.penaltiesHome;
    const pAway = fixture?.result?.penaltiesAway;

    if (pHome != null && pAway != null) {
        line += ` • Pens ${pHome}-${pAway}`;
    }

    if (fixture.result?.winner) {
        line += `\nWinner: **${fixture.result.winner}**`;
    }

    return line;
}
