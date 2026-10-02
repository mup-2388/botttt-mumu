/**
 * standings-hf.js
 *
 * View standings for a tournament or group.
 *
 * Aliases: .standings, .table, .standings-hf
 * Slash:  /standings-hf
 *
 * Generates an image-based standings table using generateStandingsImage().
 * Supports tournament selector + group buttons.
 * Falls back to text if image generation fails.
 *
 * Uses shared helpers from standingsHelpers.js.
 */

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    AttachmentBuilder
} = require('discord.js');

const {
    TournamentTeam
} = require('../../models/Tournament');

const {
    getDefaultTournament,
    getSelectableTournaments,
    getTournamentByKey
} = require('../../utils/getTournament');

let generateStandingsImage = null;
let imageRendererLoadError = null;

try {
    ({ generateStandingsImage } = require('../../utils/generateStandingsImage'));
} catch (error) {
    imageRendererLoadError = error;
    console.warn('[standings-hf] Image renderer unavailable; text fallback enabled:', error.message);
}

const {
    sortTeams,
    compactName,
    getQualificationZone,
    truncate
} = require('../../utils/standingsHelpers');

module.exports = {
    name: 'standings-hf',
    description: 'View standings for a tournament or group.',
    aliases: ['standingshf', 'groupstandings', 'standings', 'table'],
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('standings-hf')
        .setDescription('View standings')
        .addStringOption(opt =>
            opt.setName('group')
                .setDescription('Optional group key like A, B, C...')
                .setRequired(false)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            const requestedGroup = args[0] ? args[0].toUpperCase() : null;

            return await runStandings({
                guild: message.guild,
                requestedGroup,
                userId: message.author.id,
                reply: payload => message.channel.send(payload)
            });
        } catch (error) {
            console.error('[standings-hf] prefix error:', error);
            return message.reply('❌ Failed to load standings.');
        }
    },

    async slashExecute(interaction) {
        try {
            const requestedGroup = interaction.options.getString('group')?.toUpperCase() || null;

            return await runStandings({
                guild: interaction.guild,
                requestedGroup,
                userId: interaction.user.id,
                reply: payload => interaction.reply(payload)
            });
        } catch (error) {
            console.error('[standings-hf] slash error:', error);

            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: '❌ Failed to load standings.' });
            }

            return interaction.reply({
                content: '❌ Failed to load standings.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   MAIN FLOW
==================================================== */

async function runStandings({
    guild,
    requestedGroup,
    userId,
    reply
}) {
    if (!guild) {
        return reply({ content: '❌ This command can only be used in a server.' });
    }

    const tournaments = await getSelectableTournaments(guild.id);

    if (!tournaments.length) {
        return reply({ content: '📭 No active tournaments found.' });
    }

    let tournament = await getDefaultTournament(guild.id);
    if (!tournament) tournament = tournaments[0];

    let selectedGroup = requestedGroup || getFirstGroup(tournament);
    let selectedTournamentKey = tournament.tournamentKey;

    const payload = await buildStandingsPayload({
        guildId: guild.id,
        tournament,
        tournaments,
        selectedGroup
    });

    const sent = await reply(payload);

    if (!sent?.createMessageComponentCollector) return;

    const collector = sent.createMessageComponentCollector({
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

            if (interaction.isStringSelectMenu()) {
                if (interaction.customId === 'standings_tournament') {
                    selectedTournamentKey = interaction.values[0];
                    tournament = await getTournamentByKey(guild.id, selectedTournamentKey);
                    selectedGroup = getFirstGroup(tournament);
                }
            }

            if (interaction.isButton()) {
                if (interaction.customId.startsWith('standings_group_')) {
                    selectedGroup = interaction.customId.replace('standings_group_', '');
                }

                if (interaction.customId === 'standings_overall') {
                    selectedGroup = null;
                }
            }

            const updatedPayload = await buildStandingsPayload({
                guildId: guild.id,
                tournament,
                tournaments,
                selectedGroup
            });

            await interaction.update(updatedPayload);
        } catch (error) {
            console.error('[standings-hf] collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Failed to switch standings view.',
                    ephemeral: true
                }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        await sent.edit({ components: [] }).catch(() => null);
    });
}

/* ====================================================
   BUILD PAYLOAD
==================================================== */

/**
 * Build the Discord message payload.
 * Tries image first, falls back to text.
 *
 * Components (tournament dropdown + group buttons) are always included.
 */
async function buildStandingsPayload({
    guildId,
    tournament,
    tournaments,
    selectedGroup
}) {
    // ── TRY IMAGE ──
    let imageResult = null;

    try {
        if (!generateStandingsImage) {
            throw imageRendererLoadError || new Error('Standings image renderer is unavailable.');
        }

        imageResult = await generateStandingsImage({
            settings: tournament,
            guildId,
            groupKey: selectedGroup
        });
    } catch (imgError) {
        console.error(
            '[standings-hf] Image generation failed, using text fallback:',
            imgError.message
        );
    }

    const components = [
        buildTournamentDropdown(tournaments, tournament.tournamentKey)
    ];

    const groupButtons = buildGroupButtons(tournament, selectedGroup);

    if (groupButtons) {
        components.push(groupButtons);
    }

    if (imageResult) {
        const attachment = new AttachmentBuilder(imageResult.buffer, {
            name: imageResult.fileName
        });

        const caption = buildCaption({ tournament, selectedGroup });

        return {
            content: caption,
            files: [attachment],
            components
        };
    }

    // ── TEXT FALLBACK ──
    const table = await generateTextTable({
        guildId,
        tournament,
        groupKey: selectedGroup
    });

    return {
        content: table,
        components
    };
}

/**
 * Build the text caption above the standings image.
 */
function buildCaption({ tournament, selectedGroup }) {
    const emoji = tournament.emoji || '🏆';
    const name = (tournament.name || 'Tournament').toUpperCase();
    const groupLabel = selectedGroup ? ` — Group ${selectedGroup}` : '';

    return `${emoji} **${name}${groupLabel} STANDINGS**\nKey: \`${tournament.tournamentKey}\``;
}

/* ====================================================
   TEXT FALLBACK
==================================================== */

/**
 * Generate a text-based standings table.
 * Used when image generation fails.
 *
 * Uses shared helpers. No duplicated logic.
 */
async function generateTextTable({
    guildId,
    tournament,
    groupKey
}) {
    const query = {
        guildId,
        tournamentId: tournament._id,
        isActive: true
    };

    if (groupKey) {
        query.groupKey = groupKey;
    }

    let teams = await TournamentTeam.find(query)
        .populate('teamId')
        .lean();

    if (!teams.length) {
        return groupKey
            ? `🏟️ **${tournament.name} — Group ${groupKey}** has no active teams yet.`
            : `🏟️ **${tournament.name}** has no active teams yet.`;
    }

    teams = sortTeams(teams);

    let table = groupKey
        ? `🏆 **${tournament.name.toUpperCase()} — GROUP ${groupKey} STANDINGS**\n`
        : `🏆 **${tournament.name.toUpperCase()} — STANDINGS**\n`;

    table += `Key: \`${tournament.tournamentKey}\`\n`;
    table += '```ansi\n';
    table += `\u001b[1;37mPos Team         P  W  D  L  GF GA GD  Pts\u001b[0m\n`;
    table += `------------------------------------------------\n`;

    teams.forEach((entry, index) => {
        const stats = entry.stats || {};
        const gd = (stats.gf || 0) - (stats.ga || 0);
        const position = index + 1;

        const zone = getQualificationZone({
            position,
            settings: tournament,
            groupKey
        });

        const isHighlighted = zone === 'ucl' || zone === 'qualification';

        const colorCode = zone === 'ucl'
            ? '\u001b[1;34m'       // Blue for UCL
            : zone === 'qualification'
                ? '\u001b[1;32m'    // Green for qualification
                : '\u001b[1;36m';   // Cyan for neutral

        const pos = String(position).padEnd(3, ' ');
        const name = compactName(
            entry.teamNameSnapshot || entry.teamId?.name || 'Unknown',
            12
        ).padEnd(12, ' ');

        const played = String(stats.played || 0).padEnd(2, ' ');
        const wins = String(stats.wins || 0).padEnd(2, ' ');
        const draws = String(stats.draws || 0).padEnd(2, ' ');
        const losses = String(stats.losses || 0).padEnd(2, ' ');
        const gf = String(stats.gf || 0).padEnd(2, ' ');
        const ga = String(stats.ga || 0).padEnd(2, ' ');
        const gdStr = `${gd >= 0 ? '+' : ''}${gd}`.padEnd(3, ' ');
        const pts = String(stats.points || 0);

        table += `${colorCode}${pos} ${name} ${played} ${wins} ${draws} ${losses} ${gf} ${ga} ${gdStr} ${pts}\u001b[0m\n`;

        // Zone separator
        const nextZone = index < teams.length - 1
            ? getQualificationZone({
                position: position + 1,
                settings: tournament,
                groupKey
            })
            : null;

        if (zone !== nextZone && nextZone !== null) {
            table += `\u001b[1;30m------------------------------------------------\u001b[0m\n`;
        }
    });

    table += `------------------------------------------------\n`;

    // Legend
    const legendParts = [];

    if (teams.some((_, i) =>
        getQualificationZone({ position: i + 1, settings: tournament, groupKey }) === 'ucl'
    )) {
        legendParts.push('\u001b[1;34mBlue\u001b[0m = UCL');
    }

    if (teams.some((_, i) =>
        getQualificationZone({ position: i + 1, settings: tournament, groupKey }) === 'qualification'
    )) {
        legendParts.push('\u001b[1;32mGreen\u001b[0m = Qualification');
    }

    if (legendParts.length) {
        table += legendParts.join('  •  ') + '\n';
    }

    table += '```';

    return table;
}

/*
========================================
COMPONENT BUILDERS
========================================
*/

function buildTournamentDropdown(tournaments, selectedKey) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('standings_tournament')
            .setPlaceholder('Select tournament')
            .addOptions(
                tournaments.slice(0, 25).map(tournament => ({
                    label: truncate(tournament.name || tournament.tournamentKey, 80),
                    description: `Key: ${tournament.tournamentKey}`,
                    value: tournament.tournamentKey,
                    default: tournament.tournamentKey === selectedKey
                }))
            )
    );
}

function buildGroupButtons(tournament, selectedGroup) {
    const groupCount = tournament.groupCount || 0;

    if (!groupCount) return null;

    const buttons = [
        new ButtonBuilder()
            .setCustomId('standings_overall')
            .setLabel('Overall')
            .setStyle(!selectedGroup ? ButtonStyle.Success : ButtonStyle.Secondary)
    ];

    const groupKeys = Array.from(
        { length: groupCount },
        (_, i) => String.fromCharCode(65 + i)
    );

    for (const group of groupKeys.slice(0, 4)) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`standings_group_${group}`)
                .setLabel(`Group ${group}`)
                .setStyle(selectedGroup === group ? ButtonStyle.Success : ButtonStyle.Primary)
        );
    }

    return new ActionRowBuilder().addComponents(...buttons);
}

function getFirstGroup(tournament) {
    return (tournament.groupCount || 0) > 0 ? 'A' : null;
}
