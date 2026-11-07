/**
 * myteam.js
 *
 * View your team details, squad, stats, and trophies.
 *
 * Multi-tournament support:
 * - Lists EVERY team you belong to: your global team, teams where you are
 *   the per-tournament captain/VC, and teams you joined in a specific
 *   tournament. When you have more than one team, a dropdown lets you
 *   switch between them.
 * - The squad is the union of global players AND active per-tournament
 *   rosters, so tournament-only members are shown too. Player names use the
 *   global nickname and squad affiliation labels use the current default tournament.
 *
 * Usage:  .myteam [team name]
 * Slash:  /myteam [team]
 *
 * Aliases: teamview, squad, club
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} = require('discord.js');

const {
    Team,
    Player,
    TournamentTeam,
    TournamentPlayer,
    TournamentSettings,
    UserProfile
} = require('../../models/Tournament');

const { escapeRegex } = require('../../utils/stringHelpers');
const { parseColor } = require('../../utils/displayHelpers');
const { resolveTournament } = require('../../utils/getTournament');
const {
    getUserTeamInTournament,
    getUserTeams,
    effectiveCaptainId,
    effectiveViceCaptainId
} = require('../../utils/tournamentContext');
const { getUserLeadershipRole } = require('../../utils/tournamentLeadership');
const { getSquadDisplayName, getSquadTournamentNames } = require('../../utils/squadDisplay');

const DEFAULT_TROPHY_EMOJI = '<:_Trophy:1507987705311793152>';

module.exports = {
    name: 'myteam',
    description: 'View your team details, squad and trophies.',
    usage: '.myteam [team name]',
    aliases: ['teamview', 'squad', 'club'],
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('myteam')
        .setDescription('View your team details and squad')
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

            return await runMyTeam({
                guild: message.guild,
                viewerId: message.author.id,
                requestedTeamName: args.length ? args.join(' ').trim() : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[myteam] prefix error:', error);
            return message.reply('❌ Failed to load team details.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return await runMyTeam({
                guild: interaction.guild,
                viewerId: interaction.user.id,
                requestedTeamName: interaction.options.getString('team'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[myteam] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to load team details.');
            }

            return interaction.reply({ content: '❌ Failed to load team details.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

async function runMyTeam({ guild, viewerId, requestedTeamName, reply }) {
    let teams = await getAllTeamsForUser(guild.id, viewerId);

    /*
     * Default selection = the team the user is on in the server's DEFAULT
     * tournament (never a leftover team from an old tournament).
     */
    if (!requestedTeamName && teams.length > 1) {
        const resolved = await resolveTournament(guild.id, null);

        if (resolved.tournament) {
            const ctx = await getUserTeamInTournament(guild.id, resolved.tournament, viewerId);

            if (ctx) {
                const idx = teams.findIndex(t => String(t._id) === String(ctx.team._id));
                if (idx > 0) {
                    teams = [teams[idx], ...teams.slice(0, idx), ...teams.slice(idx + 1)];
                }
            }
        }
    }

    /* ── Resolve which team to show ── */
    let team;

    if (requestedTeamName) {
        team = await Team.findOne({
            guildId: guild.id,
            name: { $regex: new RegExp(`^${escapeRegex(requestedTeamName)}$`, 'i') }
        });

        if (!team) {
            return reply({ content: `❌ Team not found: \`${requestedTeamName}\`` });
        }
    } else if (teams.length === 0) {
        return reply({
            content: '❌ You are not linked to a team yet. Use `.myteam <Team Name>`.'
        });
    } else {
        team = teams[0];
    }

    /* ── Precompute per-team tournament names for the dropdown descriptions ── */
    const teamTournamentNames = await getTeamTournamentNames(guild.id, teams);

    let currentTeam = team;
    let view = 'overview';

    const payload = await buildPayload({
        guild,
        team: currentTeam,
        teams,
        currentTeamId: String(currentTeam._id),
        view,
        teamTournamentNames
    });

    const msg = await reply(payload);

    if (!msg?.createMessageComponentCollector) return;

    const collector = msg.createMessageComponentCollector({ time: 600000 });

    collector.on('collect', async interaction => {
        try {
            if (interaction.user.id !== viewerId) {
                return interaction.reply({ content: 'Not your menu.', ephemeral: true });
            }

            if (interaction.isStringSelectMenu() && interaction.customId === 'myteam_team_select') {
                const selectedId = interaction.values[0];
                const selected = teams.find(t => String(t._id) === selectedId);
                if (selected) currentTeam = selected;
            } else if (interaction.isButton()) {
                if (interaction.customId === 'myteam_overview') view = 'overview';
                if (interaction.customId === 'myteam_trophies') view = 'trophies';
            }

            const updatedPayload = await buildPayload({
                guild,
                team: currentTeam,
                teams,
                currentTeamId: String(currentTeam._id),
                view,
                teamTournamentNames
            });

            await interaction.update(updatedPayload);
        } catch (error) {
            console.error('[myteam] collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Failed to update team view.', ephemeral: true }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        await msg.edit({ components: [] }).catch(() => null);
    });
}

