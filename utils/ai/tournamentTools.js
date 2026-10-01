/**
 * utils/ai/tournamentTools.js
 *
 * Read-only queries against the tournament database, written for an LLM to use.
 * Every tool returns plain, compact facts — never prose — so the model can only
 * state things that actually came from the database.
 *
 * Entry point:
 *   runTool(name, args, ctx)   → facts object | { error }
 *   TOOL_LIST                  → [{ name, description, args }]  (for the planner)
 *
 * ctx = { guildId, userId, tournamentKey }
 */

const {
    TournamentSettings,
    Team,
    Player,
    TournamentTeam,
    TournamentPlayer,
    Fixture,
    EventSettings,
    EventPlayer
} = require('../../models/Tournament');

const { resolveTournament, getSelectableTournaments } = require('../getTournament');
const { escapeRegex } = require('../stringHelpers');

const METRICS = {
    goals: 'stats.goals',
    assists: 'stats.assists',
    saves: 'stats.saves',
    tackles: 'stats.tackles',
    interceptions: 'stats.interceptions',
    mvps: 'stats.mvps',
    played: 'stats.played',
    yellow: 'stats.yc',
    red: 'stats.rc'
};

const METRIC_LABELS = {
    goals: 'goals',
    assists: 'assists',
    saves: 'saves',
    tackles: 'tackles',
    interceptions: 'interceptions',
    mvps: 'MVP awards',
    played: 'matches played',
    yellow: 'yellow cards',
    red: 'red cards'
};

function normMetric(metric) {
    const m = String(metric || 'goals').toLowerCase().trim();
    if (['goal', 'goals', 'scorer', 'scorers', 'golden boot', 'boot'].includes(m)) return 'goals';
    if (['assist', 'assists', 'assist race', 'playmaker'].includes(m)) return 'assists';
    if (['save', 'saves', 'keeper', 'gk'].includes(m)) return 'saves';
    if (['tackle', 'tackles'].includes(m)) return 'tackles';
    if (['interception', 'interceptions', 'intercept'].includes(m)) return 'interceptions';
    if (['mvp', 'mvps', 'man of the match', 'motm'].includes(m)) return 'mvps';
    if (['played', 'matches', 'games'].includes(m)) return 'played';
    if (['yellow', 'yellows', 'yc'].includes(m)) return 'yellow';
    if (['red', 'reds', 'rc'].includes(m)) return 'red';
    return METRICS[m] ? m : 'goals';
}

/* ── Shared lookups ── */

async function getTournament(ctx, key) {
    const resolved = await resolveTournament(ctx.guildId, key || ctx.tournamentKey || null, {
        includeCompleted: true
    });

    return resolved.tournament || null;
}

async function findTeam(guildId, name) {
    if (!name) return null;

    const clean = String(name).trim();

    let team = await Team.findOne({
        guildId,
        name: { $regex: new RegExp(`^${escapeRegex(clean)}$`, 'i') }
    }).lean();

    if (team) return team;

    return Team.findOne({
        guildId,
        name: { $regex: new RegExp(escapeRegex(clean), 'i') }
    }).lean();
}

async function findPlayer(guildId, name) {
    if (!name) return null;

    const clean = String(name).trim();

    let player = await Player.findOne({
        guildId,
        name: { $regex: new RegExp(`^${escapeRegex(clean)}$`, 'i') }
    }).lean();

    if (player) return player;

    player = await Player.findOne({
        guildId,
        discordUsername: clean.toLowerCase()
    }).lean();

    if (player) return player;

    return Player.findOne({
        guildId,
        name: { $regex: new RegExp(escapeRegex(clean), 'i') }
    }).lean();
}

async function teamEntry(guildId, tournament, teamId) {
    return TournamentTeam.findOne({
        guildId,
        tournamentId: tournament._id,
        teamId,
        isActive: true
    }).lean();
}

