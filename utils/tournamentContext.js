/**
 * tournamentContext.js
 *
 * "Who is this user, and which team do they belong to — INSIDE ONE tournament?"
 *
 * Teams and players are server-wide documents (Team / Player), so the global
 * Player.teamId / Team.captainID can still point at a team from an OLD
 * tournament (e.g. a finished Nations League) long after that tournament was
 * reset. Commands that used those global fields happily kept working for the
 * old team and refused to work for the new one.
 *
 * Everything here is anchored on the tournament's own entries:
 *   TournamentTeam   (team is registered in this tournament, per-tournament
 *                     captain / vice captain)
 *   TournamentPlayer (player is on a roster in this tournament)
 * so a team/player that is not part of the tournament is simply invisible.
 *
 * Global fields (Team.captainID, Team.viceCaptainID) are only honoured when the
 * team is registered in the tournament AND the entry has no per-tournament
 * override.
 */

const {
    Team,
    Player,
    TournamentTeam,
    TournamentPlayer
} = require('../models/Tournament');

const { resolveTournament } = require('./getTournament');

function sameId(a, b) {
    return a != null && b != null && String(a) === String(b);
}

/** Effective captain of a team in a tournament (per-tournament override > global). */
function effectiveCaptainId(entry, team) {
    return entry?.captainID || team?.captainID || null;
}

/**
 * Effective vice captain of a team in a tournament.
 * If the entry has its OWN captain (per-tournament captaincy) the global vice
 * captain is not inherited — only the entry's own vice captain counts.
 */
function effectiveViceCaptainId(entry, team) {
    if (entry?.viceCaptainID) return entry.viceCaptainID;
    if (entry?.captainID) return null;
    return team?.viceCaptainID || null;
}

/** Active team entries of a tournament, joined with their Team docs. */
async function getTournamentTeams(guildId, tournament) {
    const entries = await TournamentTeam.find({
        guildId,
        tournamentId: tournament._id,
        isActive: true
    });

    if (!entries.length) return [];

    const teams = await Team.find({
        guildId,
        _id: { $in: entries.map(e => e.teamId) }
    });
    const byId = new Map(teams.map(t => [String(t._id), t]));

    return entries
        .map(entry => ({ entry, team: byId.get(String(entry.teamId)) || null }))
        .filter(x => x.team);
}

/** One team's entry in a tournament → { entry, team } | null */
async function getTeamInTournament(guildId, tournament, teamId) {
    if (!teamId) return null;

    const entry = await TournamentTeam.findOne({
        guildId,
        tournamentId: tournament._id,
        teamId,
        isActive: true
    });
    if (!entry) return null;

    const team = await Team.findOne({ guildId, _id: teamId });
    return team ? { entry, team } : null;
}

/** Find a team by (case-insensitive) name, but ONLY inside this tournament. */
async function findTeamInTournamentByName(guildId, tournament, name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return null;

    const all = await getTournamentTeams(guildId, tournament);
    return all.find(x => x.team.name.toLowerCase() === wanted) || null;
}

/**
 * Resolve the user's team in this tournament.
 *
 * Returns:
 *   {
 *     team, entry,            // Team doc + TournamentTeam doc
 *     player,                 // global Player doc (may be null for a captain without a player doc)
 *     tournamentPlayer,       // TournamentPlayer doc (may be null)
 *     role,                   // 'captain' | 'vice' | 'player'
 *     isCaptain, isVice, canManage
 *   }
 * or null when the user is not part of any team in this tournament.
 */
