/**
 * finishdraw.js
 *
 * Finish an active manual draw session and generate fixtures.
 * Supports group stage (round-robin) and knockout bracket draws.
 * Validates group sizes, checks for existing fixtures, and generates
 * match documents with proper numbering.
 *
 * Usage:  .finishdraw [key] [--force]
 * Slash:  /finishdraw [key] [force]
 *
 * Aliases: enddraw, closedraw
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Fixture, TournamentTeam } = require('../../models/Tournament');
const {
    getDrawKey,
    updatePublicDrawBoard,
    prettyPhase
} = require('../../utils/drawBoard');
const { getDefaultTournament, getTournamentByKey } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { vsLine } = require('../../utils/ai/emojiSlots');
const {
    buildRoundRobinFixtures,
    buildKnockoutFixtures,
    getNextMatchNumber
} = require('../../utils/fixtureBuilder');

module.exports = {
    name: 'finishdraw',
    description: 'Finish the active draw and generate fixtures.',
    usage: '.finishdraw [tournamentKey] [--force]',
    aliases: ['enddraw', 'closedraw'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('finishdraw')
        .setDescription('Finish the active draw and generate fixtures')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key')
                .setRequired(false)
        )
        .addBooleanOption(opt =>
            opt.setName('force')
                .setDescription('Force finish even if validation is not fully satisfied')
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

            const parsed = parsePrefixArgs(args);

            return await runFinishDraw({
                client: message.client,
                guild: message.guild,
                userId: message.author.id,
                key: parsed.key,
                force: parsed.force,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[finishdraw] prefix error:', error);
            return message.reply('❌ Failed to finish draw.');
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

            return await runFinishDraw({
                client: interaction.client,
                guild: interaction.guild,
                userId: interaction.user.id,
                key: interaction.options.getString('key')?.toLowerCase() || null,
                force: interaction.options.getBoolean('force') ?? false,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[finishdraw] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to finish draw.');
            }

            return interaction.reply({ content: '❌ Failed to finish draw.', ephemeral: true });
        }
    }
};

/* ====================================================
   PREFIX ARG PARSER
==================================================== */

/** Parse prefix args: [key] [--force] */
function parsePrefixArgs(args) {
    let key = null;
    let force = false;

    for (const arg of args) {
        if (arg === '--force') force = true;
        else if (!key) key = arg.toLowerCase();
    }

    return { key, force };
}

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Finish an active draw session.
 * Routes to group or knockout finishing based on session stage.
 */
async function runFinishDraw({ client, guild, userId, key, force, reply }) {
    /* ── Resolve tournament ── */
    const tournament = key
        ? await getTournamentByKey(guild.id, key)
        : await getDefaultTournament(guild.id);

    if (!tournament) {
        return reply({ content: '❌ Tournament not found.' });
    }

    /* ── Validate active draw session ── */
    const drawKey = getDrawKey(guild.id);
    const session = client.liveSettings.get(drawKey);

    if (!session || session.type !== 'manual_draw') {
        return reply({ content: '❌ No active draw session found.' });
    }

    // Ensure the draw belongs to the correct tournament
    if (session.tournamentKey && session.tournamentKey !== tournament.tournamentKey) {
        return reply({
            content: `❌ Active draw belongs to \`${session.tournamentKey}\`, not \`${tournament.tournamentKey}\`.`
        });
    }

    // Only the starter can finish (unless forced)
    if (session.startedBy !== userId && !force) {
        return reply({
            content:
                '🚫 Only the organizer who started the draw can finish it.\n' +
                'Use `--force` only if intentional.'
        });
    }

    /* ── Route to appropriate finisher ── */
    if (session.stage === 'groups') {
        return finishGroupDraw({ client, guild, drawKey, session, tournament, force, reply });
    }

    if (session.stage === 'knockout') {
        return finishKnockoutDraw({ client, guild, drawKey, session, tournament, force, reply });
    }

    return reply({ content: '❌ Unknown draw stage.' });
}