/** League table for a tournament (optionally a single group). */
async function buildStandings(guildId, tournament, groupKey = null) {
    const query = { guildId, tournamentId: tournament._id, isActive: true };
    if (groupKey) query.groupKey = groupKey;

    const entries = await TournamentTeam.find(query).lean();
    const teams = await Team.find({ guildId, _id: { $in: entries.map(e => e.teamId) } }).lean();
    const byId = new Map(teams.map(t => [String(t._id), t]));

    const rows = entries
        .map(e => {
            const s = e.stats || {};
            const gd = (s.gf || 0) - (s.ga || 0);
            return {
                team: byId.get(String(e.teamId))?.name || e.teamNameSnapshot || 'Unknown',
                teamId: String(e.teamId),
                group: e.groupKey || null,
                played: s.played || 0,
                wins: s.wins || 0,
                draws: s.draws || 0,
                losses: s.losses || 0,
                gf: s.gf || 0,
                ga: s.ga || 0,
                gd,
                points: s.points || 0
            };
        })
        .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team));

    rows.forEach((r, i) => { r.position = i + 1; });

    return rows;
}

async function teamFixtures(guildId, tournament, team) {
    return Fixture.find({
        guildId,
        tournamentId: tournament._id,
        $or: [
            { homeTeamId: team._id },
            { awayTeamId: team._id },
            { homeTeam: team.name },
            { awayTeam: team.name }
        ]
    })
        .sort({ matchNumber: 1, scheduledAt: 1 })
        .lean();
}

function sideOf(fixture, team) {
    return String(fixture.homeTeamId) === String(team._id) ||
        fixture.homeTeam === team.name
        ? 'home'
        : 'away';
}

function resultFor(fixture, team) {
    const home = fixture.result?.home;
    const away = fixture.result?.away;

    if (home == null || away == null) return null;

    const isHome = sideOf(fixture, team) === 'home';
    const scored = isHome ? home : away;
    const conceded = isHome ? away : home;

    return {
        outcome: scored > conceded ? 'win' : scored === conceded ? 'draw' : 'loss',
        score: `${home}-${away}`,
        opponent: isHome ? fixture.awayTeam : fixture.homeTeam,
        matchNumber: fixture.matchNumber,
        date: fixture.scheduledAt || fixture.updatedAt
    };
}

function fixtureLine(fixture, team) {
    const isHome = sideOf(fixture, team) === 'home';
    return {
        matchNumber: fixture.matchNumber,
        phase: fixture.phase,
        opponent: isHome ? fixture.awayTeam : fixture.homeTeam,
        homeAway: isHome ? 'home' : 'away',
        venue: fixture.venueName || '',
        status: fixture.status,
        scheduledAt: fixture.scheduledAt ? new Date(fixture.scheduledAt).toISOString() : null,
        score: fixture.result?.home != null ? `${fixture.result.home}-${fixture.result.away}` : null,
        group: fixture.groupKey || null
    };
}

async function playerRow(guildId, tournament, player) {
    if (!player) return null;

    const entry = await TournamentPlayer.findOne({
        guildId,
        tournamentId: tournament._id,
        playerId: player._id,
        isActive: true
    }).lean();

    const team = entry?.teamId
        ? await Team.findOne({ guildId, _id: entry.teamId }).lean()
        : null;

    return {
        name: player.name,
        discordId: player.discordID || null,
        team: team?.name || entry?.teamNameSnapshot || null,
        isCaptain: !!entry?.isCaptain,
        isViceCaptain: !!entry?.isViceCaptain,
        stats: entry?.stats || null,
        inTournament: !!entry
    };
}

async function leadersFor(guildId, tournament, metric = 'goals', limit = 10, teamId = null) {
    const key = normMetric(metric);
    const sortField = METRICS[key] || METRICS.goals;

    const query = { guildId, tournamentId: tournament._id, isActive: true };
    if (teamId) query.teamId = teamId;

    const entries = await TournamentPlayer.find(query)
        .sort({ [sortField]: -1, 'stats.goals': -1 })
        .limit(limit)
        .lean();

    const players = await Player.find({ guildId, _id: { $in: entries.map(e => e.playerId) } }).lean();
    const byId = new Map(players.map(p => [String(p._id), p]));

    return entries.map((e, i) => ({
        rank: i + 1,
        player: byId.get(String(e.playerId))?.name || e.playerNameSnapshot || 'Unknown',
        discordId: byId.get(String(e.playerId))?.discordID || null,
        team: e.teamNameSnapshot || null,
        value: e.stats?.[key] ?? 0,
        metric: METRIC_LABELS[key]
    }));
}

