/**
 * nextmatch.js
 *
 * Shows a paginated team schedule with next match info.
 * Supports tournament switching and page navigation.
 *
 * Usage:  .nm [team name]
 * Slash:  /nextmatch team:<name>
 *
 * Aliases: nm, fixtures, schedule
 */

const {
    EmbedBuilder,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} = require('discord.js');

const {
    Fixture,
    Team,
    Player,
    TournamentTeam
} = require('../../models/Tournament');

const {
    getDefaultTournament,
    getSelectableTournaments,
    getTournamentByKey
} = require('../../utils/getTournament');

const { prettyPhase } = require('../../utils/displayHelpers');
const { resolveUserTeam } = require('../../utils/tournamentContext');
const { escapeRegex } = require('../../utils/stringHelpers');

const PAGE_SIZE = 4;

module.exports = {
    name: 'nextmatch',
    aliases: ['nm', 'fixtures'],
    description: 'Shows a paginated team schedule with next match info.',
    usage: '.nm [team name]',
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('nextmatch')
        .setDescription('Show a team schedule and next match')
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Optional team name')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            return await runNextMatch({
                guild: message.guild,
                userId: message.author.id,
                teamNameInput: args.length > 0 ? args.join(' ') : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[nextmatch] prefix error:', error);
            return message.reply('❌ Failed to load fixtures.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return await runNextMatch({
                guild: interaction.guild,
                userId: interaction.user.id,
                teamNameInput: interaction.options.getString('team'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[nextmatch] slash error:', error);

            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: '❌ Failed to load fixtures.' });
            }

            return interaction.reply({
                content: '❌ Failed to load fixtures.',
                ephemeral: true
            });
        }
    }
};

async function runNextMatch({
    guild,
    userId,
    teamNameInput,
    reply
}) {
    const resolvedTeam = await resolveTeamForUser({ guild, userId, teamNameInput });

    if (!resolvedTeam?.team) {
        return reply({
            content: teamNameInput
                ? `🚫 Team not found: \`${teamNameInput}\`.`
                : '❌ You are not linked to a team yet.\n' +
                  'Use `.nm <Team Name>` to see a team\'s fixtures (e.g. `.nm Reds`).'
        });
    }

    const team = resolvedTeam.team;

    const tournaments = await getSelectableTournaments(guild.id);

    if (!tournaments.length) {
        return reply({ content: '📭 No active tournaments found.' });
    }

    // Prefer the tournament the team was found in (so a roster-only player
    // sees THEIR fixtures instead of an empty list from the default tournament).
    let tournament = resolvedTeam.tournament || await getDefaultTournament(guild.id);
    if (!tournament) tournament = tournaments[0];

    let state = await buildState({
        guild,
        team,
        tournament,
        tournaments
    });

    const msg = await reply({
        embeds: [await buildScheduleEmbed(state)],
        components: buildComponents(state)
    });

    if (!msg?.createMessageComponentCollector) return;

    const collector = msg.createMessageComponentCollector({
        time: 10 * 60 * 1000
    });

    collector.on('collect', async interaction => {
        try {
            if (interaction.user.id !== userId) {
                return interaction.reply({
                    content: '🚫 Only the user who opened this schedule can use this menu.',
                    ephemeral: true
                });
            }

            if (interaction.isStringSelectMenu()) {
                if (interaction.customId === 'nm_tournament') {
                    const selectedTournament = await getTournamentByKey(
                        guild.id,
                        interaction.values[0]
                    );

                    if (selectedTournament) {
                        tournament = selectedTournament;
                    }

                    state = await buildState({
                        guild,
                        team,
                        tournament,
                        tournaments
                    });
                }
            }

            if (interaction.isButton()) {
                if (interaction.customId === 'nm_prev') {
                    state.page = Math.max(0, state.page - 1);
                }

                if (interaction.customId === 'nm_next') {
                    state.page = Math.min(state.totalPages - 1, state.page + 1);
                }
            }

            await interaction.update({
                embeds: [await buildScheduleEmbed(state)],
                components: buildComponents(state)
            });
        } catch (error) {
            console.error('[nextmatch] collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Failed to update fixtures.',
                    ephemeral: true
                }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        await msg.edit({
            components: buildComponents(state, true)
        }).catch(() => null);
    });
}

async function buildState({
    guild,
    team,
    tournament,
    tournaments
}) {
    const tournamentTeam = await TournamentTeam.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        teamId: team._id,
        isActive: true
    }).lean();

    const fixtures = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        $or: [
            { homeTeamId: team._id },
            { awayTeamId: team._id },
            { homeTeam: team.name },
            { awayTeam: team.name }
        ]
    })
        .sort({
            matchNumber: 1,
            scheduledAt: 1
        })
        .lean();

    const nextIndex = fixtures.findIndex(f =>
        f.status === 'Pending' || f.status === 'Live'
    );

    const totalPages = Math.max(1, Math.ceil(fixtures.length / PAGE_SIZE));
    const initialPage = nextIndex >= 0 ? Math.floor(nextIndex / PAGE_SIZE) : 0;

    return {
        guild,
        team,
        tournament,
        tournamentTeam,
        tournaments,
        fixtures,
        page: Math.min(initialPage, totalPages - 1),
        totalPages
    };
}

/**
 * Find the team the command should show.
 *
 * With a team name → that team.
 * Without one → the team the user is on, using the SAME resolution as the
 * other commands: their team in the tournament (default first), then the
 * global player record, then any roster / captain entry. Checking only
 * `Player.teamId` is what used to make roster-only players look "unlinked".
 *
 * Returns { team, tournament } (tournament may be null).
 */
