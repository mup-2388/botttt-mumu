/**
 * tournamentCleanup.js
 *
 * Complete removal of a tournament AND the server-wide leftovers
 * (global Team / Player docs) that only existed because of it.
 *
 * Why this exists:
 *   Team and Player are SERVER-WIDE documents. `/resettournament` only removes
 *   the tournament's own rows (TournamentTeam / TournamentPlayer / Fixture /
 *   settings). The global Team.captainID, Player.teamId, … stayed behind, so
 *   `mystats`, `nick`, `release`, `setvicecaptain` … kept seeing the old team.
 *
 * Safety rules:
 *   - Teams that are still registered in ANOTHER tournament are never deleted.
 *   - Players that have EVENT stats (EventPlayer) are never deleted, only
 *     detached from their old team (events must stay intact).
 *   - Players still rostered in another tournament are never deleted.
 *   - UserProfile (all-time stats, trophies/awards of other tournaments) is
 *     never touched.
 */

const {
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer,
    Fixture,
    Team,
    Player,
    EventPlayer,
    UserProfile,
    ServerConfig
} = require('../models/Tournament');

const LiveMessage = require('../models/LiveMessage');
const { getDrawKey } = require('./drawBoard');

const ZERO_PLAYER_STATS = {
    'stats.played': 0,
    'stats.goals': 0,
    'stats.assists': 0,
    'stats.saves': 0,
    'stats.tackles': 0,
    'stats.interceptions': 0,
    'stats.yc': 0,
    'stats.rc': 0,
    'stats.mvps': 0
};

function uniqueIds(list) {
    return [...new Set(list.filter(Boolean).map(String))];
}

/**
 * Teams in this guild that are not registered in ANY existing tournament.
 */
async function findOrphanTeams(guildId) {
    const registered = await TournamentTeam.distinct('teamId', { guildId });
    const registeredIds = new Set(registered.map(String));

    const teams = await Team.find({ guildId });
    return teams.filter(t => !registeredIds.has(String(t._id)));
}

/**
 * Players that are leftovers: not rostered in any tournament, no event stats,
 * and either teamless or on a team that no longer exists / is an orphan.
 */
async function findOrphanPlayers(guildId, { orphanTeamIds = [] } = {}) {
    const orphanTeams = new Set(orphanTeamIds.map(String));

    const [rosteredIds, eventIds, players] = await Promise.all([
        TournamentPlayer.distinct('playerId', { guildId }),
        EventPlayer.distinct('playerId', { guildId }),
        Player.find({ guildId })
    ]);

    const rostered = new Set(rosteredIds.map(String));
    const hasEvent = new Set(eventIds.map(String));

    const liveTeamIds = new Set(
        (await Team.find({ guildId }).select('_id').lean()).map(t => String(t._id))
    );

    return players.filter(p => {
        if (rostered.has(String(p._id))) return false;
        if (hasEvent.has(String(p._id))) return false;

        // Teamless players are legitimate free agents — leave them alone.
        if (!p.teamId) return false;

        // Only players still attached to a team that no longer belongs to any
        // tournament are leftovers.
        const tid = String(p.teamId);
        return orphanTeams.has(tid) || !liveTeamIds.has(tid);
    });
}

/**
 * Delete the given global teams and clean up their players.
 *   - players with no other use are DELETED
 *   - players with event stats / other tournament roster are DETACHED
 *     (teamId = null, captain flags cleared)
 */
async function removeGlobalTeams(guildId, teamIds, { extraPlayerIds = [] } = {}) {
    const ids = uniqueIds(teamIds);

    const playersOnTeams = ids.length
        ? await Player.find({ guildId, teamId: { $in: ids } }).select('_id').lean()
        : [];

    const candidatePlayerIds = uniqueIds([
        ...playersOnTeams.map(p => p._id),
        ...extraPlayerIds
    ]);

    // Anything still registered elsewhere must survive.
    const stillRegisteredTeams = new Set(
        (await TournamentTeam.distinct('teamId', { guildId })).map(String)
    );
    const deletableTeamIds = ids.filter(id => !stillRegisteredTeams.has(id));

    const teamResult = deletableTeamIds.length
        ? await Team.deleteMany({ guildId, _id: { $in: deletableTeamIds } })
        : { deletedCount: 0 };

    let playersDeleted = 0;
    let playersDetached = 0;

    if (candidatePlayerIds.length) {
        const [rosteredIds, eventIds] = await Promise.all([
            TournamentPlayer.distinct('playerId', {
                guildId,
                playerId: { $in: candidatePlayerIds }
            }),
            EventPlayer.distinct('playerId', {
                guildId,
                playerId: { $in: candidatePlayerIds }
            })
        ]);

        const protectedIds = new Set([...rosteredIds, ...eventIds].map(String));
        const liveTeamIds = new Set(
            (await Team.find({ guildId }).select('_id').lean()).map(t => String(t._id))
        );

        const candidates = await Player.find({
            guildId,
            _id: { $in: candidatePlayerIds }
        });

        const toDelete = [];
        const toDetach = [];

        for (const p of candidates) {
            // Still on a live (kept) team → leave alone entirely
            if (p.teamId && liveTeamIds.has(String(p.teamId))) continue;

            if (protectedIds.has(String(p._id))) toDetach.push(p._id);
            else toDelete.push(p._id);
        }

        if (toDelete.length) {
            const r = await Player.deleteMany({ guildId, _id: { $in: toDelete } });
            playersDeleted = r.deletedCount || 0;
        }

        if (toDetach.length) {
            const r = await Player.updateMany(
                { guildId, _id: { $in: toDetach } },
                {
                    $set: {
                        teamId: null,
                        teamNameSnapshot: '',
                        isCaptain: false,
                        isViceCaptain: false,
                        ...ZERO_PLAYER_STATS
                    }
                }
            );
            playersDetached = r.modifiedCount || 0;
        }
    }

    return {
        teamsDeleted: teamResult.deletedCount || 0,
        playersDeleted,
        playersDetached
    };
}