async function getUserTeamInTournament(guildId, tournament, userId) {
    if (!tournament || !userId) return null;

    const all = await getTournamentTeams(guildId, tournament);

    const player = await Player.findOne({ guildId, discordID: String(userId) });

    // 1. Captain
    let hit = all.find(x => sameId(effectiveCaptainId(x.entry, x.team), userId));
    let role = hit ? 'captain' : null;

    // 2. Vice captain
    if (!hit) {
        hit = all.find(x => sameId(effectiveViceCaptainId(x.entry, x.team), userId));
        if (hit) role = 'vice';
    }

    // 3. Plain roster member (TournamentPlayer of this tournament)
    let tournamentPlayer = null;

    if (player) {
        tournamentPlayer = await TournamentPlayer.findOne({
            guildId,
            tournamentId: tournament._id,
            playerId: player._id,
            isActive: true,
            teamId: { $ne: null }
        });
    }

    if (!hit && tournamentPlayer) {
        hit = all.find(x => sameId(x.team._id, tournamentPlayer.teamId));
        if (hit) {
            role = tournamentPlayer.isCaptain
                ? 'captain'
                : tournamentPlayer.isViceCaptain ? 'vice' : 'player';
        }
    }

    if (!hit) return null;

    if (!tournamentPlayer || !sameId(tournamentPlayer.teamId, hit.team._id)) {
        tournamentPlayer = player
            ? await TournamentPlayer.findOne({
                guildId,
                tournamentId: tournament._id,
                playerId: player._id,
                teamId: hit.team._id,
                isActive: true
            })
            : null;
    }

    return {
        team: hit.team,
        entry: hit.entry,
        player,
        tournamentPlayer,
        role,
        isCaptain: role === 'captain',
        isVice: role === 'vice',
        canManage: role === 'captain' || role === 'vice'
    };
}

/**
 * Roster of a team INSIDE a tournament: [{ tp, player }]
 * (tp = TournamentPlayer, player = global Player doc)
 */
async function getTournamentRoster(guildId, tournament, teamId) {
    const tps = await TournamentPlayer.find({
        guildId,
        tournamentId: tournament._id,
        teamId,
        isActive: true
    });

    if (!tps.length) return [];

    const players = await Player.find({
        guildId,
        _id: { $in: tps.map(tp => tp.playerId) }
    });
    const byId = new Map(players.map(p => [String(p._id), p]));

    return tps
        .map(tp => ({ tp, player: byId.get(String(tp.playerId)) || null }))
        .filter(x => x.player);
}

/** Is `userId` rostered on `teamId` in this tournament? → TournamentPlayer | null */
async function getRosterMembership(guildId, tournament, teamId, discordId) {
    const player = await Player.findOne({ guildId, discordID: String(discordId) });
    if (!player) return { player: null, tournamentPlayer: null };

    const tournamentPlayer = await TournamentPlayer.findOne({
        guildId,
        tournamentId: tournament._id,
        playerId: player._id,
        teamId,
        isActive: true
    });

    return { player, tournamentPlayer };
}

/**
 * Teams the user can manage in this tournament (captain / vice).
 * Used by "your team" commands (setlogo, setcolor, setstadium, …).
 */
async function getManagedTeamsInTournament(guildId, tournament, userId) {
    const all = await getTournamentTeams(guildId, tournament);

    return all.filter(x =>
        sameId(effectiveCaptainId(x.entry, x.team), userId) ||
        sameId(effectiveViceCaptainId(x.entry, x.team), userId)
    );
}

/**
 * One-stop helper for captain-side commands.
 *
 * Resolves the tournament (explicit key, else the server DEFAULT) and the
 * actor's team inside it, and builds a ready-to-send error when something is off.
 *
 * need: 'member'  → any rostered member / captain / vice
 *       'manage'  → captain or vice captain
 *       'captain' → captain only
 *
 * Returns { tournament, ctx, error }  (error === null on success)
 */
