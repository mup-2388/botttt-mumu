/**
 * generatestage.js
 *
 * Generate league, group, or knockout fixtures for a tournament.
 * Validates teams, checks for existing fixtures, and creates match documents.
 *
 * Usage:  .generatestage [key] <league|groups|knockout> [--force]
 * Slash:  /generatestage stage:<stage> [key] [force]
 *
 * Aliases: genstage, gst
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Fixture, TournamentTeam } = require('../../models/Tournament');
const { getDefaultTournament, getTournamentByKey } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { prettyPhase } = require('../../utils/displayHelpers');
const { buildRoundRobinFixtures, buildKnockoutFixtures, getNextMatchNumber } = require('../../utils/fixtureBuilder');

module.exports = {
    name: 'generatestage',
    description: 'Generate league, group, or knockout fixtures for a tournament.',
    usage: '.generatestage [key] <league|groups|knockout> [--force]',
    aliases: ['genstage', 'gst'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('generatestage')
        .setDescription('Generate tournament stage')
        .addStringOption(opt =>
            opt.setName('stage')
                .setDescription('Stage to generate')
                .setRequired(true)
                .addChoices(
                    { name: 'League', value: 'league' },
                    { name: 'Groups', value: 'groups' },
                    { name: 'Knockout', value: 'knockout' }
                )
        )
        .addBooleanOption(opt =>
            opt.setName('force')
                .setDescription('Regenerate existing fixtures')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key (default: the default tournament)')
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
            if (!parsed.ok) return message.reply(parsed.error);

            return await runGenerate({
                guild: message.guild,
                ...parsed,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[generatestage] prefix error:', error);
            return message.reply('❌ Failed to generate stage.');
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

            return await runGenerate({
                guild: interaction.guild,
                key: interaction.options.getString('key')?.toLowerCase() || null,
                stage: interaction.options.getString('stage'),
                force: interaction.options.getBoolean('force') ?? false,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[generatestage] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to generate stage.');
            }

            return interaction.reply({ content: '❌ Failed to generate stage.', ephemeral: true });
        }
    }
};

/* ====================================================
   PREFIX ARG PARSER
==================================================== */

function parsePrefixArgs(args) {
    let key = null;
    let stage = null;
    let force = false;

    for (const arg of args) {
        if (arg === '--force') force = true;
        else if (['league', 'groups', 'knockout'].includes(arg.toLowerCase())) stage = arg.toLowerCase();
        else if (!key) key = arg.toLowerCase();
    }

    if (!stage) {
        return {
            ok: false,
            error: '❌ Usage: `.generatestage [key] <league|groups|knockout> [--force]`'
        };
    }

    return { ok: true, key, stage, force };
}

/* ====================================================
   CORE LOGIC
==================================================== */

/** Route to the appropriate generator based on stage type. */
async function runGenerate({ guild, key, stage, force, reply }) {
    const tournament = key
        ? await getTournamentByKey(guild.id, key)
        : await getDefaultTournament(guild.id);

    if (!tournament) return reply({ content: '❌ Tournament not found.' });

    const teams = await TournamentTeam.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        isActive: true
    }).populate('teamId').sort({ createdAt: 1 });

    if (teams.length < 2) {
        return reply({ content: '❌ At least 2 active teams are required.' });
    }

    if (stage === 'league') return generateLeague({ guild, tournament, teams, force, reply });
    if (stage === 'groups') return generateGroups({ guild, tournament, teams, force, reply });
    if (stage === 'knockout') return generateKnockout({ guild, tournament, teams, force, reply });

    return reply({ content: '❌ Unknown stage type.' });
}

/* ====================================================
   LEAGUE GENERATOR
==================================================== */

