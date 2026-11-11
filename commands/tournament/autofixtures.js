/**
 * autofixtures.js
 *
 * Auto-generate fixtures for a tournament. League and group formats use
 * round robins, Glory Cup uses one qualifier match per team, and straight
 * knockout starts at the opening round for the registered field.
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
const {
    buildRoundRobinFixtures,
    buildOneMatchPerTeamFixtures,
    buildKnockoutFixtures,
    buildStandardKnockoutPairs,
    getKnockoutRounds
} = require('../../utils/fixtureBuilder');

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
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;
    const isGloryCup = tournament.formatType === 'glory_cup';
    const isStraightKnockout = tournament.formatType === 'knockout';
    const existingCount = await Fixture.countDocuments({
        guildId: guild.id,
        tournamentId: tournament._id
    });

    if (existingCount > 0 && !force) {
        return reply({
            content:
                `⚠️ Fixtures already exist for **${tournament.name}**: **${existingCount}**\n\n` +
                `Use \`.autofixtures ${tournament.tournamentKey} --force\` or slash \`force:true\` to regenerate.`
        });
    }

    const tournamentTeams = await TournamentTeam.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        isActive: true
    }).populate('teamId').sort({ createdAt: 1 });

    if (tournamentTeams.length < 2) {
        return reply({ content: '❌ At least 2 active teams are required in this tournament.' });
    }

    const knockoutRounds = isStraightKnockout
        ? getKnockoutRounds(tournamentTeams.length)
        : [];

    if (isStraightKnockout && !knockoutRounds.length) {
        return reply({
            content:
                `❌ Straight knockout needs a power-of-two field of 2–16 active teams ` +
                `(2, 4, 8, or 16); found **${tournamentTeams.length}**. No fixtures were changed.`
        });
    }

    if (isGloryCup && tournamentTeams.length < 8) {
        return reply({
            content: `❌ Glory Cup needs at least 8 active teams for its top-eight playoffs; found **${tournamentTeams.length}**. No fixtures were changed.`
        });
    }

    if (isGloryCup && tournamentTeams.length % 2 !== 0) {
        return reply({
            content: `❌ Glory Cup's one-match qualifier needs an even number of active teams so every team plays exactly once; found **${tournamentTeams.length}**. No fixtures were changed.`
        });
    }

    if ((isGloryCup || isStraightKnockout) && existingCount > 0 && force) {
        const inProgressCount = await Fixture.countDocuments({
            guildId: guild.id,
            tournamentId: tournament._id,
            status: { $in: ['Played', 'Live'] }
        });

        if (inProgressCount > 0) {
            const formatLabel = isGloryCup ? 'Glory Cup' : 'Straight knockout';
            return reply({
                content: `❌ ${formatLabel} fixtures were not replaced because **${inProgressCount}** match(es) are live or played. No fixtures were deleted.`
            });
        }
    }

    const homeAway = !isGloryCup && !isStraightKnockout && tournament.homeAway === true;
    const groupCount = isGloryCup || isStraightKnockout ? 0 : (tournament.groupCount || 0);

    // Auto-assign groups only for group-based formats, and only if no teams
    // have assignments yet. Glory Cup is always a flat qualifier table.
    let fixtureTeams = tournamentTeams;
    if (groupCount > 0) {
        const teamsWithoutGroups = tournamentTeams.filter(tt => !String(tt.groupKey || '').trim());

        if (teamsWithoutGroups.length === tournamentTeams.length) {
            await autoAssignGroups(guild.id, tournament._id, tournamentTeams, groupCount);
            fixtureTeams = await TournamentTeam.find({
                guildId: guild.id,
                tournamentId: tournament._id,
                isActive: true
            }).populate('teamId').sort({ createdAt: 1 });
        }
    }

    const fixturesToCreate = [];

    if (isStraightKnockout) {
        const normalizedTeams = normalizeTeams(fixtureTeams);
        const firstRound = knockoutRounds[0];
        const pairs = buildStandardKnockoutPairs(normalizedTeams);

        fixturesToCreate.push(...buildKnockoutFixtures({
            guildId: guild.id,
            tournament,
            phase: firstRound,
            pairs,
            twoLegged: false,
            startMatchNumber: 1
        }));
    } else if (isGloryCup) {
        fixturesToCreate.push(...buildOneMatchPerTeamFixtures({
            guildId: guild.id,
            tournament,
            teams: normalizeTeams(fixtureTeams),
            phase: 'league',
            roundLabel: 'Matchday 1',
            startMatchNumber: 1
        }));
    } else if (groupCount > 0) {
        const groupKeys = Array.from(
            { length: groupCount },
            (_, i) => String.fromCharCode(65 + i)
        );

        let nextMatchNumber = 1;
        for (const groupKey of groupKeys) {
            const groupTeams = fixtureTeams.filter(tt => tt.groupKey === groupKey);
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
        fixturesToCreate.push(...buildRoundRobinFixtures({
            guildId: guild.id,
            tournament,
            teams: normalizeTeams(fixtureTeams),
            phase: 'league',
            roundPrefix: 'Matchday',
            groupKey: null,
            homeAway,
            startMatchNumber: 1
        }));
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

    // Keep current fixtures until the replacement schedule is fully validated.
    if (existingCount > 0 && force) {
        await Fixture.deleteMany({
            guildId: guild.id,
            tournamentId: tournament._id
        });
    }

    await Fixture.insertMany(fixturesToCreate);

    const settingsUpdate = {
        currentPhase: isStraightKnockout ? 'knockout' : groupCount > 0 ? 'groups' : 'league',
        teamCount: fixtureTeams.length
    };
    if (isStraightKnockout) {
        Object.assign(settingsUpdate, {
            groupCount: 0,
            teamsPerGroup: 0,
            homeAway: false,
            hasKnockout: true,
            knockoutRounds,
            twoLeggedRounds: []
        });
    }
    if (isGloryCup) {
        Object.assign(settingsUpdate, {
            groupCount: 0,
            teamsPerGroup: 0,
            homeAway: false,
            qualificationSpotsPerGroup: 8,
            uclQualificationSpots: 0,
            hasKnockout: true,
            knockoutRounds: ['quarterfinal', 'semifinal', 'final']
        });
    }

    await TournamentSettings.updateOne(
        { guildId: guild.id, tournamentKey: tournament.tournamentKey },
        { $set: settingsUpdate }
    );

    const formatDescription = isStraightKnockout
        ? `Straight Knockout — ${knockoutRounds[0] === 'roundof16' ? 'Round of 16' : knockoutRounds[0]}`
        : isGloryCup
            ? 'One-match qualifier — one match per team; top 8 advance to playoffs'
            : groupCount > 0 ? 'Group Stage' : 'League';
    const replacementLine = existingCount > 0 && force
        ? `Replaced **${existingCount}** old fixture(s); registered teams and rosters were preserved.\n`
        : '';

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('📅 FIXTURES GENERATED')
        .setDescription(
            `Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            replacementLine +
            `Created **${fixturesToCreate.length}** fixture(s).\n` +
            `Teams used: **${fixtureTeams.length}**\n` +
            `Format: **${formatDescription}**\n` +
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
