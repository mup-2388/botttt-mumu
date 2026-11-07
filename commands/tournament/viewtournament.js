/**
 * viewtournament.js
 *
 * View tournament configuration and progress.
 * Interactive dropdown to switch between tournaments.
 *
 * Usage:  .viewtournament
 * Slash:  /viewtournament
 * Aliases: vt, tournamentinfo, viewtour
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder
} = require('discord.js');

const {
    TournamentTeam,
    TournamentPlayer,
    Fixture
} = require('../../models/Tournament');

const {
    getDefaultTournament,
    getSelectableTournaments,
    getTournamentByKey
} = require('../../utils/getTournament');

const { isOrganizer } = require('../../utils/isOrganizer');

module.exports = {
    name: 'viewtournament',
    description: 'View tournament configuration and progress.',
    usage: '.viewtournament',
    aliases: ['vt', 'tournamentinfo', 'viewtour'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('viewtournament')
        .setDescription('View tournament overview'),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            return await runViewTournament({
                guild: message.guild,
                userId: message.author.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[viewtournament] prefix error:', error);
            return message.reply('❌ Failed to load tournament overview.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 Unauthorized.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runViewTournament({
                guild: interaction.guild,
                userId: interaction.user.id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[viewtournament] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to load tournament overview.');
            }

            return interaction.reply({
                content: '❌ Failed to load tournament overview.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

async function runViewTournament({ guild, userId, reply }) {
    const tournaments = await getSelectableTournaments(guild.id);

    if (!tournaments.length) {
        return reply({ content: '📭 No active tournaments found.' });
    }

    let tournament = await getDefaultTournament(guild.id);
    if (!tournament) tournament = tournaments[0];

    const msg = await reply(await buildPayload(guild, tournament, tournaments));

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

            if (interaction.isStringSelectMenu() && interaction.customId === 'vt_tournament') {
                const selected = await getTournamentByKey(guild.id, interaction.values[0]);
                if (selected) tournament = selected;
            }

            await interaction.update(await buildPayload(guild, tournament, tournaments));
        } catch (error) {
            console.error('[viewtournament] collector error:', error);
        }
    });

    collector.on('end', async () => {
        await msg.edit({ components: [] }).catch(() => null);
    });
}

/* ====================================================
   PAYLOAD BUILDER
==================================================== */

async function buildPayload(guild, tournament, tournaments) {
    const [teamCount, playerCount, fixtures] = await Promise.all([
        TournamentTeam.countDocuments({
            guildId: guild.id,
            tournamentId: tournament._id,
            isActive: true
        }),
        TournamentPlayer.countDocuments({
            guildId: guild.id,
            tournamentId: tournament._id,
            isActive: true
        }),
        Fixture.find({
            guildId: guild.id,
            tournamentId: tournament._id
        }).lean()
    ]);

    const fixtureCounts = buildFixtureCounts(fixtures);

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`${tournament.emoji || '🏆'} TOURNAMENT OVERVIEW`)
        .setDescription(
            `**${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Format: **${tournament.formatType === 'glory_cup' ? 'Glory Cup — Single Table + Top 8 Playoffs' : tournament.formatType}**\n` +
            `Mode: **${tournament.schedulingMode}**\n` +
            `Current Phase: **${tournament.currentPhase}**\n` +
            `Registration Open: **${tournament.registrationOpen ? 'Yes' : 'No'}**`
        )
        .addFields(
            {
                name: 'Teams / Players',
                value:
                    `Teams: **${teamCount}** / Target: **${tournament.teamCount || 0}**\n` +
                    `Players: **${playerCount}**`,
                inline: true
            },
            {
                name: 'Groups',
                value:
                    `Count: **${tournament.groupCount || 0}**\n` +
                    `Teams / Group: **${tournament.teamsPerGroup || 0}**`,
                inline: true
            },
            {
                name: 'Points System',
                value:
                    `Win: **${tournament.pointsWin}**\n` +
                    `Draw: **${tournament.pointsDraw}**\n` +
                    `Loss: **${tournament.pointsLoss}**`,
                inline: true
            },
            {
                name: 'Knockouts',
                value:
                    `Enabled: **${tournament.hasKnockout ? 'Yes' : 'No'}**\n` +
                    `Rounds: **${formatArray(tournament.knockoutRounds)}**\n` +
                    `Two-Legged: **${formatArray(tournament.twoLeggedRounds)}**`,
                inline: false
            },
            {
                name: 'Fixtures',
                value: fixtureCounts,
                inline: false
            }
        )
        .setTimestamp();

    return {
        embeds: [embed],
        components: [buildTournamentDropdown(tournaments, tournament.tournamentKey)]
    };
}

/* ====================================================
   COMPONENT BUILDERS
==================================================== */

function buildTournamentDropdown(tournaments, selectedKey) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('vt_tournament')
            .setPlaceholder('Select tournament')
            .addOptions(
                tournaments.slice(0, 25).map(t => ({
                    label: truncate(t.name || t.tournamentKey, 80),
                    description: `Key: ${t.tournamentKey}`,
                    value: t.tournamentKey,
                    default: t.tournamentKey === selectedKey
                }))
            )
    );
}

/* ====================================================
   HELPERS
==================================================== */

function buildFixtureCounts(fixtures) {
    if (!fixtures.length) return 'No fixtures generated yet.';

    const pending = fixtures.filter(f => f.status === 'Pending').length;
    const live = fixtures.filter(f => f.status === 'Live').length;
    const played = fixtures.filter(f => f.status === 'Played').length;
    const cancelled = fixtures.filter(f => f.status === 'Cancelled').length;

    return (
        `Total: **${fixtures.length}**\n` +
        `Pending: **${pending}**\n` +
        `Live: **${live}**\n` +
        `Played: **${played}**\n` +
        `Cancelled: **${cancelled}**`
    );
}

function formatArray(arr) {
    if (!Array.isArray(arr) || !arr.length) return 'None';
    return arr.join(', ');
}

function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 3) + '...' : value;
}
