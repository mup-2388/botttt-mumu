const {
    Team,
    Player,
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer
} = require('../models/Tournament');

async function syncAllTeamsToTournament(guildId, tournament) {
    // Manual registration mode: this tournament is filled manually by
    // captains (/register ... tournament:<key>), never by auto-sync.
    if (!tournament || tournament.manualRegistration === true) {
        return {
            syncedTeams: 0,
            syncedPlayers: 0,
            skippedReason: 'manual_registration'
        };
    }

    const teams = await Team.find({ guildId }).sort({ createdAt: 1 });

    let syncedTeams = 0;
    let syncedPlayers = 0;

    for (const team of teams) {
        // Re-running /settournament repairs roster metadata without bringing
        // previously withdrawn teams or players back into the tournament.
        const result = await syncTeamToTournament(guildId, tournament, team, {
            preserveInactive: true,
            preserveInactivePlayers: true
        });
        if (result.teamSynced) syncedTeams++;
        syncedPlayers += result.playersSynced;
    }

    return { syncedTeams, syncedPlayers };
}

async function syncTeamToOpenTournaments(guildId, team) {
    /*
     * Only the server's DEFAULT tournament is auto-synced. Other tournaments
     * in the same server keep their own rosters (they are filled explicitly
     * with /register … tournament:<key> or /addplayer … tournament:<key>),
     * so a new tournament never inherits an older tournament's teams.
     *
     * Manual registration tournaments are excluded as well.
     */
    const { getDefaultTournamentKey } = require('./getTournament');
    const defaultKey = await getDefaultTournamentKey(guildId);

    const query = {
        guildId,
        registrationOpen: true,
        currentPhase: 'registration',
        manualRegistration: { $ne: true }
    };

    if (defaultKey) query.tournamentKey = defaultKey;

    const tournaments = await TournamentSettings.find(query);

    let syncedTournaments = 0;
    let syncedPlayers = 0;

    for (const tournament of tournaments) {
        const result = await syncTeamToTournament(guildId, tournament, team);
        if (result.teamSynced) syncedTournaments++;
        syncedPlayers += result.playersSynced;
    }

    return { syncedTournaments, syncedPlayers };
}

async function syncTeamToTournament(guildId, tournament, team, {
    preserveInactive = false,
    preserveInactivePlayers = false
} = {}) {
    if (!tournament || !team) {
        return { teamSynced: false, playersSynced: 0 };
    }

    const teamFilter = {
        guildId,
        tournamentId: tournament._id,
        teamId: team._id
    };
    const existingEntry = await TournamentTeam.findOne(teamFilter);

    // Bulk setup sync must not silently undo an organizer's withdrawal. The
    // explicit /addteamtotournament path still reactivates entries as before.
    if (preserveInactive && existingEntry?.isActive === false) {
        return { teamSynced: false, playersSynced: 0, skippedReason: 'team_inactive' };
    }

    if (tournament.teamCount > 0 && !existingEntry) {
        const currentCount = await TournamentTeam.countDocuments({
            guildId,
            tournamentId: tournament._id,
            isActive: true
        });

        if (currentCount >= tournament.teamCount) {
            return { teamSynced: false, playersSynced: 0, skippedReason: 'tournament_full' };
        }
    }

    const tournamentTeam = await TournamentTeam.findOneAndUpdate(
        teamFilter,
        {
            $set: {
                guildId,
                tournamentId: tournament._id,
                teamId: team._id,
                teamNameSnapshot: team.name,
                isActive: true
            },
            $setOnInsert: {
                groupKey: team.groupKey || null,
                stats: {
                    played: 0,
                    wins: 0,
                    draws: 0,
                    losses: 0,
                    gf: 0,
                    ga: 0,
                    points: 0
                }
            }
        },
        {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
        }
    );

    const players = await Player.find({
        guildId,
        teamId: team._id
    });

    let playersSynced = 0;

    for (const player of players) {
        const result = await syncPlayerToTournament(
            guildId,
            tournament,
            player,
            team,
            tournamentTeam,
            { preserveInactive: preserveInactivePlayers }
        );
        if (result?.isActive !== false) playersSynced++;
    }

    return { teamSynced: true, playersSynced };
}

async function syncPlayerToOpenTournaments(guildId, player) {
    const team = player.teamId
        ? await Team.findOne({ guildId, _id: player.teamId })
        : null;

    if (!team) return { syncedTournaments: 0 };

    const tournamentTeams = await TournamentTeam.find({
        guildId,
        teamId: team._id,
        isActive: true
    }).populate('tournamentId');

    let syncedTournaments = 0;

    for (const entry of tournamentTeams) {
        if (!entry.tournamentId) continue;

        // Manual registration tournaments are not touched by auto-sync.
        if (entry.tournamentId.manualRegistration === true) continue;

        await syncPlayerToTournament(guildId, entry.tournamentId, player, team, entry);
        syncedTournaments++;
    }

    return { syncedTournaments };
}