/* ====================================================
   TEAM RESOLUTION — ALL of the user's teams
==================================================== */

/**
 * Collect every team this user is linked to:
 *  - their global team (Player.teamId / teamNameSnapshot)
 *  - teams where they are the global captain / vice captain
 *  - teams where they are the per-tournament captain / VC
 *  - teams they joined in a specific tournament (active TournamentPlayer)
 */
async function getAllTeamsForUser(guildId, userId) {
    /*
     * Shared resolver: global Player.teamId + global captain / VC +
     * per-tournament captain / VC + per-tournament roster entries, ordered
     * default-tournament team first. Never a stale team from an old tournament.
     */
    return getUserTeams(guildId, userId);
}

/** Map teamId -> tournament names (active entries), for dropdown descriptions. */
async function getTeamTournamentNames(guildId, teams) {
    const map = new Map();
    if (!teams.length) return map;

    const ids = teams.map(t => t._id);
    const entries = await TournamentTeam.find({
        guildId,
        isActive: true,
        teamId: { $in: ids }
    }).populate('tournamentId');

    for (const entry of entries) {
        const key = String(entry.teamId);
        if (!map.has(key)) map.set(key, []);
        if (entry.tournamentId?.name && !map.get(key).includes(entry.tournamentId.name)) {
            map.get(key).push(entry.tournamentId.name);
        }
    }

    return map;
}

/* ====================================================
   SQUAD — union of global players + per-tournament rosters
==================================================== */

/**
 * Build the full squad list: every player who is on this team either
 * globally (Player.teamId) or in any active tournament (TournamentPlayer).
 * Each entry is tagged with the tournaments they play in for this team.
 */
async function buildSquadEntries(guildId, team) {
    const [globalPlayers, resolvedDefault] = await Promise.all([
        Player.find({ guildId, teamId: team._id }),
        resolveTournament(guildId, null)
    ]);
    const defaultTournament = resolvedDefault.tournament || null;
    const defaultTournamentKey = defaultTournament?.tournamentKey || '';
    const defaultTournamentTeam = defaultTournament
        ? await TournamentTeam.findOne({
            guildId,
            tournamentId: defaultTournament._id,
            teamId: team._id,
            isActive: true
        })
        : null;

    const tourEntries = await TournamentPlayer.find({
        guildId,
        teamId: team._id,
        isActive: true
    }).populate('playerId').populate('tournamentId');

    const globalById = new Map(globalPlayers.map(player => [String(player._id), player]));
    const tournamentEntriesByPlayer = new Map();

    for (const entry of tourEntries) {
        const playerId = String(entry.playerId?._id || entry.playerId);
        if (!tournamentEntriesByPlayer.has(playerId)) tournamentEntriesByPlayer.set(playerId, []);
        tournamentEntriesByPlayer.get(playerId).push(entry);
    }

    const playerIds = new Set([
        ...globalById.keys(),
        ...tournamentEntriesByPlayer.keys()
    ]);
    const list = [];

    for (const playerId of playerIds) {
        const globalPlayer = globalById.get(playerId);
        const entries = tournamentEntriesByPlayer.get(playerId) || [];
        const tournamentPlayer = entries.find(entry => entry.playerId?.discordID);

        const discordID = globalPlayer?.discordID || tournamentPlayer?.playerId?.discordID || null;
        const role = defaultTournament
            ? defaultTournamentTeam
                ? getUserLeadershipRole({
                    userId: discordID,
                    team,
                    entry: defaultTournamentTeam
                })
                : 'player'
            : getUserLeadershipRole({ userId: discordID, team });

        list.push({
            playerId,
            // Player.name is the bot-wide nickname; old tournament snapshots
            // must not override it when we build the current squad.
            name: getSquadDisplayName({
                globalName: globalPlayer?.name,
                tournamentEntries: entries,
                defaultTournamentKey
            }),
            discordID,
            // Match the current tournament's authorization rules. Never use a
            // global or historical tournament badge as the active role.
            isCaptain: role === 'captain',
            isViceCaptain: role === 'vice',
            // Historical tournament labels remain available in Tournament Stats,
            // not as prefixes/tags beside every player's name.
            tournaments: new Set(getSquadTournamentNames(entries, defaultTournamentKey))
        });
    }

    const roleOrder = entry => entry.isCaptain ? 0 : entry.isViceCaptain ? 1 : 2;
    list.sort((a, b) => roleOrder(a) - roleOrder(b) || a.name.localeCompare(b.name));
    return list;
}