async function generateLeague({ guild, tournament, teams, force, reply }) {
    const existing = await Fixture.countDocuments({
        guildId: guild.id,
        tournamentId: tournament._id,
        phase: 'league'
    });

    if (existing && !force) {
        return reply({
            content: `❌ League fixtures already exist: **${existing}**. Use \`--force\` to regenerate.`
        });
    }

    if (existing && force) {
        await Fixture.deleteMany({
            guildId: guild.id,
            tournamentId: tournament._id,
            phase: 'league'
        });
    }

    const fixtures = buildRoundRobinFixtures({
        guildId: guild.id,
        tournament,
        teams: normalizeTournamentTeams(teams),
        phase: 'league',
        roundPrefix: 'Matchday',
        groupKey: null,
        homeAway: tournament.homeAway,
        startMatchNumber: await getNextMatchNumber(guild.id, tournament._id)
    });

    await Fixture.insertMany(fixtures);

    tournament.currentPhase = 'league';
    await tournament.save();

    return successReply(reply, tournament, '🏟️ LEAGUE GENERATED', fixtures.length);
}

/* ====================================================
   GROUP STAGE GENERATOR
==================================================== */

async function generateGroups({ guild, tournament, teams, force, reply }) {
    if (!tournament.groupCount || tournament.groupCount <= 0) {
        return reply({ content: '❌ This tournament has no groups configured.' });
    }

    const existing = await Fixture.countDocuments({
        guildId: guild.id,
        tournamentId: tournament._id,
        phase: 'group'
    });

    if (existing && !force) {
        return reply({
            content: `❌ Group fixtures already exist: **${existing}**. Use \`--force\` to regenerate.`
        });
    }

    if (existing && force) {
        await Fixture.deleteMany({
            guildId: guild.id,
            tournamentId: tournament._id,
            phase: 'group'
        });
    }

    /* ── Ensure all teams have group assignments ── */
    const unassigned = teams.filter(t => !t.groupKey);

    if (unassigned.length) {
        return reply({
            content:
                `❌ **${unassigned.length}** team(s) have no group assigned.\n` +
                `Use draw/group assignment first, then generate groups.`
        });
    }

    /* ── Generate round-robin per group ── */
    const groupKeys = Array.from(
        { length: tournament.groupCount },
        (_, i) => String.fromCharCode(65 + i)
    );

    const fixtures = [];
    let nextMatchNumber = await getNextMatchNumber(guild.id, tournament._id);

    for (const groupKey of groupKeys) {
        const groupTeams = teams.filter(t => t.groupKey === groupKey);
        if (groupTeams.length < 2) continue;

        const groupFixtures = buildRoundRobinFixtures({
            guildId: guild.id,
            tournament,
            teams: normalizeTournamentTeams(groupTeams),
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
        return reply({ content: '❌ No group fixtures could be generated.' });
    }

    await Fixture.insertMany(fixtures);

    tournament.currentPhase = 'groups';
    await tournament.save();

    return successReply(reply, tournament, '📦 GROUP STAGE GENERATED', fixtures.length);
}

/* ====================================================
   KNOCKOUT GENERATOR
==================================================== */

async function generateKnockout({ guild, tournament, teams, force, reply }) {
    if (!tournament.hasKnockout) {
        return reply({ content: '❌ This tournament has no knockout stage enabled.' });
    }

    const round = resolveNextKnockoutRound(tournament);

    if (!round) {
        return reply({ content: '❌ No knockout round found in tournament settings.' });
    }

    const existing = await Fixture.countDocuments({
        guildId: guild.id,
        tournamentId: tournament._id,
        phase: round
    });

    if (existing && !force) {
        return reply({
            content: `❌ ${prettyPhase(round)} fixtures already exist: **${existing}**. Use \`--force\`.`
        });
    }

    if (existing && force) {
        await Fixture.deleteMany({
            guildId: guild.id,
            tournamentId: tournament._id,
            phase: round
        });
    }

    /* ── Get qualified teams sorted by standings ── */
    const qualified = await getQualifiedTeams({ tournament, teams });

    if (qualified.length < 2 || qualified.length % 2 !== 0) {
        return reply({
            content: `❌ Invalid qualified team count for **${prettyPhase(round)}**: **${qualified.length}**.`
        });
    }

    /* ── Pair up teams ── */
    const pairs = [];
    for (let i = 0; i < qualified.length; i += 2) {
        pairs.push([qualified[i], qualified[i + 1]]);
    }

    const isTwoLegged =
        Array.isArray(tournament.twoLeggedRounds) &&
        tournament.twoLeggedRounds.includes(round);

    const fixtures = buildKnockoutFixtures({
        guildId: guild.id,
        tournament,
        phase: round,
        pairs,
        twoLegged: isTwoLegged,
        startMatchNumber: await getNextMatchNumber(guild.id, tournament._id)
    });

    await Fixture.insertMany(fixtures);

    tournament.currentPhase = 'knockout';
    await tournament.save();

    return successReply(reply, tournament, `🏆 ${prettyPhase(round).toUpperCase()} GENERATED`, fixtures.length);
}

/* ====================================================
   HELPERS
==================================================== */

/** Normalize TournamentTeam documents into the shape fixtureBuilder expects. */
function normalizeTournamentTeams(teams) {
    return teams.map(entry => ({
        tournamentTeamId: entry._id,
        teamId: entry.teamId?._id || entry.teamId,
        name: entry.teamId?.name || entry.teamNameSnapshot
    }));
}

/** Determine the next knockout round from tournament config or derived from qualified teams. */
function resolveNextKnockoutRound(tournament) {
    const rounds = Array.isArray(tournament.knockoutRounds)
        ? tournament.knockoutRounds
        : [];

    if (rounds.length > 0) return rounds[0];

    // Fallback: derive from qualified team count
    const qualifiedCount = deriveQualifiedCount(tournament);
    const derived = deriveKnockoutRounds(qualifiedCount);
    return derived[0] || 'semifinal';
}

/**
 * Derive the number of qualified teams from tournament settings.
 * For groups_knockout format: groupCount * qualificationSpotsPerGroup
 * Otherwise: teamCount or 4
 */
function deriveQualifiedCount(tournament) {
    if (tournament.formatType === 'groups_knockout' && tournament.groupCount > 0) {
        return tournament.groupCount * (tournament.qualificationSpotsPerGroup || 2);
    }
    return tournament.teamCount || 4;
}

/**
 * Given the total number of qualified teams, return the
 * ordered array of knockout round phase strings.
 *
 * 2  → ['final']
 * 4  → ['semifinal', 'final']
 * 8  → ['quarterfinal', 'semifinal', 'final']
 * 16 → ['roundof16', 'quarterfinal', 'semifinal', 'final']
 */
function deriveKnockoutRounds(qualifiedTeamCount) {
    const ALL_ROUNDS = ['roundof16', 'quarterfinal', 'semifinal', 'final'];
    const total = Math.max(2, qualifiedTeamCount);

    // How many rounds do we need?  log2(total)
    const roundCount = Math.log2(total);

    // If not a power of 2, round up
    const roundedCount = Math.ceil(roundCount);

    // Slice from the end of ALL_ROUNDS
    return ALL_ROUNDS.slice(ALL_ROUNDS.length - roundedCount);
}

/** Get qualified teams sorted by standings (points → GD → GF), with cross-group seeding. */
async function getQualifiedTeams({ tournament, teams }) {
    const groupKeys = [...new Set(teams.map(t => t.groupKey).filter(Boolean))].sort();
    const spotsPerGroup = tournament.qualificationSpotsPerGroup || 2;

    // If there are groups, qualify top N from each group with proper seeding
    if (groupKeys.length > 0) {
        return crossGroupSeed({ teams, groupKeys, spotsPerGroup });
    }

    // Fallback: flat standings — take top N overall
    const sorted = [...teams].sort((a, b) => {
        const as = a.stats || {};
        const bs = b.stats || {};

        if ((bs.points || 0) !== (as.points || 0)) return (bs.points || 0) - (as.points || 0);

        const agd = (as.gf || 0) - (as.ga || 0);
        const bgd = (bs.gf || 0) - (bs.ga || 0);
        if (bgd !== agd) return bgd - agd;

        return (bs.gf || 0) - (as.gf || 0);
    });

    const target = deriveQualifiedCount(tournament);

    return sorted.slice(0, target).map(entry => ({
        tournamentTeamId: entry._id,
        teamId: entry.teamId?._id || entry.teamId,
        name: entry.teamId?.name || entry.teamNameSnapshot
    }));
}

/**
 * Cross-group seeding: sort within each group, then interleave
 * so teams from the same group meet as late as possible.
 *
 * For 2 groups with top 4 each (8 total):
 *   A1 vs B4, A2 vs B3, B2 vs A3, B1 vs A4
 *
 * General pattern for 2 groups:
 *   Group A positions: 1, 2, 3, 4 → paired with B: 4, 3, 2, 1
 *   Then merge: A1, B1, A2, B2, A3, B3, A4, B4
 *   Pairs: (A1 vs B4), (B1 vs A4) ... no wait.
 *
 * Standard bracket seeding for N groups, M spots per group:
 *   Step 1: Rank within each group → A1,A2,...Am; B1,B2,...Bm
 *   Step 2: Snake-draft order to produce bracket positions:
 *     Pos 1: A1, Pos 2: Bm, Pos 3: B1, Pos 4: Am,
 *     Pos 5: A2, Pos 6: B(m-1), Pos 7: B2, Pos 8: A(m-1), ...
 *   Step 3: Pair pos 1v2, 3v4, 5v6, 7v8 → A1 vs Bm, B1 vs Am, A2 vs B(m-1), B2 vs A(m-1)
 */
function crossGroupSeed({ teams, groupKeys, spotsPerGroup }) {
    // Sort teams within each group by standings
    const groups = {};
    for (const key of groupKeys) {
        groups[key] = teams
            .filter(t => t.groupKey === key)
            .sort((a, b) => {
                const as = a.stats || {};
                const bs = b.stats || {};
                if ((bs.points || 0) !== (as.points || 0)) return (bs.points || 0) - (as.points || 0);
                const agd = (as.gf || 0) - (as.ga || 0);
                const bgd = (bs.gf || 0) - (bs.ga || 0);
                if (bgd !== agd) return bgd - agd;
                return (bs.gf || 0) - (as.gf || 0);
            })
            .slice(0, spotsPerGroup)
            .map(entry => ({
                tournamentTeamId: entry._id,
                teamId: entry.teamId?._id || entry.teamId,
                name: entry.teamId?.name || entry.teamNameSnapshot
            }));
    }

    // If only 1 group, just return sorted
    if (groupKeys.length === 1) {
        return groups[groupKeys[0]];
    }

    // For 2 groups (most common), use standard cross-seeding:
    // A1 vs B4, A2 vs B3, B2 vs A3, B1 vs A4
    if (groupKeys.length === 2) {
        const [gA, gB] = groupKeys;
        const a = groups[gA] || [];
        const b = groups[gB] || [];

        // Interleave: A1, B_last, A2, B_second_last, ... then pair
        const bracket = [];
        for (let i = 0; i < spotsPerGroup; i++) {
            if (a[i]) bracket.push(a[i]);
            if (b[spotsPerGroup - 1 - i]) bracket.push(b[spotsPerGroup - 1 - i]);
        }

        return bracket;
    }

    // 3+ groups: simple interleave A1,B1,C1,A2,B2,C2,...
    const bracket = [];
    for (let pos = 0; pos < spotsPerGroup; pos++) {
        for (const key of groupKeys) {
            if (groups[key]?.[pos]) bracket.push(groups[key][pos]);
        }
    }

    return bracket;
}

/** Build a success embed for fixture generation. */
function successReply(reply, tournament, title, count) {
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(title)
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `Created fixtures: **${count}**`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}