async function playerStanding(guildId, tournament, player, metric) {
    const key = normMetric(metric);
    const sortField = METRICS[key];

    const entry = await TournamentPlayer.findOne({
        guildId,
        tournamentId: tournament._id,
        playerId: player._id,
        isActive: true
    }).lean();

    if (!entry) return null;

    const value = entry.stats?.[key] ?? 0;
    const better = await TournamentPlayer.countDocuments({
        guildId,
        tournamentId: tournament._id,
        isActive: true,
        [sortField]: { $gt: value }
    });

    return { metric: METRIC_LABELS[key], value, rank: better + 1 };
}

/* ── Individual tools ── */

const TOOLS = {

    async list_tournaments({ ctx }) {
        const list = await getSelectableTournaments(ctx.guildId, { includeCompleted: true });
        return {
            tournaments: list.map(t => ({
                key: t.tournamentKey,
                name: t.name,
                format: t.formatType,
                phase: t.currentPhase,
                completed: t.currentPhase === 'completed'
            }))
        };
    },

    async tournament_info({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        if (!tournament) return { error: 'no tournament found' };

        const teams = await TournamentTeam.countDocuments({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            isActive: true
        });

        const fixtures = await Fixture.countDocuments({
            guildId: ctx.guildId,
            tournamentId: tournament._id
        });

        const played = await Fixture.countDocuments({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            status: 'Played'
        });

        return {
            key: tournament.tournamentKey,
            name: tournament.name,
            emoji: tournament.emoji || null,
            format: tournament.formatType,
            phase: tournament.currentPhase,
            groups: tournament.groupCount || 0,
            qualificationSpotsPerGroup: tournament.qualificationSpotsPerGroup || 0,
            teams,
            fixtures,
            played,
            remaining: fixtures - played
        };
    },

    async my_profile({ ctx }) {
        const tournament = await getTournament(ctx);
        const player = await Player.findOne({ guildId: ctx.guildId, discordID: String(ctx.userId) }).lean();

        if (!player) return { error: 'this user has no player profile in this server' };

        const row = await playerRow(ctx.guildId, tournament, player);

        return {
            tournament: tournament?.name || null,
            player: row?.name || player.name,
            team: row?.team || 'free agent',
            isCaptain: row?.isCaptain || false,
            stats: row?.stats || player.stats || null
        };
    },

    async my_stats({ ctx, args }) {
        const profile = await TOOLS.my_profile({ ctx });
        if (profile.error) return profile;

        const key = normMetric(args.metric);

        return {
            player: profile.player,
            team: profile.team,
            tournament: profile.tournament,
            metric: METRIC_LABELS[key],
            value: profile.stats?.[key] ?? 0
        };
    },

    async my_team({ ctx }) {
        const tournament = await getTournament(ctx);
        const player = await Player.findOne({ guildId: ctx.guildId, discordID: String(ctx.userId) }).lean();
        if (!player) return { error: 'no player profile' };

        const entry = await TournamentPlayer.findOne({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            playerId: player._id,
            isActive: true
        }).lean();

        if (!entry?.teamId) return { error: 'this user is not on a team in this tournament' };

        const team = await Team.findOne({ guildId: ctx.guildId, _id: entry.teamId }).lean();
        const standings = await buildStandings(ctx.guildId, tournament);
        const row = standings.find(r => r.teamId === String(team._id));

        return {
            team: team?.name,
            group: row?.group || null,
            position: row?.position || null,
            played: row?.played ?? 0,
            points: row?.points ?? 0,
            record: row ? `${row.wins}W ${row.draws}D ${row.losses}L` : null,
            goalDifference: row?.gd ?? 0
        };
    },

    async my_next_match({ ctx }) {
        const tournament = await getTournament(ctx);
        const player = await Player.findOne({ guildId: ctx.guildId, discordID: String(ctx.userId) }).lean();
        if (!player) return { error: 'no player profile' };

        const entry = await TournamentPlayer.findOne({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            playerId: player._id,
            isActive: true
        }).lean();

        if (!entry?.teamId) return { error: 'this user is not on a team in this tournament' };

        const team = await Team.findOne({ guildId: ctx.guildId, _id: entry.teamId }).lean();
        const fixtures = await teamFixtures(ctx.guildId, tournament, team);
        const next = fixtures.find(f => f.status === 'Pending' || f.status === 'Live');

        if (!next) return { team: team?.name, next: null, note: 'no upcoming fixtures' };

        return { team: team?.name, tournament: tournament.name, next: fixtureLine(next, team) };
    },

    async team_next_match({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const fixtures = await teamFixtures(ctx.guildId, tournament, team);
        const next = fixtures.find(f => f.status === 'Pending' || f.status === 'Live');

        return next
            ? { team: team.name, next: fixtureLine(next, team) }
            : { team: team.name, next: null, note: 'no upcoming fixtures' };
    },

    async team_form({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const fixtures = await teamFixtures(ctx.guildId, tournament, team);
        const played = fixtures.filter(f => f.status === 'Played');
        const lastN = Number(args.lastN) > 0 ? Number(args.lastN) : 5;

        const form = played
            .slice(-lastN)
            .map(f => resultFor(f, team))
            .filter(Boolean)
            .map(r => ({ outcome: r.outcome, score: r.score, opponent: r.opponent, matchNumber: r.matchNumber }));

        const wins = form.filter(f => f.outcome === 'win').length;
        const draws = form.filter(f => f.outcome === 'draw').length;
        const losses = form.filter(f => f.outcome === 'loss').length;

        return { team: team.name, lastN, sequence: form.map(f => f.outcome[0].toUpperCase()).join(''), wins, draws, losses, matches: form };
    },

    async standings({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const rows = await buildStandings(ctx.guildId, tournament, args.group || null);

        return {
            tournament: tournament.name,
            group: args.group || 'all',
            table: rows.map(r => ({
                pos: r.position,
                team: r.team,
                played: r.played,
                wins: r.wins,
                draws: r.draws,
                losses: r.losses,
                gf: r.gf,
                ga: r.ga,
                gd: r.gd,
                points: r.points
            }))
        };
    },

    async team_position({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const rows = await buildStandings(ctx.guildId, tournament);
        const row = rows.find(r => r.teamId === String(team._id));
        if (!row) return { error: `${team.name} is not in ${tournament.name}` };

        return {
            team: team.name,
            tournament: tournament.name,
            position: row.position,
            of: rows.length,
            group: row.group,
            points: row.points,
            played: row.played,
            gd: row.gd,
            gapToLeader: (rows[0]?.points ?? 0) - row.points
        };
    },

    async team_schedule({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const fixtures = await teamFixtures(ctx.guildId, tournament, team);
        const upcoming = fixtures.filter(f => f.status === 'Pending' || f.status === 'Live');

        return { team: team.name, upcoming: upcoming.slice(0, 6).map(f => fixtureLine(f, team)) };
    },

    async team_results({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const fixtures = await teamFixtures(ctx.guildId, tournament, team);
        const results = fixtures
            .filter(f => f.status === 'Played')
            .slice(-6)
            .map(f => resultFor(f, team))
            .filter(Boolean);

        return { team: team.name, results };
    },

    async leaders({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 15);
        const list = await leadersFor(ctx.guildId, tournament, args.metric, limit);

        return {
            tournament: tournament.name,
            metric: METRIC_LABELS[normMetric(args.metric)],
            leaders: list
        };
    },

    async player_rank({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const player = args.player
            ? await findPlayer(ctx.guildId, args.player)
            : await Player.findOne({ guildId: ctx.guildId, discordID: String(ctx.userId) }).lean();

        if (!player) return { error: `player "${args.player || 'you'}" not found` };

        const standing = await playerStanding(ctx.guildId, tournament, player, args.metric);
        if (!standing) return { error: `${player.name} has no entry in ${tournament.name}` };

        return { player: player.name, tournament: tournament.name, ...standing };
    },

    async gap_to_lead({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const player = args.player
            ? await findPlayer(ctx.guildId, args.player)
            : await Player.findOne({ guildId: ctx.guildId, discordID: String(ctx.userId) }).lean();

        if (!player) return { error: 'player not found' };

        const key = normMetric(args.metric);
        const standing = await playerStanding(ctx.guildId, tournament, player, key);
        if (!standing) return { error: 'no tournament entry' };

        const top = (await leadersFor(ctx.guildId, tournament, key, 1))[0];
        const leaderValue = top?.value ?? standing.value;

        return {
            player: player.name,
            metric: METRIC_LABELS[key],
            value: standing.value,
            rank: standing.rank,
            leader: top?.player || null,
            leaderValue,
            behind: Math.max(0, leaderValue - standing.value),
            tied: standing.value === leaderValue && standing.rank === 1
        };
    },

    async qualification_gap({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const rows = await buildStandings(ctx.guildId, tournament);
        const row = rows.find(r => r.teamId === String(team._id));
        if (!row) return { error: `${team.name} is not in ${tournament.name}` };

        const spots = tournament.qualificationSpotsPerGroup || 0;

        if (!spots) {
            return { team: team.name, note: 'no qualification spots configured for this tournament', position: row.position, points: row.points };
        }

        const sameGroup = row.group ? rows.filter(r => r.group === row.group) : rows;

        if (row.position <= spots) {
            const chaser = sameGroup[spots] || null;
            return {
                team: team.name,
                position: row.position,
                spots,
                qualified: true,
                cushion: chaser ? row.points - chaser.points : null,
                note: 'currently inside the qualification places'
            };
        }

        const cutoff = sameGroup[spots - 1];
        const gap = cutoff ? cutoff.points - row.points : null;

        const fixtures = await teamFixtures(ctx.guildId, tournament, team);
        const remaining = fixtures.filter(f => f.status === 'Pending' || f.status === 'Live').length;

        return {
            team: team.name,
            position: row.position,
            spots,
            qualified: false,
            pointsBehind: gap,
            remainingMatches: remaining,
            winsNeededApprox: gap != null ? Math.ceil(gap / 3) : null,
            maxPointsPossible: row.points + remaining * 3,
            note: 'wins needed assumes the team above does not gain more points'
        };
    },

    async team_top_performer({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const list = await leadersFor(ctx.guildId, tournament, args.metric, 3, team._id);

        return {
            team: team.name,
            metric: METRIC_LABELS[normMetric(args.metric)],
            performers: list
        };
    },

    async squad({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const entries = await TournamentPlayer.find({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            teamId: team._id,
            isActive: true
        }).lean();

        const players = await Player.find({ guildId: ctx.guildId, _id: { $in: entries.map(e => e.playerId) } }).lean();
        const byId = new Map(players.map(p => [String(p._id), p]));

        return {
            team: team.name,
            size: entries.length,
            players: entries.map(e => ({
                name: byId.get(String(e.playerId))?.name || e.playerNameSnapshot,
                discordId: byId.get(String(e.playerId))?.discordID || null,
                captain: !!e.isCaptain,
                viceCaptain: !!e.isViceCaptain,
                goals: e.stats?.goals || 0,
                assists: e.stats?.assists || 0
            }))
        };
    },

    async captain_of({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const entry = await teamEntry(ctx.guildId, tournament, team._id);
        const captainId = entry?.captainID || team.captainID || null;
        const viceId = entry?.viceCaptainID || team.viceCaptainID || null;

        const captain = captainId ? await Player.findOne({ guildId: ctx.guildId, discordID: String(captainId) }).lean() : null;
        const vice = viceId ? await Player.findOne({ guildId: ctx.guildId, discordID: String(viceId) }).lean() : null;

        return {
            team: team.name,
            captain: captain ? { name: captain.name, discordId: captainId } : null,
            viceCaptain: vice ? { name: vice.name, discordId: viceId } : null
        };
    },

    async head_to_head({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const a = await findTeam(ctx.guildId, args.teamA);
        const b = await findTeam(ctx.guildId, args.teamB);

        if (!a || !b) return { error: 'one or both teams not found' };

        const fixtures = await Fixture.find({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            $or: [
                { homeTeamId: a._id, awayTeamId: b._id },
                { homeTeamId: b._id, awayTeamId: a._id },
                { homeTeam: a.name, awayTeam: b.name },
                { homeTeam: b.name, awayTeam: a.name }
            ]
        }).sort({ matchNumber: 1 }).lean();

        let aWins = 0, bWins = 0, draws = 0;

        const matches = fixtures.map(f => {
            const home = f.result?.home;
            const away = f.result?.away;

            let winner = null;

            if (home != null && away != null) {
                const homeIsA = String(f.homeTeamId) === String(a._id) || f.homeTeam === a.name;
                const aScore = homeIsA ? home : away;
                const bScore = homeIsA ? away : home;

                if (aScore > bScore) { winner = a.name; aWins++; }
                else if (bScore > aScore) { winner = b.name; bWins++; }
                else { winner = 'draw'; draws++; }
            }

            return {
                matchNumber: f.matchNumber,
                score: home != null ? `${home}-${away}` : null,
                status: f.status,
                winner,
                scheduledAt: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : null
            };
        });

        return {
            teamA: a.name,
            teamB: b.name,
            summary: { [a.name]: aWins, [b.name]: bWins, draws },
            matches
        };
    },

    async fixture_info({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const n = Number(args.matchNumber);
        if (!n) return { error: 'matchNumber required' };

        const fixture = await Fixture.findOne({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            matchNumber: n
        }).lean();

        if (!fixture) return { error: `fixture #${n} not found` };

        return {
            matchNumber: fixture.matchNumber,
            phase: fixture.phase,
            group: fixture.groupKey || null,
            home: fixture.homeTeam,
            away: fixture.awayTeam,
            status: fixture.status,
            venue: fixture.venueName || '',
            scheduledAt: fixture.scheduledAt ? new Date(fixture.scheduledAt).toISOString() : null,
            score: fixture.result?.home != null ? `${fixture.result.home}-${fixture.result.away}` : null,
            notes: fixture.notes || ''
        };
    },

    async recent_results({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const limit = Math.min(Number(args.limit) || 5, 20);

        const fixtures = await Fixture.find({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            status: 'Played'
        }).sort({ updatedAt: -1, matchNumber: -1 }).limit(limit).lean();

        return {
            tournament: tournament.name,
            results: fixtures.map(f => ({
                matchNumber: f.matchNumber,
                home: f.homeTeam,
                away: f.awayTeam,
                score: `${f.result?.home ?? '-'}-${f.result?.away ?? '-'}`,
                phase: f.phase
            }))
        };
    },

    async upcoming_fixtures({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const limit = Math.min(Number(args.limit) || 5, 20);

        const fixtures = await Fixture.find({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            status: { $in: ['Pending', 'Live'] }
        }).sort({ scheduledAt: 1, matchNumber: 1 }).limit(limit).lean();

        return {
            tournament: tournament.name,
            upcoming: fixtures.map(f => ({
                matchNumber: f.matchNumber,
                home: f.homeTeam,
                away: f.awayTeam,
                phase: f.phase,
                scheduledAt: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : null,
                venue: f.venueName || ''
            }))
        };
    },

    async free_agents({ ctx }) {
        const tournament = await getTournament(ctx);

        const entries = await TournamentPlayer.find({
            guildId: ctx.guildId,
            tournamentId: tournament._id,
            isActive: true,
            teamId: null
        }).lean();

        const players = await Player.find({ guildId: ctx.guildId, _id: { $in: entries.map(e => e.playerId) } }).lean();
        const byId = new Map(players.map(p => [String(p._id), p]));

        return {
            tournament: tournament.name,
            count: entries.length,
            freeAgents: entries.slice(0, 20).map(e => ({
                name: byId.get(String(e.playerId))?.name || e.playerNameSnapshot,
                discordId: byId.get(String(e.playerId))?.discordID || null
            }))
        };
    },

    async compare_players({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const a = await findPlayer(ctx.guildId, args.playerA);
        const b = await findPlayer(ctx.guildId, args.playerB);

        if (!a || !b) return { error: 'one or both players not found' };

        const keys = ['goals', 'assists', 'saves', 'tackles', 'interceptions', 'mvps'];

        const rowsA = await TournamentPlayer.findOne({ guildId: ctx.guildId, tournamentId: tournament._id, playerId: a._id, isActive: true }).lean();
        const rowsB = await TournamentPlayer.findOne({ guildId: ctx.guildId, tournamentId: tournament._id, playerId: b._id, isActive: true }).lean();

        const pick = rows => Object.fromEntries(keys.map(k => [k, rows?.stats?.[k] ?? 0]));

        return {
            [a.name]: { team: rowsA?.teamNameSnapshot || null, ...pick(rowsA) },
            [b.name]: { team: rowsB?.teamNameSnapshot || null, ...pick(rowsB) }
        };
    },

    async trophies_of({ ctx, args }) {
        const { UserProfile } = require('../../models/Tournament');

        const player = args.player
            ? await findPlayer(ctx.guildId, args.player)
            : await Player.findOne({ guildId: ctx.guildId, discordID: String(ctx.userId) }).lean();

        if (!player) return { error: 'player not found' };

        const profile = await UserProfile.findOne({
            guildId: ctx.guildId,
            discordID: player.discordID
        }).lean();

        return {
            player: player.name,
            trophies: (profile?.trophies || []).map(t => ({ name: t.name, tournament: t.tournamentName || t.tournamentKey, season: t.season })),
            awards: (profile?.awards || []).map(a => ({ name: a.name, tournament: a.tournamentName || a.tournamentKey }))
        };
    },

    /** Composite: everything you need to write a scouting report on a team. */
    async scout_report({ ctx, args }) {
        const tournament = await getTournament(ctx, args.tournament);
        const team = await findTeam(ctx.guildId, args.team);
        if (!team) return { error: `team "${args.team}" not found` };

        const [position, form, strikers, creators, defenders, keeper, results, schedule, table] = await Promise.all([
            TOOLS.team_position({ ctx, args: { team: team.name } }),
            TOOLS.team_form({ ctx, args: { team: team.name, lastN: 5 } }),
            TOOLS.team_top_performer({ ctx, args: { team: team.name, metric: 'goals' } }),
            TOOLS.team_top_performer({ ctx, args: { team: team.name, metric: 'assists' } }),
            TOOLS.team_top_performer({ ctx, args: { team: team.name, metric: 'tackles' } }),
            TOOLS.team_top_performer({ ctx, args: { team: team.name, metric: 'saves' } }),
            TOOLS.team_results({ ctx, args: { team: team.name } }),
            TOOLS.team_schedule({ ctx, args: { team: team.name } }),
            buildStandings(ctx.guildId, tournament)
        ]);

        const row = table.find(r => r.teamId === String(team._id));

        return {
            team: team.name,
            tournament: tournament.name,
            table: row
                ? { position: row.position, played: row.played, points: row.points, gf: row.gf, ga: row.ga, gd: row.gd, wins: row.wins, draws: row.draws, losses: row.losses }
                : null,
            form,
            topScorer: strikers.performers?.[0] || null,
            topCreator: creators.performers?.[0] || null,
            topTackler: defenders.performers?.[0] || null,
            keeper: keeper.performers?.[0] || null,
            recentResults: results.results,
            upcoming: schedule.upcoming,
            squad: await TOOLS.squad({ ctx, args: { team: team.name } })
        };
    },

    async scope_note() {
        return {
            note: 'Answers about tournaments come from this server\'s database. If a tool returned no data, say you do not have it — never invent numbers.'
        };
    }
};

/* ── Descriptions for the planner ── */

const TOOL_LIST = [
    { name: 'tournament_info', description: 'Basic info about the current tournament (phase, teams, fixtures).', args: { tournament: 'optional key' } },
    { name: 'list_tournaments', description: 'List every tournament in this server with its key and phase.', args: {} },
    { name: 'my_profile', description: 'The asking user\'s profile: team, captaincy and stats.', args: {} },
    { name: 'my_stats', description: 'One stat of the asking user.', args: { metric: 'goals|assists|saves|tackles|interceptions|mvps|played' } },
    { name: 'my_team', description: 'The asking user\'s team: position, points, record.', args: {} },
    { name: 'my_next_match', description: 'The asking user\'s next fixture.', args: {} },
    { name: 'team_next_match', description: 'A team\'s next fixture.', args: { team: 'team name' } },
    { name: 'team_form', description: 'A team\'s recent results (W/D/L sequence).', args: { team: 'team name', lastN: 'number, default 5' } },
    { name: 'standings', description: 'League table, optionally one group.', args: { group: 'optional group key' } },
    { name: 'team_position', description: 'A team\'s position, points and gap to the leader.', args: { team: 'team name' } },
    { name: 'team_schedule', description: 'A team\'s upcoming fixtures.', args: { team: 'team name' } },
    { name: 'team_results', description: 'A team\'s recent results.', args: { team: 'team name' } },
    { name: 'leaders', description: 'Leaderboard for a statistic (golden boot, assists, saves, tackles, interceptions, MVPs).', args: { metric: 'metric', limit: 'number' } },
    { name: 'player_rank', description: 'A player\'s rank in a statistic.', args: { player: 'name (optional, defaults to the asker)', metric: 'metric' } },
    { name: 'gap_to_lead', description: 'How far a player is from leading a statistic.', args: { player: 'name (optional)', metric: 'metric' } },
    { name: 'qualification_gap', description: 'Whether a team qualifies and how many points/wins it needs.', args: { team: 'team name' } },
    { name: 'team_top_performer', description: 'A team\'s best player for a statistic.', args: { team: 'team name', metric: 'metric' } },
    { name: 'squad', description: 'A team\'s roster.', args: { team: 'team name' } },
    { name: 'captain_of', description: 'A team\'s captain and vice captain.', args: { team: 'team name' } },
    { name: 'head_to_head', description: 'History between two teams.', args: { teamA: 'team', teamB: 'team' } },
    { name: 'fixture_info', description: 'Details of one fixture by match number.', args: { matchNumber: 'number' } },
    { name: 'recent_results', description: 'Latest results in the tournament.', args: { limit: 'number' } },
    { name: 'upcoming_fixtures', description: 'Next fixtures in the tournament.', args: { limit: 'number' } },
    { name: 'free_agents', description: 'Players without a team in this tournament.', args: {} },
    { name: 'compare_players', description: 'Compare two players stat by stat.', args: { playerA: 'name', playerB: 'name' } },
    { name: 'trophies_of', description: 'Trophies and awards of a player.', args: { player: 'name (optional)' } },
    { name: 'scout_report', description: 'Full scouting report on a team (form, stars, results, table).', args: { team: 'team name' } }
];

/**
 * Run a tool by name.
 * Returns the tool result, or { error } when the tool is unknown / arguments are bad.
 */
async function runTool(name, args = {}, ctx = {}) {
    const tool = TOOLS[name];

    if (!tool) return { error: `unknown tool "${name}"` };

    try {
        return await tool({ ctx, args: args || {} });
    } catch (error) {
        console.error(`[ai/tournamentTools] ${name} failed:`, error?.message || error);
        return { error: `${name} failed` };
    }
}

module.exports = {
    runTool,
    TOOL_LIST,
    TOOLS,
    normMetric,
    METRIC_LABELS,
    findTeam,
    findPlayer,
    buildStandings
};