/* ====================================================
   GROUP DRAW FINISH
==================================================== */

/**
 * Validate group sizes, then generate round-robin fixtures
 * for each group and persist them.
 */
async function finishGroupDraw({ client, guild, drawKey, session, tournament, force, reply }) {
    /* ── Validate group sizes ── */
    const validation = validateGroupDraw(session);

    if (!validation.ok && !force) {
        return reply({
            content: `❌ ${validation.error}\nUse \`--force\` only if intentional.`
        });
    }

    /* ── Check for existing group fixtures ── */
    const existingCount = await Fixture.countDocuments({
        guildId: guild.id,
        tournamentId: tournament._id,
        phase: 'group'
    });

    if (existingCount > 0 && !force) {
        return reply({
            content:
                `❌ Group fixtures already exist for \`${tournament.tournamentKey}\` ` +
                `(**${existingCount}** found).\n` +
                `Use \`--force\` to regenerate.`
        });
    }

    // Clear existing if forcing
    if (existingCount > 0 && force) {
        await Fixture.deleteMany({
            guildId: guild.id,
            tournamentId: tournament._id,
            phase: 'group'
        });
    }

    /* ── Generate fixtures for each group ── */
    const fixtures = [];
    let nextMatchNumber = await getNextMatchNumber(guild.id, tournament._id);

    for (const [groupKey, drawnTeams] of Object.entries(session.groups || {})) {
        if (drawnTeams.length < 2) continue;

        const tournamentTeams = [];

        for (const drawnTeam of drawnTeams) {
            const entry = await resolveTournamentTeamFromDraw({
                guildId: guild.id,
                tournamentId: tournament._id,
                drawnTeam,
                groupKey
            });

            if (entry) tournamentTeams.push(entry);
        }

        if (tournamentTeams.length < 2) continue;

        const groupFixtures = buildRoundRobinFixtures({
            guildId: guild.id,
            tournament,
            teams: tournamentTeams,
            phase: 'group',
            roundPrefix: `Group ${groupKey} Matchday`,
            groupKey,
            homeAway: tournament.homeAway,
            startMatchNumber: nextMatchNumber
        });

        nextMatchNumber += groupFixtures.length;
        fixtures.push(...groupFixtures);
    }

    if (!fixtures.length) {
        return reply({ content: '❌ No group fixtures could be generated from this draw.' });
    }

    /* ── Persist fixtures ── */
    await Fixture.insertMany(fixtures);

    /* ── Mark session as completed ── */
    session.status = 'completed';
    session.completedAt = Date.now();
    session.completionNotes = {
        fixtureCount: fixtures.length,
        stage: 'groups',
        tournamentKey: tournament.tournamentKey
    };

    await updatePublicDrawBoard(client, session).catch(() => null);
    client.liveSettings.set(drawKey, session);

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('✅ GROUP DRAW FINISHED')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Generated group fixtures successfully.`
        )
        .addFields(
            {
                name: 'Groups',
                value:
                    Object.entries(session.groups || {})
                        .map(([group, teams]) => `**Group ${group}:** ${teams.length} teams`)
                        .join('\n') || 'None',
                inline: false
            },
            { name: 'Fixtures Generated', value: `**${fixtures.length}**`, inline: true }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   KNOCKOUT DRAW FINISH
==================================================== */

/**
 * Generate knockout fixtures from the draw session's pairing data.
 * Supports two-legged ties based on tournament config.
 */
async function finishKnockoutDraw({ client, guild, drawKey, session, tournament, force, reply }) {
    const pairs = session.knockoutPairs || [];

    if (!pairs.length) {
        return reply({ content: '❌ No knockout pairings found.' });
    }

    const phase = session.knockoutPhase || 'quarterfinal';

    /* ── Check for existing fixtures in this phase ── */
    const existingCount = await Fixture.countDocuments({
        guildId: guild.id,
        tournamentId: tournament._id,
        phase
    });

    if (existingCount > 0 && !force) {
        return reply({
            content:
                `❌ ${prettyPhase(phase)} fixtures already exist ` +
                `(**${existingCount}** found).\n` +
                `Use \`--force\` to regenerate.`
        });
    }

    if (existingCount > 0 && force) {
        await Fixture.deleteMany({
            guildId: guild.id,
            tournamentId: tournament._id,
            phase
        });
    }

    /* ── Resolve teams from draw entries ── */
    const resolvedPairs = [];

    for (const pair of pairs) {
        const home = await resolveTournamentTeamFromDraw({
            guildId: guild.id,
            tournamentId: tournament._id,
            drawnTeam: pair.home
        });

        const away = await resolveTournamentTeamFromDraw({
            guildId: guild.id,
            tournamentId: tournament._id,
            drawnTeam: pair.away
        });

        if (!home || !away) continue;
        resolvedPairs.push([home, away]);
    }

    if (!resolvedPairs.length) {
        return reply({ content: '❌ Could not resolve tournament teams from knockout draw.' });
    }

    /* ── Build fixture documents ── */
    const isTwoLegged =
        Array.isArray(tournament.twoLeggedRounds) &&
        tournament.twoLeggedRounds.includes(phase);

    const fixtures = buildKnockoutFixtures({
        guildId: guild.id,
        tournament,
        phase,
        pairs: resolvedPairs,
        twoLegged: isTwoLegged,
        startMatchNumber: await getNextMatchNumber(guild.id, tournament._id)
    });

    await Fixture.insertMany(fixtures);

    /* ── Mark session as completed ── */
    session.status = 'completed';
    session.completedAt = Date.now();
    session.completionNotes = {
        fixtureCount: fixtures.length,
        stage: 'knockout',
        tournamentKey: tournament.tournamentKey
    };

    await updatePublicDrawBoard(client, session).catch(() => null);
    client.liveSettings.set(drawKey, session);

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🏆 KNOCKOUT DRAW FINISHED')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Generated ${prettyPhase(phase)} fixtures successfully.`
        )
        .addFields(
            {
                name: 'Pairings',
                value:
                    resolvedPairs
                        .map(([h, a]) =>
                            `• ${vsLine(h.teamId?.name || h.teamNameSnapshot, a.teamId?.name || a.teamNameSnapshot, guild.id)}`
                        )
                        .join('\n') || 'None',
                inline: false
            },
            { name: 'Fixtures Generated', value: `**${fixtures.length}**`, inline: true }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   FIXTURE BUILDING HELPERS
==================================================== */

/** Validate that group sizes are balanced (max difference of 1). */
function validateGroupDraw(session) {
    const groups = session.groups || {};
    const sizes = Object.values(groups).map(v => v.length);

    if (!sizes.length) {
        return { ok: false, error: 'No groups found in draw session.' };
    }

    const min = Math.min(...sizes);
    const max = Math.max(...sizes);

    if (max - min > 1) {
        return { ok: false, error: 'Group sizes are uneven.' };
    }

    return { ok: true };
}

/**
 * Resolve a drawn team entry into a TournamentTeam with populated team data.
 * Optionally assigns a group key to the TournamentTeam.
 */
async function resolveTournamentTeamFromDraw({ guildId, tournamentId, drawnTeam, groupKey = null }) {
    const teamId = drawnTeam.teamId || drawnTeam._id || drawnTeam.id;
    if (!teamId) return null;

    const entry = await TournamentTeam.findOne({
        guildId,
        tournamentId,
        teamId,
        isActive: true
    }).populate('teamId');

    if (!entry) return null;

    // Assign group if provided (group draw)
    if (groupKey) {
        entry.groupKey = groupKey;
        await entry.save();
    }

    return {
        _id: entry._id,
        tournamentTeamId: entry._id,
        teamId: entry.teamId?._id || entry.teamId,
        teamNameSnapshot: entry.teamId?.name || entry.teamNameSnapshot,
        name: entry.teamId?.name || entry.teamNameSnapshot
    };
}