function squadToLines(squad) {
    return squad.map((entry, index) => {
        const leadership = entry.isCaptain
            ? ' 👑 Captain'
            : entry.isViceCaptain
                ? ' 🛡️ Vice-Captain'
                : '';
        const linked = entry.discordID ? ` (<@${entry.discordID}>)` : '';
        const tags = entry.tournaments.size ? ` — ${[...entry.tournaments].join(', ')}` : '';
        return `${index + 1}. **${entry.name}**${leadership}${linked}${tags}`;
    });
}

/** Chunk lines into embed-field-safe pieces (1024 chars max). */
function chunkLines(lines, max = 1024) {
    const chunks = [];
    let current = '';

    for (const line of lines) {
        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length > max && current) {
            chunks.push(current);
            current = line;
        } else {
            current = candidate;
        }
    }

    if (current) chunks.push(current);
    return chunks.length ? chunks : ['No players registered yet.'];
}

/* ====================================================
   EMBED BUILDERS
==================================================== */

async function buildPayload({ guild, team, teams, currentTeamId, view, teamTournamentNames }) {
    // Load tournament emoji map for trophy display
    const tournamentEmojiMap = await getTournamentEmojiMap(guild.id);

    const embed = view === 'trophies'
        ? await buildTrophiesEmbed({ guild, team, tournamentEmojiMap })
        : await buildOverviewEmbed({ guild, team });

    return {
        embeds: [embed],
        components: buildComponents({ teams, currentTeamId, view, teamTournamentNames })
    };
}

