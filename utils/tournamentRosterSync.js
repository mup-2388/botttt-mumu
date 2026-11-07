const {
    Team,
    Player,
    TournamentTeam,
    TournamentPlayer
} = require('../models/Tournament');
const {
    getUserLeadershipRole
} = require('./tournamentLeadership');

/**
 * Enroll global players into active tournament teams when they have no active
 * tournament assignment. Existing withdrawals and tournament-specific moves
 * are preserved unless the organizer explicitly requests withdrawal reactivation.
 */
async function syncTournamentRosterPlayers(guildId, tournament, {
    teamName = null,
    reactivateWithdrawn = false
} = {}) {
    if (!guildId || !tournament?._id) {
        return emptyResult();
    }

    const teamEntries = await TournamentTeam.find({
        guildId,
        tournamentId: tournament._id,
        isActive: true
    });

    if (!teamEntries.length) {
        return { ...emptyResult(), skippedTeams: [{ teamName: null, reason: 'no active teams are registered in this tournament' }] };
    }

    const teamIds = teamEntries.map(entry => idOf(entry.teamId)).filter(Boolean);
    const teams = await Team.find({ guildId, _id: { $in: teamIds } });
    let selectedTeams = teams;

    if (teamName) {
        const wanted = normalize(teamName);
        const matches = teams.filter(team => normalize(team.name) === wanted);
        if (matches.length > 1) {
            return {
                ...emptyResult(),
                skippedTeams: [{ teamName, reason: 'team name is ambiguous; no players were changed' }]
            };
        }
        if (!matches.length) {
            return {
                ...emptyResult(),
                skippedTeams: [{ teamName, reason: 'team is not registered and active in this tournament' }]
            };
        }
        selectedTeams = matches;
    }

    const selectedIds = new Set(selectedTeams.map(team => idOf(team._id)));
    const selectedEntries = teamEntries.filter(entry => selectedIds.has(idOf(entry.teamId)));
    const teamById = new Map(selectedTeams.map(team => [idOf(team._id), team]));
    const globalPlayers = selectedIds.size
        ? await Player.find({ guildId, teamId: { $in: [...selectedIds] } })
        : [];
    const playerIds = [...new Set(globalPlayers.map(player => idOf(player._id)).filter(Boolean))];
    const existingEntries = playerIds.length
        ? await TournamentPlayer.find({
            guildId,
            tournamentId: tournament._id,
            playerId: { $in: playerIds }
        })
        : [];

    const existingByPlayerId = new Map(
        existingEntries.map(entry => [idOf(entry.playerId), entry])
    );
    const playersByTeam = new Map();
    for (const player of globalPlayers) {
        const teamId = idOf(player.teamId);
        if (!playersByTeam.has(teamId)) playersByTeam.set(teamId, []);
        playersByTeam.get(teamId).push(player);
    }

    const result = emptyResult();
    if (!teamName) {
        for (const entry of teamEntries) {
            if (!teamById.has(idOf(entry.teamId))) {
                result.skippedTeams.push({
                    teamName: entry.teamNameSnapshot || idOf(entry.teamId) || 'Unknown team',
                    reason: 'team record is missing'
                });
            }
        }
    }

    const activeLeaderIds = new Map();
    for (const entry of selectedEntries) {
        const team = teamById.get(idOf(entry.teamId));
        if (team) activeLeaderIds.set(idOf(team._id), { team, entry });
    }

    for (const [teamId, { team, entry }] of activeLeaderIds) {
        for (const player of playersByTeam.get(teamId) || []) {
            const existing = existingByPlayerId.get(idOf(player._id));
            const role = getUserLeadershipRole({
                userId: player.discordID,
                team,
                entry
            });
            const leaderFields = {
                isCaptain: role === 'captain',
                isViceCaptain: role === 'vice'
            };
            const baseFields = {
                guildId,
                tournamentId: tournament._id,
                playerId: player._id,
                teamId: team._id,
                playerNameSnapshot: player.name,
                teamNameSnapshot: team.name
            };

            if (!existing) {
                await TournamentPlayer.findOneAndUpdate(
                    { guildId, tournamentId: tournament._id, playerId: player._id },
                    {
                        $setOnInsert: {
                            ...baseFields,
                            ...leaderFields,
                            isActive: true
                        }
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
                result.added++;
                continue;
            }

            if (existing.isActive === false) {
                if (!reactivateWithdrawn) {
                    result.withdrawnPreserved++;
                    result.examples.push({
                        playerName: player.name,
                        teamName: team.name,
                        reason: 'withdrawn tournament entry left inactive'
                    });
                    continue;
                }

                await TournamentPlayer.updateOne(
                    { _id: existing._id },
                    { $set: { ...baseFields, ...leaderFields, isActive: true } }
                );
                result.reactivated++;
                continue;
            }

            if (!existing.teamId) {
                result.freeAgentsPreserved++;
                result.examples.push({
                    playerName: player.name,
                    teamName: team.name,
                    reason: 'active tournament free agent left unattached'
                });
                continue;
            }

            if (idOf(existing.teamId) !== teamId) {
                result.otherTeamsPreserved++;
                result.examples.push({
                    playerName: player.name,
                    teamName: team.name,
                    reason: `already assigned to another tournament team (${existing.teamNameSnapshot || idOf(existing.teamId)})`
                });
                continue;
            }

            await TournamentPlayer.updateOne(
                { _id: existing._id },
                {
                    $set: {
                        playerNameSnapshot: player.name,
                        teamNameSnapshot: team.name,
                        ...leaderFields
                    }
                }
            );
            result.alreadyPresent++;
        }
    }

    return result;
}

function emptyResult() {
    return {
        added: 0,
        alreadyPresent: 0,
        reactivated: 0,
        withdrawnPreserved: 0,
        freeAgentsPreserved: 0,
        otherTeamsPreserved: 0,
        examples: [],
        skippedTeams: []
    };
}

function idOf(value) {
    if (value == null) return null;
    return String(value._id || value);
}

function normalize(value) {
    return String(value || '').trim().toLowerCase();
}

module.exports = {
    syncTournamentRosterPlayers
};
