/**
 * audit-teams.js
 *
 * Audit teams in the server.
 *
 * Two views:
 *  - GLOBAL:        .audit-teams / /audit-teams
 *                   roster counts, missing captains/logos, group assignments,
 *                   roster mismatches, free agents, per-tournament progress.
 *  - PER-TOURNAMENT: .audit-teams <tournament key or name>
 *                    / /audit-teams tournament:<key or name>
 *                   Teams registered in ONE specific tournament, with
 *                   per-tournament rosters/captains, teams that have NOT
 *                   registered, and tournament-specific issues.
 *
 * Organizer only.
 *
 * Usage: .audit-teams [tournament=<key> | <key>]
 * Slash: /audit-teams [tournament:<key>]
 *
 * Aliases: auditteams, teamaudit
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    Team,
    Player,
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer
} = require('../../models/Tournament');

const { isOrganizer } = require('../../utils/isOrganizer');
const { getDefaultTournament } = require('../../utils/getTournament');

module.exports = {
    name: 'audit-teams',
    description: 'Audit global teams, or the teams of one specific tournament.',
    usage: '.audit-teams [tournament=<key> | <key> | all]  (no key = default tournament)',
    aliases: ['auditteams', 'teamaudit'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('audit-teams')
        .setDescription('Audit global teams, or one specific tournament')
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Optional: audit teams of ONE tournament (key or name)')
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

            const tournamentQuery = parseTournamentArg(args);

            return await runAudit({
                guild: message.guild,
                tournamentQuery,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[audit-teams] prefix error:', error);
            return message.reply('❌ Failed to audit teams.');
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

            return await runAudit({
                guild: interaction.guild,
                tournamentQuery: interaction.options.getString('tournament'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[audit-teams] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: '❌ Failed to audit teams.' });
            }

            return interaction.reply({ content: '❌ Failed to audit teams.', ephemeral: true });
        }
    }
};

/* ====================================================
   ARG PARSING
==================================================== */

/**
 * Prefix args → tournament query:
 *   .audit-teams                     → DEFAULT tournament
 *   .audit-teams all                 → null (every tournament / global view)
 *   .audit-teams league-s4           → 'league-s4'
 *   .audit-teams tournament=league-s4 → 'league-s4'
 *   .audit-teams league s4 (name)    → 'league s4'
 */
function parseTournamentArg(args) {
    const list = (Array.isArray(args) ? args : [])
        .map(a => String(a).trim())
        .filter(Boolean);
    if (!list.length) return null;

    const first = list[0].toLowerCase();
    if (first.startsWith('tournament=')) {
        return list[0].split('=').slice(1).join('=').trim() || null;
    }

    return list.join(' ').trim() || null;
}

/* ====================================================
   CORE LOGIC
==================================================== */

async function runAudit({ guild, tournamentQuery, reply }) {
    // `.audit-teams all` (or the slash tournament:all) → every tournament
    if (tournamentQuery && ['all', '*'].includes(String(tournamentQuery).trim().toLowerCase())) {
        return runGlobalAudit({ guild, reply });
    }

    if (tournamentQuery) {
        return runTournamentAudit({ guild, tournamentQuery, reply });
    }

    // No argument → the server's default tournament
    const defaultTournament = await getDefaultTournament(guild.id, { includeCompleted: true });

    if (defaultTournament) {
        return runTournamentAudit({
            guild,
            tournamentQuery: defaultTournament.tournamentKey,
            reply
        });
    }

    return runGlobalAudit({ guild, reply });
}

/* ────────────────────────────────────────────────
   PER-TOURNAMENT AUDIT
   ──────────────────────────────────────────────── */