async function resolveTeamForUser({
    guild,
    userId,
    teamNameInput
}) {
    if (teamNameInput) {
        const team = await Team.findOne({
            guildId: guild.id,
            name: {
                $regex: new RegExp(`^${escapeRegex(teamNameInput.trim())}$`, 'i')
            }
        });

        return team ? { team, tournament: null } : null;
    }

    const resolved = await resolveUserTeam(guild.id, userId);

    if (!resolved?.team) return null;

    return { team: resolved.team, tournament: resolved.tournament || null };
}

async function buildScheduleEmbed(state) {
    const {
        page,
        totalPages,
        fixtures,
        team,
        tournament,
        tournamentTeam,
        guild
    } = state;

    const start = page * PAGE_SIZE;
    const currentFixtures = fixtures.slice(start, start + PAGE_SIZE);

    const stats = tournamentTeam?.stats || {};
    const gd = (stats.gf || 0) - (stats.ga || 0);
    const tournamentEmoji = tournament.emoji || '🏆';

    const nextPending = fixtures.find(f =>
        f.status === 'Pending' || f.status === 'Live'
    );

    const embed = new EmbedBuilder()
        .setColor(parseColor(team.color))
        .setTitle(`🗓️ ${team.name.toUpperCase()} — FIXTURES`)
        .setDescription(
            `${tournamentEmoji} **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `🏟️ **Stadium:** ${team.stadium || 'Home Ground'}\n` +
            `📊 **Record:** ${stats.wins || 0}W / ${stats.draws || 0}D / ${stats.losses || 0}L\n` +
            `⚽ **GD:** ${gd >= 0 ? '+' : ''}${gd} | **Pts:** ${stats.points || 0}`
        )
        .setFooter({
            text: `Page ${page + 1}/${totalPages} • Showing ${PAGE_SIZE} matches per page`
        })
        .setTimestamp();

    if (team.logoURL) {
        embed.setThumbnail(team.logoURL);
    } else if (guild.iconURL()) {
        embed.setThumbnail(guild.iconURL());
    }

    if (!fixtures.length) {
        embed.addFields({
            name: '📅 Fixtures',
            value: 'No fixtures found for this team in this tournament.',
            inline: false
        });

        return embed;
    }

    if (nextPending) {
        const opponent = nextPending.homeTeam === team.name
            ? nextPending.awayTeam
            : nextPending.homeTeam;

        const opponentTeam = await Team.findOne({
            guildId: guild.id,
            name: {
                $regex: new RegExp(`^${escapeRegex(opponent)}$`, 'i')
            }
        });

        embed.addFields({
            name: '⏭️ Next Match',
            value:
                `**${nextPending.homeTeam} vs ${nextPending.awayTeam}**\n` +
                `🏷️ ${nextPending.roundLabel || prettyPhase(nextPending.phase)}\n` +
                `👑 Opp. Captain: ${opponentTeam?.captainID ? `<@${opponentTeam.captainID}>` : 'Not Assigned'}\n` +
                `📍 Status: **${nextPending.status}**`,
            inline: false
        });
    } else {
        embed.addFields({
            name: '⏭️ Next Match',
            value: '✅ All scheduled matches are completed.',
            inline: false
        });
    }

    embed.addFields({
        name: `📅 Matches ${start + 1}-${Math.min(start + PAGE_SIZE, fixtures.length)} of ${fixtures.length}`,
        value: currentFixtures.map((fixture, index) => {
            const globalIndex = start + index + 1;
            return buildFixtureLine(fixture, globalIndex, team.name);
        }).join('\n\n'),
        inline: false
    });

    return embed;
}

function buildComponents(state, disabled = false) {
    return [
        buildTournamentDropdown(state.tournaments, state.tournament.tournamentKey, disabled),
        buildButtons(state, disabled)
    ];
}

function buildTournamentDropdown(tournaments, selectedKey, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('nm_tournament')
            .setPlaceholder('Select tournament')
            .setDisabled(disabled)
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

function buildButtons(state, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('nm_prev')
            .setLabel('⬅️ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || state.page <= 0),

        new ButtonBuilder()
            .setCustomId('nm_next')
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || state.page >= state.totalPages - 1)
    );
}

function buildFixtureLine(fixture, index, teamName) {
    const isCompleted = fixture.status === 'Played';
    const isLive = fixture.status === 'Live';
    const isHome = fixture.homeTeam === teamName;

    const statusEmoji = isCompleted ? '✅' : isLive ? '🔴' : '⏳';
    const sideEmoji = isHome ? '🏠' : '✈️';

    let score = '';

    if (isCompleted) {
        const home = fixture.result?.home ?? '-';
        const away = fixture.result?.away ?? '-';
        score = ` — **${home}-${away}**`;
    }

    return (
        `${statusEmoji} **#${index} • ${fixture.roundLabel || prettyPhase(fixture.phase)}**\n` +
        `${sideEmoji} **${fixture.homeTeam} vs ${fixture.awayTeam}**${score}\n` +
        `📍 ${fixture.status}`
    );
}



function parseColor(color) {
    if (!color) return 0xFEBE10;

    const cleaned = String(color).trim().replace('#', '');

    if (/^[0-9A-Fa-f]{6}$/.test(cleaned)) {
        return parseInt(cleaned, 16);
    }

    return 0xFEBE10;
}

function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 3) + '...' : value;
}