async function syncPlayerToTournament(
    guildId,
    tournament,
    player,
    team,
    tournamentTeam = null,
    { preserveInactive = false } = {}
) {
    const filter = {
        guildId,
        tournamentId: tournament._id,
        playerId: player._id
    };

    if (preserveInactive) {
        const existingPlayerEntry = await TournamentPlayer.findOne(filter);
        if (existingPlayerEntry?.isActive === false) return existingPlayerEntry;
    }

    const entry = tournamentTeam || (team?._id
        ? await TournamentTeam.findOne({
            guildId,
            tournamentId: tournament._id,
            teamId: team._id
        })
        : null);
    const { captainID, viceCaptainID } = getEffectiveLeadership(team, entry);
    const isCaptain = sameId(player.discordID, captainID);
    const isViceCaptain = !isCaptain && sameId(player.discordID, viceCaptainID);

    return TournamentPlayer.findOneAndUpdate(
        filter,
        {
            $set: {
                guildId,
                tournamentId: tournament._id,
                playerId: player._id,
                teamId: team?._id || player.teamId || null,
                playerNameSnapshot: player.name,
                teamNameSnapshot: team?.name || player.teamNameSnapshot || '',
                isActive: true,
                isCaptain,
                isViceCaptain
            },
            $setOnInsert: {
                stats: {
                    played: 0,
                    goals: 0,
                    assists: 0,
                    saves: 0,
                    tackles: 0,
                    interceptions: 0,
                    yc: 0,
                    rc: 0,
                    mvps: 0
                }
            }
        },
        {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
        }
    );
}

function getEffectiveLeadership(team, tournamentTeam) {
    const captainID = tournamentTeam?.captainID || team?.captainID || null;
    const viceCaptainID = tournamentTeam?.viceCaptainID ||
        (tournamentTeam?.captainID ? null : team?.viceCaptainID) ||
        null;

    return { captainID, viceCaptainID };
}

function sameId(a, b) {
    return a != null && b != null && String(a) === String(b);
}

/**
 * Explicitly enroll one team into ONE specific tournament.
 * Used by the manual registration flow
 * (/register team_name:<name> tournament:<key>).
 *
 * Stores the per-tournament captain/vice captain on the TournamentTeam
 * entry, and creates tournament player entries for every global player
 * on the team.
 */
async function enrollTeamInTournament(guildId, tournament, team, {
    captainID = null,
    viceCaptainID = null
} = {}) {
    if (!tournament || !team) {
        return { enrolled: false, playersSynced: 0 };
    }

    const existing = await TournamentTeam.findOne({
        guildId,
        tournamentId: tournament._id,
        teamId: team._id
    });

    if (!existing && tournament.teamCount > 0) {
        const currentCount = await TournamentTeam.countDocuments({
            guildId,
            tournamentId: tournament._id,
            isActive: true
        });

        if (currentCount >= tournament.teamCount) {
            return { enrolled: false, playersSynced: 0, skippedReason: 'tournament_full' };
        }
    }

    await TournamentTeam.findOneAndUpdate(
        {
            guildId,
            tournamentId: tournament._id,
            teamId: team._id
        },
        {
            $set: {
                guildId,
                tournamentId: tournament._id,
                teamId: team._id,
                teamNameSnapshot: team.name,
                isActive: true,
                captainID: captainID || null,
                viceCaptainID: viceCaptainID || null
            },
            $setOnInsert: {
                groupKey: team.groupKey || null,
                stats: {
                    played: 0,
                    wins: 0,
                    draws: 0,
                    losses: 0,
                    gf: 0,
                    ga: 0,
                    points: 0
                }
            }
        },
        {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
        }
    );

    const players = await Player.find({
        guildId,
        teamId: team._id
    });

    let playersSynced = 0;

    for (const player of players) {
        const isCaptain =
            captainID ? String(player.discordID) === String(captainID) : false;
        const isViceCaptain =
            viceCaptainID ? String(player.discordID) === String(viceCaptainID) : false;

        await TournamentPlayer.findOneAndUpdate(
            {
                guildId,
                tournamentId: tournament._id,
                playerId: player._id
            },
            {
                $set: {
                    guildId,
                    tournamentId: tournament._id,
                    playerId: player._id,
                    teamId: team._id,
                    playerNameSnapshot: player.name,
                    teamNameSnapshot: team.name,
                    isActive: true,
                    isCaptain,
                    isViceCaptain
                },
                $setOnInsert: {
                    stats: {
                        played: 0,
                        goals: 0,
                        assists: 0,
                        saves: 0,
                        tackles: 0,
                        interceptions: 0,
                        yc: 0,
                        rc: 0,
                        mvps: 0
                    }
                }
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
            }
        );

        playersSynced++;
    }

    return { enrolled: true, playersSynced };
}

module.exports = {
    syncAllTeamsToTournament,
    syncTeamToOpenTournaments,
    syncTeamToTournament,
    syncPlayerToOpenTournaments,
    syncPlayerToTournament,
    enrollTeamInTournament
};
