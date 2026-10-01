/**
 * autofixtures.js
 *
 * Auto-generate round-robin fixtures for a tournament.
 * Supports league format and group stage format with optional home & away.
 *
 * Group auto-assignment: Only shuffles teams into groups on FIRST assignment.
 * Using --force deletes fixtures but preserves existing group assignments.
 *
 * Usage: .autofixtures <tournamentKey> [--force]
 * Slash: /autofixtures key:<key> force:<bool>
 *
 * Aliases: generatefixtures, fixturesauto
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Fixture,
    TournamentSettings,
    TournamentTeam
} = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { buildRoundRobinFixtures, getNextMatchNumber } = require('../../utils/fixtureBuilder');

module.exports = {
    name: 'autofixtures',
    description: 'Auto-generate fixtures for a specific tournament.',
    usage: '.autofixtures [tournamentKey] [--force]',
    aliases: ['generatefixtures', 'fixturesauto'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('autofixtures')
        .setDescription('Auto-generate tournament fixtures')
        .addBooleanOption(opt =>
            opt.setName('force')
                .setDescription('Delete existing fixtures and regenerate')
                .setRequired(false)
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
                return message.reply('🚫 You are not authorized to use this command.');
            }

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args);
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const force = args.includes('--force');

            return await runAutoFixtures({
                guild: message.guild,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                force,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[autofixtures] prefix error:', error);
            return message.reply('❌ Failed to generate fixtures.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 You are not authorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runAutoFixtures({
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                force: interaction.options.getBoolean('force') ?? false,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[autofixtures] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to generate fixtures.');
            }

            return interaction.reply({ content: '❌ Failed to generate fixtures.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Generate fixtures for a tournament.
 *
 * Group assignment logic:
 *   - If groups are enabled and teams have NO group assignments yet,
 *     auto-shuffle teams into groups using snake draft.
 *   - If teams already have group assignments, keep them.
 *   - --force only deletes fixtures, does NOT reshuffle groups.
 */
