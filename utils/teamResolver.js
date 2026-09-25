/**
 * teamResolver.js
 *
 * Shared team resolution for "your team" management commands
 * (setlogo, setstadium, setcolor) in a multi-tournament world.
 *
 * A user can manage more than one team:
 *  - their global team(s) (global captain / vice captain)
 *  - teams where they are the PER-TOURNAMENT captain / vice captain
 *    (created via the manual registration flow)
 *
 * Resolution rules:
 *  - organizer + team name        → any team by name
 *  - captain   + team name        → must be one of the user's managed teams
 *  - captain   + no team name     → global team (captain first, then VC);
 *                                   else the single managed team;
 *                                   else "ambiguous" (user is asked to pick)
 */

const { Team, TournamentTeam } = require('../models/Tournament');
const { escapeRegex } = require('./stringHelpers');

/**
 * Every team this user manages (global or per-tournament captain/VC).
 * Global teams first, then alphabetical.
 */
async function getManagedTeams(guildId, userId) {
    const globalTeams = await Team.find({
        guildId,
        $or: [{ captainID: userId }, { viceCaptainID: userId }]
    });

    const ids = new Set(globalTeams.map(t => String(t._id)));

    const tourEntries = await TournamentTeam.find({
        guildId,
        isActive: true,
        $or: [{ captainID: userId }, { viceCaptainID: userId }]
    });
    for (const entry of tourEntries) {
        if (entry.teamId) ids.add(String(entry.teamId));
    }

    const teams = [];
    for (const id of ids) {
        const team = await Team.findOne({ guildId, _id: id });
        if (team) teams.push(team);
    }

    const globalIds = new Set(globalTeams.map(t => String(t._id)));
    teams.sort((a, b) => {
        const aGlobal = globalIds.has(String(a._id)) ? 0 : 1;
        const bGlobal = globalIds.has(String(b._id)) ? 0 : 1;
        if (aGlobal !== bGlobal) return aGlobal - bGlobal;
        return a.name.localeCompare(b.name);
    });

    return teams;
}

/**
 * Parse an optional `team=<Name>` token from prefix args.
 * The name may span several args ("team=New Warriors <value>…"); the longest
 * match against the user's managed team names wins.
 *
 * Returns { teamName, rest } where rest is args without the token parts.
 */
async function parseTeamToken(guildId, userId, args) {
    const idx = args.findIndex(a => typeof a === 'string' && a.toLowerCase().startsWith('team='));
    if (idx === -1) {
        return { teamName: null, rest: [...args] };
    }

    const teams = await getManagedTeams(guildId, userId);
    const names = teams.map(t => t.name.toLowerCase());

    const parts = (args[idx].split('=').slice(1).join('=') || '')
        .split(/\s+/)
        .filter(Boolean);

    let name = parts.join(' ').trim();
    let end = idx + 1;

    // Greedy multi-word match against managed team names (max 4 extra args)
    for (let k = idx + 1; k < args.length && k < idx + 5; k++) {
        const candidate = [...parts, ...args.slice(idx + 1, k + 1)]
            .join(' ')
            .trim();
        if (names.includes(candidate.toLowerCase())) {
            name = candidate;
            end = k + 1;
            break;
        }
    }

    const rest = [...args.slice(0, idx), ...args.slice(end)];
    return { teamName: name || null, rest };
}

/**
 * Resolve the team a command should operate on.
 *
 * Returns one of:
 *   { status: 'ok', team }
 *   { status: 'not_found', teamName }
 *   { status: 'not_yours', teamName, teams }
 *   { status: 'ambiguous', teams }
 *   { status: 'none' }
 */
async function resolveManagedTeam({ guildId, userId, organizer, teamName }) {
    const name = String(teamName || '').trim();

    if (organizer && name) {
        const team = await Team.findOne({
            guildId,
            name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') }
        });
        return team
            ? { status: 'ok', team }
            : { status: 'not_found', teamName: name };
    }

    const teams = await getManagedTeams(guildId, userId);

    if (name) {
        const match = teams.find(t => t.name.toLowerCase() === name.toLowerCase());
        if (match) return { status: 'ok', team: match };

        const exists = await Team.findOne({
            guildId,
            name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') }
        });

        return exists
            ? { status: 'not_yours', teamName: name, teams }
            : { status: 'not_found', teamName: name };
    }

    // No name: prefer global captain team, then global VC team
    const globalCaptain = teams.find(t => t.captainID === userId);
    if (globalCaptain) return { status: 'ok', team: globalCaptain };

    const globalVC = teams.find(t => t.viceCaptainID === userId);
    if (globalVC) return { status: 'ok', team: globalVC };

    if (teams.length === 1) return { status: 'ok', team: teams[0] };
    if (teams.length > 1) return { status: 'ambiguous', teams };

    return { status: 'none' };
}

module.exports = {
    getManagedTeams,
    parseTeamToken,
    resolveManagedTeam
};