async function buildOverviewEmbed({ guild, team }) {
    const squad = await buildSquadEntries(guild.id, team);

    const tournamentEntries = await TournamentTeam.find({
        guildId: guild.id,
        teamId: team._id,
        isActive: true
    }).populate('tournamentId').lean();

    const statsLines = tournamentEntries.length
        ? tournamentEntries.map(entry => {
            const tournament = entry.tournamentId;
            const stats = entry.stats || {};
            const gd = (stats.gf || 0) - (stats.ga || 0);
            const emoji = tournament?.emoji || '🏆';

            return (
                `${emoji} **${tournament?.name || entry.teamNameSnapshot || 'Tournament'}**\n` +
                `P: **${stats.played || 0}** | W: **${stats.wins || 0}** | D: **${stats.draws || 0}** | L: **${stats.losses || 0}** | ` +
                `GD: **${gd >= 0 ? '+' : ''}${gd}** | Pts: **${stats.points || 0}**`
            );
        }).join('\n\n')
        : 'This team is not active in any tournament yet.';

    /* ── Show effective leadership per active tournament ── */
    const captainLines = [];
    if (tournamentEntries.length) {
        for (const entry of tournamentEntries) {
            const tournament = entry.tournamentId;
            const label = tournament?.name || tournament?.tournamentKey || 'tournament';
            const captainId = effectiveCaptainId(entry, team);
            const viceCaptainId = effectiveViceCaptainId(entry, team);

            captainLines.push(
                `👑 **${label} Captain:** ${captainId ? `<@${captainId}>` : 'Not assigned'}`
            );
            if (viceCaptainId) {
                captainLines.push(`🛡️ **${label} Vice-Captain:** <@${viceCaptainId}>`);
            }
        }
    } else if (team.captainID) {
        captainLines.push(`👑 Captain: <@${team.captainID}>`);
    }
    const captainValue = captainLines.length
        ? captainLines.join('\n')
        : '👑 Captain: Not Assigned (yet)';

    const embed = new EmbedBuilder()
        .setColor(parseColor(team.color))
        .setTitle(`🏟️ ${team.name.toUpperCase()}`)
        .addFields(
            {
                name: 'Team Info',
                value:
                    `${captainValue}\n` +
                    `🏟️ Stadium: ${team.stadium || 'Not Set'}`,
                inline: false
            },
            {
                name: 'Tournament Stats',
                value: statsLines,
                inline: false
            }
        )
        .setTimestamp();

    /* ── Squad (chunked) ── */
    const lines = squadToLines(squad);
    const chunks = chunkLines(lines);
    chunks.forEach((chunk, i) => {
        embed.addFields({
            name: chunks.length > 1 ? `Squad (${i + 1}/${chunks.length})` : 'Squad',
            value: chunk,
            inline: false
        });
    });

    if (team.logoURL) {
        embed.setImage(team.logoURL);
    } else if (typeof guild.iconURL === 'function') {
        embed.setThumbnail(guild.iconURL());
    }

    return embed;
}

async function buildTrophiesEmbed({ guild, team, tournamentEmojiMap }) {
    const trophies = await collectTeamTrophies({ guildId: guild.id, team, tournamentEmojiMap });

    const embed = new EmbedBuilder()
        .setColor(0xF1C10F)
        .setTitle(`${DEFAULT_TROPHY_EMOJI} ${team.name.toUpperCase()} TROPHIES`)
        .setDescription(
            trophies.length
                ? trophies.map(t => formatTrophyLine(t, tournamentEmojiMap)).join('\n')
                : 'No trophies won yet.'
        )
        .setTimestamp();

    if (team.logoURL) {
        embed.setThumbnail(team.logoURL);
    } else if (typeof guild.iconURL === 'function') {
        embed.setThumbnail(guild.iconURL());
    }

    return embed;
}

/* ====================================================
   TOURNAMENT EMOJI MAP
==================================================== */

async function getTournamentEmojiMap(guildId) {
    const tournaments = await TournamentSettings.find({ guildId })
        .select('tournamentKey emoji')
        .lean()
        .catch(() => []);

    const map = new Map();
    for (const tournament of tournaments) {
        if (tournament.tournamentKey && tournament.emoji) {
            map.set(tournament.tournamentKey, tournament.emoji);
        }
    }
    return map;
}

/* ====================================================
   TROPHY COLLECTION
==================================================== */

async function collectTeamTrophies({ guildId, team, tournamentEmojiMap }) {
    const trophyMap = new Map();

    const teamDoc = await Team.findById(team._id).lean().catch(() => null);
    for (const trophy of teamDoc?.trophies || []) {
        addTrophyToMap(trophyMap, trophy, tournamentEmojiMap);
    }

    const tournamentTeamDocs = await TournamentTeam.find({
        guildId,
        $or: [
            { teamId: team._id },
            { teamNameSnapshot: team.name }
        ]
    }).lean();

    for (const entry of tournamentTeamDocs) {
        for (const trophy of entry.trophies || []) {
            addTrophyToMap(trophyMap, trophy, tournamentEmojiMap);
        }
    }

    const profiles = await UserProfile.find({
        guildId,
        'trophies.teamName': team.name
    }).lean();

    for (const profile of profiles) {
        for (const trophy of profile.trophies || []) {
            if (trophy.teamName !== team.name) continue;
            addTrophyToMap(trophyMap, trophy, tournamentEmojiMap);
        }
    }

    return Array.from(trophyMap.values())
        .sort((a, b) => new Date(b.awardedAt || 0) - new Date(a.awardedAt || 0));
}