async function runAutoFixtures({ guild, tournamentKey, force, reply }) {
    // ── Find tournament ──
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    // ── Check existing fixtures ──
    const existingCount = await Fixture.countDocuments({
        guildId: guild.id,
        tournamentId: tournament._id
    });

    if (existingCount > 0 && !force) {
        return reply({
            content:
                `⚠️ Fixtures already exist for **${tournament.name}**: **${existingCount}**\n\n` +
                `Use \`.autofixtures ${tournamentKey} --force\` or slash \`force:true\` to regenerate.`
        });
    }

    // ── Delete existing if forced ──
    if (existingCount > 0 && force) {
        await Fixture.deleteMany({
            guildId: guild.id,
            tournamentId: tournament._id
        });
    }

    // ── Load tournament teams ──
    let tournamentTeams = await TournamentTeam.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        isActive: true
    }).populate('teamId').sort({ createdAt: 1 });

    if (tournamentTeams.length < 2) {
        return reply({ content: '❌ At least 2 active teams are required in this tournament.' });
    }

    const homeAway = tournament.homeAway === true;
    const groupCount = tournament.groupCount || 0;

    // ── Auto-assign groups ONLY if teams have no assignments yet ──
    if (groupCount > 0) {
        const teamsWithoutGroups = tournamentTeams.filter(
            tt => !String(tt.groupKey || '').trim()
        );

        if (teamsWithoutGroups.length === tournamentTeams.length) {
            // All teams need groups — do the shuffle
            await autoAssignGroups(guild.id, tournament._id, tournamentTeams, groupCount);

            // Reload with fresh group assignments
            tournamentTeams = await TournamentTeam.find({
                guildId: guild.id,
                tournamentId: tournament._id,
                isActive: true
            }).populate('teamId').sort({ createdAt: 1 });
        }
        // If some teams have groups and some don't, leave them as-is
    }

    // ── Generate fixtures ──
    let nextMatchNumber = 1;
    const fixturesToCreate = [];

    if (groupCount > 0) {
        const groupKeys = Array.from(
            { length: groupCount },
            (_, i) => String.fromCharCode(65 + i)
        );

        for (const groupKey of groupKeys) {
            const groupTeams = tournamentTeams.filter(tt => tt.groupKey === groupKey);

            if (groupTeams.length < 2) continue;

            const groupFixtures = buildRoundRobinFixtures({
                guildId: guild.id,
                tournament,
                teams: normalizeTeams(groupTeams),
                phase: 'group',
                roundPrefix: `Group ${groupKey} Matchday`,
                groupKey,
                homeAway,
                startMatchNumber: nextMatchNumber
            });

            nextMatchNumber += groupFixtures.length;
            fixturesToCreate.push(...groupFixtures);
        }
    } else {
        const leagueFixtures = buildRoundRobinFixtures({
            guildId: guild.id,
            tournament,
            teams: normalizeTeams(tournamentTeams),
            phase: 'league',
            roundPrefix: 'Matchday',
            groupKey: null,
            homeAway,
            startMatchNumber: nextMatchNumber
        });

        fixturesToCreate.push(...leagueFixtures);
    }

    if (!fixturesToCreate.length) {
        return reply({
            content:
                '❌ No fixtures were generated.\n\n' +
                'Possible reasons:\n' +
                '• Groups are enabled but teams do not have group keys\n' +
                '• Each group has less than 2 active teams\n' +
                '• Tournament setup is incomplete'
        });
    }

    // ── Save fixtures ──
    await Fixture.insertMany(fixturesToCreate);

    // ── Update tournament phase ──
    await TournamentSettings.updateOne(
        { guildId: guild.id, tournamentKey },
        {
            $set: {
                currentPhase: groupCount > 0 ? 'groups' : 'league',
                teamCount: tournamentTeams.length
            }
        }
    );

    // ── Response ──
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('📅 FIXTURES GENERATED')
        .setDescription(
            `Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Created **${fixturesToCreate.length}** fixture(s).\n` +
            `Teams used: **${tournamentTeams.length}**\n` +
            `Format: **${groupCount > 0 ? 'Group Stage' : 'League'}**\n` +
            `Home & Away: **${homeAway ? 'Yes' : 'No'}**`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   GROUP AUTO-ASSIGNMENT
==================================================== */

/**
 * Auto-assign teams to groups using snake draft distribution.
 * Only called when NO teams have group assignments yet.
 */
async function autoAssignGroups(guildId, tournamentId, teams, groupCount) {
    const groupKeys = Array.from(
        { length: groupCount },
        (_, i) => String.fromCharCode(65 + i)
    );

    // Shuffle teams randomly
    const shuffled = [...teams].sort(() => Math.random() - 0.5);

    // Snake draft: 0,1,2,3,2,1,0,1,2,...
    let direction = 1;
    let groupIndex = 0;

    for (const team of shuffled) {
        const groupKey = groupKeys[groupIndex];

        await TournamentTeam.updateOne(
            { _id: team._id },
            { $set: { groupKey } }
        );

        groupIndex += direction;

        if (groupIndex >= groupKeys.length) {
            groupIndex = groupKeys.length - 1;
            direction = -1;
        } else if (groupIndex < 0) {
            groupIndex = 0;
            direction = 1;
        }
    }
}

/* ====================================================
   TEAM NORMALIZATION
==================================================== */

/**
 * Normalize TournamentTeam documents to the format expected by shared fixture builders.
 * { tournamentTeamId, teamId, name }
 */
function normalizeTeams(tournamentTeams) {
    return tournamentTeams.map(entry => ({
        tournamentTeamId: entry._id,
        teamId: entry.teamId?._id || entry.teamId,
        name: entry.teamId?.name || entry.teamNameSnapshot
    }));
}