async function resolveActorTeam({
    guildId,
    userId,
    tournamentKey = null,
    need = 'manage',
    noun = 'do this'
}) {
    const resolved = await resolveTournament(guildId, tournamentKey);

    if (!resolved.tournament) {
        return { tournament: null, ctx: null, error: resolved.error };
    }

    const tournament = resolved.tournament;
    const ctx = await getUserTeamInTournament(guildId, tournament, userId);

    if (!ctx) {
        return {
            tournament,
            ctx: null,
            error:
                `❌ You are not on a team in **${tournament.name}** (\`${tournament.tournamentKey}\`)` +
                (resolved.explicit ? '.' : ' — the server\'s default tournament.\n' +
                    'Managing a team in another tournament? Add `tournament=<key>`.')
        };
    }

    if (need === 'captain' && !ctx.isCaptain) {
        return {
            tournament,
            ctx,
            error: `❌ Only the team captain can ${noun} (**${ctx.team.name}** in **${tournament.name}**).`
        };
    }

    if (need === 'manage' && !ctx.canManage) {
        return {
            tournament,
            ctx,
            error: `❌ Only the team captain or vice captain can ${noun} (**${ctx.team.name}** in **${tournament.name}**).`
        };
    }

    return { tournament, ctx, error: null };
}

/**
 * Parse an optional `team=<Name>` token from prefix args, matching the name
 * (greedy, multi-word) against the teams registered in THIS tournament.
 * Returns { teamName, rest }.
 */
async function parseTeamTokenInTournament(guildId, tournament, args = []) {
    const idx = args.findIndex(a => typeof a === 'string' && a.toLowerCase().startsWith('team='));
    if (idx === -1) return { teamName: null, rest: [...args] };

    const all = await getTournamentTeams(guildId, tournament);
    const names = all.map(x => x.team.name.toLowerCase());

    const parts = (args[idx].split('=').slice(1).join('=') || '')
        .split(/\s+/)
        .filter(Boolean);

    let name = parts.join(' ').trim();
    let end = idx + 1;

    for (let k = idx + 1; k < args.length && k < idx + 5; k++) {
        const candidate = [...parts, ...args.slice(idx + 1, k + 1)].join(' ').trim();
        if (names.includes(candidate.toLowerCase())) {
            name = candidate;
            end = k + 1;
            break;
        }
    }

    return {
        teamName: name || null,
        rest: [...args.slice(0, idx), ...args.slice(end)]
    };
}

/**
 * Put a player on a team INSIDE one tournament (upserts their roster entry).
 *  - vacates a vice-captain seat on the team they leave
 *  - the global Player record follows only if it pointed at the old team or
 *    nowhere (never yanked away from a team of another tournament)
 *
 * `newTeam` may be null → the player becomes a free agent in this tournament.
 * `oldTeamId` is the team they leave (optional).
 */
async function assignPlayerToTeamInTournament({
    guildId,
    tournament,
    player,
    newTeam = null,
    oldTeamId = null
}) {
    const tp = await TournamentPlayer.findOneAndUpdate(
        { guildId, tournamentId: tournament._id, playerId: player._id },
        {
            $set: {
                guildId,
                tournamentId: tournament._id,
                playerId: player._id,
                teamId: newTeam ? newTeam._id : null,
                playerNameSnapshot: player.name,
                teamNameSnapshot: newTeam ? newTeam.name : 'FREE AGENT',
                isActive: true,
                isCaptain: false,
                isViceCaptain: false
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (oldTeamId && player.discordID) {
        await TournamentTeam.updateOne(
            {
                guildId,
                tournamentId: tournament._id,
                teamId: oldTeamId,
                viceCaptainID: String(player.discordID)
            },
            { $set: { viceCaptainID: null } }
        );
    }

    const followsGlobal =
        !player.teamId || (oldTeamId && String(player.teamId) === String(oldTeamId));

    if (followsGlobal) {
        await Player.updateOne(
            { _id: player._id },
            {
                $set: {
                    teamId: newTeam ? newTeam._id : null,
                    teamNameSnapshot: newTeam ? newTeam.name : 'FREE AGENT',
                    isCaptain: false,
                    isViceCaptain: false
                }
            }
        );
    }

    return tp;
}

module.exports = {
    assignPlayerToTeamInTournament,
    parseTeamTokenInTournament,
    resolveActorTeam,
    sameId,
    effectiveCaptainId,
    effectiveViceCaptainId,
    getTournamentTeams,
    getTeamInTournament,
    findTeamInTournamentByName,
    getUserTeamInTournament,
    getTournamentRoster,
    getRosterMembership,
    getManagedTeamsInTournament
};