/**
 * Remove EVERYTHING that belongs to a tournament and (optionally) the global
 * leftovers that only it used.
 */
async function purgeTournament({
    client = null,
    guildId,
    tournament,
    removeGlobalLeftovers = true
}) {
    const summary = {
        tournamentTeams: 0,
        tournamentPlayers: 0,
        fixtures: 0,
        liveMessages: 0,
        profiles: 0,
        draw: 'No active draw',
        defaultCleared: false,
        teamsDeleted: 0,
        playersDeleted: 0,
        playersDetached: 0,
        settings: 0
    };

    // Candidates for global cleanup must be collected BEFORE deleting entries.
    const teamIds = uniqueIds(
        await TournamentTeam.distinct('teamId', { guildId, tournamentId: tournament._id })
    );
    const playerIds = uniqueIds(
        await TournamentPlayer.distinct('playerId', { guildId, tournamentId: tournament._id })
    );

    const fixtureRes = await Fixture.deleteMany({
        guildId,
        $or: [
            { tournamentId: tournament._id },
            { tournamentKey: tournament.tournamentKey }
        ]
    });
    summary.fixtures = fixtureRes.deletedCount || 0;

    const ttRes = await TournamentTeam.deleteMany({ guildId, tournamentId: tournament._id });
    summary.tournamentTeams = ttRes.deletedCount || 0;

    const tpRes = await TournamentPlayer.deleteMany({ guildId, tournamentId: tournament._id });
    summary.tournamentPlayers = tpRes.deletedCount || 0;

    const liveRes = await LiveMessage.deleteMany({
        guildId,
        tournamentKey: tournament.tournamentKey
    }).catch(() => ({ deletedCount: 0 }));
    summary.liveMessages = liveRes.deletedCount || 0;

    const profRes = await UserProfile.updateMany(
        { guildId },
        {
            $pull: {
                trophies: { tournamentKey: tournament.tournamentKey },
                awards: { tournamentKey: tournament.tournamentKey }
            }
        }
    ).catch(() => ({ modifiedCount: 0 }));
    summary.profiles = profRes.modifiedCount || 0;

    summary.draw = clearDrawSession(client, guildId, tournament);

    const settingsRes = await TournamentSettings.deleteOne({
        guildId,
        _id: tournament._id
    });
    summary.settings = settingsRes.deletedCount || 0;

    summary.defaultCleared = await clearDefaultPointer(guildId, tournament.tournamentKey);

    if (removeGlobalLeftovers) {
        const removed = await removeGlobalTeams(guildId, teamIds, {
            extraPlayerIds: playerIds
        });
        summary.teamsDeleted = removed.teamsDeleted;
        summary.playersDeleted = removed.playersDeleted;
        summary.playersDetached = removed.playersDetached;
    }

    return summary;
}

/** If the server default pointed at this tournament, clear it. */
async function clearDefaultPointer(guildId, tournamentKey) {
    const res = await ServerConfig.updateOne(
        { guildId, defaultTournamentKey: String(tournamentKey).toLowerCase() },
        { $set: { defaultTournamentKey: '' } }
    );
    return (res.modifiedCount || 0) > 0;
}

function clearDrawSession(client, guildId, tournament) {
    if (!client?.liveSettings) return 'Skipped (no liveSettings)';

    const drawKey = getDrawKey(guildId);
    const session = client.liveSettings.get(drawKey);

    if (!session) return 'No active draw';

    if (session.tournamentKey && session.tournamentKey !== tournament.tournamentKey) {
        return `Skipped (draw belongs to \`${session.tournamentKey}\`)`;
    }

    client.liveSettings.delete(drawKey);
    return 'Cleared';
}

module.exports = {
    findOrphanTeams,
    findOrphanPlayers,
    removeGlobalTeams,
    purgeTournament,
    clearDefaultPointer
};