async function runTournamentAudit({ guild, tournamentQuery, reply }) {
    const tournaments = await TournamentSettings.find({ guildId: guild.id }).sort({ createdAt: -1 });

    const query = String(tournamentQuery).trim().toLowerCase();
    const tournament =
        tournaments.find(t => String(t.tournamentKey || '').toLowerCase() === query) ||
        tournaments.find(t => String(t.name || '').toLowerCase() === query);

    if (!tournament) {
        const available = tournaments.map(t => `\`${t.tournamentKey}\``).join(', ') || 'none';
        return reply({
            content: `❌ Tournament not found: \`${tournamentQuery}\`\nAvailable: ${available}`
        });
    }

    const [teams, entries, tournamentPlayers] = await Promise.all([
        Team.find({ guildId: guild.id }).sort({ name: 1 }),
        TournamentTeam.find({
            guildId: guild.id,
            tournamentId: tournament._id,
            isActive: true
        }).populate('teamId').lean(),
        TournamentPlayer.find({
            guildId: guild.id,
            tournamentId: tournament._id,
            isActive: true
        }).lean()
    ]);

    // Per-tournament roster counts
    const rosterByTeam = new Map();
    for (const tp of tournamentPlayers) {
        const tid = String(tp.teamId);
        rosterByTeam.set(tid, (rosterByTeam.get(tid) || 0) + 1);
    }

    // Entry lookup by team
    const entryByTeam = new Map();
    for (const entry of entries) {
        const tid = String(entry.teamId?._id || entry.teamId);
        entryByTeam.set(tid, entry);
    }

    const registered = [];
    const notRegistered = [];

    for (const team of teams) {
        const tid = String(team._id);
        const entry = entryByTeam.get(tid);
        if (entry) registered.push({ team, entry });
        else notRegistered.push(team);
    }

    // ── Issues ──
    const issues = {
        noCaptain: [],
        emptyRoster: [],
        missingLogo: [],
        missingGroups: []
    };

    for (const { team, entry } of registered) {
        const tid = String(team._id);
        const rosterCount = rosterByTeam.get(tid) || 0;
        const effectiveCaptain = entry.captainID || team.captainID;

        if (!effectiveCaptain) issues.noCaptain.push(team.name);
        if (rosterCount === 0) issues.emptyRoster.push(team.name);
        if (!team.logoURL) issues.missingLogo.push(team.name);
        if ((tournament.groupCount || 0) > 0 && !String(entry.groupKey || '').trim()) {
            issues.missingGroups.push(team.name);
        }
    }

    // ── Team lines ──
    const teamColumns = [[], [], []];
    registered.forEach(({ team, entry }, index) => {
        const rosterCount = rosterByTeam.get(String(team._id)) || 0;
        const captain = entry.captainID || team.captainID;
        teamColumns[index % 3].push(`• ${team.name} (${rosterCount})${captain ? ' 👑' : ''}`);
    });

    const targetTeams = tournament.teamCount || tournament.maxTeams || tournament.desiredTeams || '?';
    const remaining = Number.isFinite(Number(targetTeams))
        ? Math.max(0, Number(targetTeams) - registered.length)
        : '?';

    const statusText =
        `${tournament.emoji || '🏆'} **${tournament.name}** \`${tournament.tournamentKey}\`\n` +
        `Phase: **${tournament.currentPhase || 'setup'}** | Registration: **${tournament.registrationOpen ? 'Open' : 'Closed'}**` +
        (tournament.manualRegistration ? ' | 🖐️ Manual' : '') +
        `\n👥 Registered: **${registered.length}/${targetTeams}**\n⏳ Remaining: **${remaining}**`;

    const notRegisteredText = notRegistered.length
        ? notRegistered.map(t => t.name).slice(0, 20).join(', ') +
          (notRegistered.length > 20 ? ` (+${notRegistered.length - 20} more)` : '')
        : 'All teams registered ✅';

    const issueLines = [];
    if (issues.noCaptain.length) issueLines.push(`👑 No Captain in this tournament (${issues.noCaptain.length})\n${issues.noCaptain.join(', ')}`);
    if (issues.emptyRoster.length) issueLines.push(`🚨 Empty Roster (${issues.emptyRoster.length})\n${issues.emptyRoster.join(', ')}`);
    if (issues.missingGroups.length) issueLines.push(`📋 Missing Groups (${issues.missingGroups.length})\n${issues.missingGroups.join(', ')}`);
    if (issues.missingLogo.length) issueLines.push(`🖼️ Missing Logos (${issues.missingLogo.length})\n${issues.missingLogo.join(', ')}`);

    const embed = new EmbedBuilder()
        .setColor(issueLines.length ? 0xF39C12 : 0x2ECC71)
        .setTitle(`🧾 AUDIT — ${tournament.name}`)
        .addFields(
            { name: '📊 Status', value: statusText, inline: false },
            { name: `👥 Teams in this tournament (${registered.length})`, value: teamColumns[0].join('\n') || '—', inline: true },
            { name: '\u200b', value: teamColumns[1].join('\n') || '—', inline: true },
            { name: '\u200b', value: teamColumns[2].join('\n') || '—', inline: true },
            { name: `📭 Not Registered (${notRegistered.length})`, value: notRegisteredText, inline: false },
            {
                name: '⚠️ Issues',
                value: issueLines.length ? issueLines.join('\n\n') : '✅ No issues found.',
                inline: false
            }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ────────────────────────────────────────────────
   GLOBAL AUDIT
   ──────────────────────────────────────────────── */

async function runGlobalAudit({ guild, reply }) {
    // ── Bulk load everything upfront ──
    const [teams, players, tournaments] = await Promise.all([
        Team.find({ guildId: guild.id }).sort({ name: 1 }),
        Player.find({ guildId: guild.id }),
        TournamentSettings.find({ guildId: guild.id }).sort({ createdAt: -1 })
    ]);

    if (!teams.length) {
        return reply({ content: '📭 No teams found to audit.' });
    }

    const [tournamentTeams, tournamentPlayers] = await Promise.all([
        TournamentTeam.find({
            guildId: guild.id,
            isActive: true
        }).populate('teamId tournamentId').lean(),
        TournamentPlayer.find({
            guildId: guild.id,
            isActive: true
        }).lean()
    ]);

    // ── Build lookup maps ──
    const playersByTeam = new Map();
    for (const player of players) {
        const tid = String(player.teamId);
        if (!playersByTeam.has(tid)) playersByTeam.set(tid, []);
        playersByTeam.get(tid).push(player);
    }

    const tournamentTeamsByTeam = new Map();
    for (const tt of tournamentTeams) {
        const tid = String(tt.teamId?._id || tt.teamId);
        if (!tournamentTeamsByTeam.has(tid)) tournamentTeamsByTeam.set(tid, []);
        tournamentTeamsByTeam.get(tid).push(tt);
    }

    const tournamentPlayersByTeamTournament = new Map();
    for (const tp of tournamentPlayers) {
        const key = `${String(tp.teamId)}_${String(tp.tournamentId)}`;
        tournamentPlayersByTeamTournament.set(key, (tournamentPlayersByTeamTournament.get(key) || 0) + 1);
    }

    // ── Audit each team ──
    const teamColumns = [[], [], []];
    const issues = {
        missingGroups: [],
        missingLogos: [],
        missingCaptains: [],
        captainMismatch: [],
        rosterMismatch: [],
        brokenEntries: []
    };

    teams.forEach((team, index) => {
        const teamId = String(team._id);
        const roster = playersByTeam.get(teamId) || [];
        const rosterCount = roster.length;

        teamColumns[index % 3].push(`• ${team.name} (${rosterCount})`);

        // ── Captain checks ──
        if (!team.captainID) {
            issues.missingCaptains.push(team.name);
        } else {
            const captainInRoster = roster.some(p => p.discordID === team.captainID);
            if (!captainInRoster) {
                issues.captainMismatch.push(team.name);
            }
        }

        // ── Logo check ──
        if (!team.logoURL) {
            issues.missingLogos.push(team.name);
        }

        // ── Tournament participation checks ──
        const ttEntries = tournamentTeamsByTeam.get(teamId) || [];

        for (const tt of ttEntries) {
            const tournament = tt.tournamentId;
            const tid = String(tournament?._id);

            if (!tournament) {
                if (!issues.brokenEntries.includes(team.name)) {
                    issues.brokenEntries.push(team.name);
                }
                continue;
            }

            // Group check
            if ((tournament.groupCount || 0) > 0 && !String(tt.groupKey || '').trim()) {
                issues.missingGroups.push(`${team.name} (${tournament.tournamentKey})`);
            }

            // Roster check — per-tournament roster is the source of truth.
            // Manual-registration tournaments intentionally differ from the
            // global roster, so only flag empty rosters there.
            const tpCount = tournamentPlayersByTeamTournament.get(`${teamId}_${tid}`) || 0;
            const isManual = tournament.manualRegistration === true;

            if (tpCount === 0) {
                issues.rosterMismatch.push(`${team.name} in ${tournament.tournamentKey} (0 players)`);
            } else if (!isManual && tpCount < rosterCount) {
                issues.rosterMismatch.push(`${team.name} in ${tournament.tournamentKey} (${tpCount}/${rosterCount})`);
            }
        }
    });

    // ── Free agents ──
    const freeAgents = players.filter(p => !p.teamId);

    // ── Build issue lines ──
    const issueLines = [];

    if (issues.missingGroups.length) {
        issueLines.push(`📋 Missing Groups (${issues.missingGroups.length})\n${issues.missingGroups.join(', ')}`);
    }
    if (issues.missingLogos.length) {
        issueLines.push(`🖼️ Missing Logos (${issues.missingLogos.length})\n${issues.missingLogos.join(', ')}`);
    }
    if (issues.missingCaptains.length) {
        issueLines.push(`👑 Missing Captains (${issues.missingCaptains.length})\n${issues.missingCaptains.join(', ')}`);
    }
    if (issues.captainMismatch.length) {
        issueLines.push(`⚠️ Captain Not In Roster (${issues.captainMismatch.length})\n${issues.captainMismatch.join(', ')}`);
    }
    if (issues.rosterMismatch.length) {
        issueLines.push(`🔄 Roster Mismatches (${issues.rosterMismatch.length})\n${issues.rosterMismatch.join(', ')}`);
    }
    if (issues.brokenEntries.length) {
        issueLines.push(`💥 Broken Tournament Entries (${issues.brokenEntries.length})\n${issues.brokenEntries.join(', ')}`);
    }
    if (freeAgents.length) {
        issueLines.push(
            `🆓 Free Agents (${freeAgents.length})\n` +
            freeAgents.map(p => p.name).slice(0, 10).join(', ')
        );
    }

    // ── Per-tournament registration progress ──
    let registrationText = 'No active tournaments found';

    if (tournaments.length) {
        const lines = tournaments.slice(0, 5).map(t => {
            const registeredCount = tournamentTeams.filter(
                tt => String(tt.tournamentId?._id || tt.tournamentId) === String(t._id)
            ).length;
            const target = t.teamCount || t.maxTeams || t.desiredTeams || '?';
            const remaining = Number.isFinite(Number(target))
                ? Math.max(0, Number(target) - registeredCount)
                : '?';

            return (
                `${t.emoji || '🏆'} **${t.name}** \`${t.tournamentKey}\` — ` +
                `👥 **${registeredCount}/${target}** (remaining: **${remaining}**)`
            );
        });

        registrationText = lines.join('\n') +
            `\n\n🔎 Per-tournament report: \`/audit-teams tournament:<key>\``;
    }

    // ── Build embed ──
    const embed = new EmbedBuilder()
        .setColor(issueLines.length ? 0xF39C12 : 0x2ECC71)
        .setTitle('🧾 TEAM AUDIT REPORT')
        .addFields(
            { name: '📊 Registration Progress', value: registrationText, inline: false },
            { name: `👥 Teams (${teams.length})`, value: teamColumns[0].join('\n') || '—', inline: true },
            { name: '\u200b', value: teamColumns[1].join('\n') || '—', inline: true },
            { name: '\u200b', value: teamColumns[2].join('\n') || '—', inline: true },
            {
                name: '⚠️ Issues',
                value: issueLines.length ? issueLines.join('\n\n') : '✅ No issues found.',
                inline: false
            }
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}