function addTrophyToMap(map, trophy, tournamentEmojiMap) {
    const clean = normalizeTrophy(trophy, tournamentEmojiMap);
    if (!clean) return;

    const key = `${clean.tournamentKey}:${clean.label}`;
    if (!map.has(key)) map.set(key, clean);
}

function normalizeTrophy(trophy, tournamentEmojiMap) {
    if (!trophy) return null;

    const tournamentName = trophy.tournamentName || trophy.tournamentKey || 'Tournament';
    const tournamentKey = trophy.tournamentKey || tournamentName.toLowerCase().replace(/\s+/g, '-');

    let label = '';

    if (trophy.type === 'champion') label = 'Winner';
    else if (trophy.type === 'runner_up') label = 'Runner Up';
    else if (String(trophy.name || '').toLowerCase() === 'winner') label = 'Winner';
    else if (String(trophy.name || '').toLowerCase() === 'runner up') label = 'Runner Up';
    else if (String(trophy.label || '').toLowerCase() === 'winner') label = 'Winner';
    else if (String(trophy.label || '').toLowerCase() === 'runner up') label = 'Runner Up';
    else if (String(trophy.title || '').toLowerCase().includes('winner')) label = 'Winner';
    else if (String(trophy.title || '').toLowerCase().includes('runner up')) label = 'Runner Up';

    if (!label) return null;

    // Same priority logic as mystats.js
    const tournamentEmoji = tournamentKey && tournamentEmojiMap?.get(tournamentKey)
        ? tournamentEmojiMap.get(tournamentKey)
        : null;

    const savedEmoji = String(trophy.emoji || '').trim();
    const genericWinnerEmojis = new Set(['🏆', '🏅', '🥇']);
    const genericRunnerEmojis = new Set(['🥈', '🏅']);

    let emoji;

    if (label === 'Winner') {
        emoji =
            tournamentEmoji ||
            (savedEmoji && !genericWinnerEmojis.has(savedEmoji) ? savedEmoji : null) ||
            DEFAULT_TROPHY_EMOJI;
    } else if (label === 'Runner Up') {
        emoji =
            tournamentEmoji ||
            (savedEmoji && !genericRunnerEmojis.has(savedEmoji) ? savedEmoji : null) ||
            '🥈';
    } else {
        emoji = tournamentEmoji || savedEmoji || DEFAULT_TROPHY_EMOJI;
    }

    return {
        tournamentKey,
        tournamentName,
        label,
        emoji,
        awardedAt: trophy.awardedAt || null
    };
}

function formatTrophyLine(trophy, tournamentEmojiMap) {
    const emoji = trophy.emoji;
    return `${emoji} **${trophy.tournamentName} ${trophy.label}**`;
}

/* ====================================================
   UI COMPONENTS
==================================================== */

/**
 * Component rows:
 *  - team selector (only when the user has 2+ teams)
 *  - overview / trophies buttons
 */
function buildComponents({ teams, currentTeamId, view, teamTournamentNames }) {
    const rows = [];

    if (teams.length > 1) {
        const options = teams.slice(0, 25).map(t => {
            const tourNames = teamTournamentNames.get(String(t._id)) || [];
            return {
                label: t.name,
                value: String(t._id),
                description: tourNames.length ? `Active in: ${tourNames.join(', ')}` : 'No active tournament',
                default: String(t._id) === currentTeamId
            };
        });

        rows.push(
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('myteam_team_select')
                    .setPlaceholder(`You have ${teams.length} teams — pick one…`)
                    .addOptions(options)
            )
        );
    }

    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('myteam_overview')
                .setLabel('Team Overview')
                .setStyle(view === 'overview' ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('myteam_trophies')
                .setLabel('Trophies')
                .setStyle(view === 'trophies' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        )
    );

    return rows;
}
