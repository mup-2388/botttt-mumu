const {
    Team,
    Player,
    TournamentTeam,
    TournamentPlayer
} = require('../models/Tournament');
const {
    sameId,
    effectiveCaptainId,
    effectiveViceCaptainId
} = require('./tournamentLeadership');

/**
 * Reconcile captain assignments for one tournament without changing the
 * server-wide Team/Player leadership. A global captain is copied into the
 * tournament only when that user is actually on that team's active roster.
 * If the global captain is absent, a rostered tournament override is retained;
 * a unique current TournamentPlayer captain flag is a last-resort candidate.
 */
async function syncCaptainsToTournamentRoster(guildId, tournament) {
    if (!guildId || !tournament?._id) {
        return { updated: 0, alreadyCorrect: 0, skipped: [] };
    }

    const entries = await TournamentTeam.find({
        guildId,
        tournamentId: tournament._id,
        isActive: true
    });

    if (!entries.length) return { updated: 0, alreadyCorrect: 0, skipped: [] };

    const teamIds = [...new Set(entries.map(entry => idOf(entry.teamId)).filter(Boolean))];
    const [teams, rosterEntries] = await Promise.all([
        Team.find({ guildId, _id: { $in: teamIds } }),
        TournamentPlayer.find({
            guildId,
            tournamentId: tournament._id,
            isActive: true,
            teamId: { $in: teamIds }
        })
    ]);

    const teamById = new Map(teams.map(team => [idOf(team._id), team]));
    const rosterByTeam = new Map();

    for (const rosterEntry of rosterEntries) {
        const teamId = idOf(rosterEntry.teamId);
        if (!rosterByTeam.has(teamId)) rosterByTeam.set(teamId, []);
        rosterByTeam.get(teamId).push(rosterEntry);
    }

    const playerIds = [...new Set(rosterEntries.map(entry => idOf(entry.playerId)).filter(Boolean))];
    const players = playerIds.length
        ? await Player.find({ guildId, _id: { $in: playerIds } })
        : [];
    const playerById = new Map(players.map(player => [idOf(player._id), player]));

    const skipped = [];
    let updated = 0;
    let alreadyCorrect = 0;

    for (const entry of entries) {
        const teamId = idOf(entry.teamId);
        const team = teamById.get(teamId);
        if (!team) {
            skipped.push({ teamName: entry.teamNameSnapshot || teamId || 'Unknown team', reason: 'team record missing' });
            continue;
        }

        const roster = rosterByTeam.get(teamId) || [];
        const rosterByDiscordId = new Map();

        for (const rosterEntry of roster) {
            const player = playerById.get(idOf(rosterEntry.playerId));
            if (player?.discordID) rosterByDiscordId.set(String(player.discordID), { player, rosterEntry });
        }

        const globalCaptain = team.captainID
            ? rosterByDiscordId.get(String(team.captainID))
            : null;
        const tournamentCaptain = entry.captainID
            ? rosterByDiscordId.get(String(entry.captainID))
            : null;

        let candidate = null;
        let source = null;

        // Global captain is preferred, but only if they are an active member of
        // this exact tournament team. Otherwise retain a rostered override.
        if (globalCaptain) {
            candidate = { discordID: String(team.captainID), ...globalCaptain };
            source = 'global';
        } else if (tournamentCaptain) {
            candidate = { discordID: String(entry.captainID), ...tournamentCaptain };
            source = 'tournament';
        } else {
            // Legacy per-player flags are considered only on this team's active
            // tournament roster, and only when they identify exactly one person.
            const flagged = roster
                .filter(rosterEntry => rosterEntry.isCaptain)
                .map(rosterEntry => {
                    const player = playerById.get(idOf(rosterEntry.playerId));
                    return player?.discordID
                        ? { discordID: String(player.discordID), player, rosterEntry }
                        : null;
                })
                .filter(Boolean);
            const uniqueFlagged = [...new Map(flagged.map(item => [item.discordID, item])).values()];

            if (uniqueFlagged.length === 1) {
                candidate = uniqueFlagged[0];
                source = 'roster_flag';
            } else if (uniqueFlagged.length > 1) {
                skipped.push({
                    teamName: team.name,
                    reason: `multiple rostered players are marked captain (${uniqueFlagged.map(item => `<@${item.discordID}>`).join(', ')})`
                });
                continue;
            }
        }

        if (!candidate) {
            const staleCaptainId = entry.captainID || team.captainID || null;
            skipped.push({
                teamName: team.name,
                reason: staleCaptainId
                    ? `configured captain <@${staleCaptainId}> is not on this active tournament roster`
                    : 'no rostered global, tournament, or unique flagged captain was found'
            });
            continue;
        }

        const oldEffectiveCaptainId = effectiveCaptainId(entry, team);
        const captainChanged = !sameId(oldEffectiveCaptainId, candidate.discordID);
        const overrideChanged = source !== 'tournament' && !sameId(entry.captainID, candidate.discordID);

        if (overrideChanged) {
            await TournamentTeam.updateOne(
                { _id: entry._id },
                { $set: { captainID: candidate.discordID } }
            );
        }

        // Keep the denormalized captain badge in step with the authoritative
        // team-level assignment. Do not change other teams/tournaments.
        await TournamentPlayer.updateMany(
            {
                guildId,
                tournamentId: tournament._id,
                teamId: team._id,
                isActive: true
            },
            { $set: { isCaptain: false } }
        );
        await TournamentPlayer.updateOne(
            {
                guildId,
                tournamentId: tournament._id,
                teamId: team._id,
                playerId: candidate.player._id,
                isActive: true
            },
            { $set: { isCaptain: true, isViceCaptain: false } }
        );

        if (sameId(effectiveViceCaptainId(entry, team), candidate.discordID) && entry.viceCaptainID) {
            await TournamentTeam.updateOne(
                { _id: entry._id },
                { $set: { viceCaptainID: null } }
            );
        }

        if (captainChanged || overrideChanged) updated++;
        else alreadyCorrect++;
    }

    return { updated, alreadyCorrect, skipped };
}

function idOf(value) {
    if (value == null) return null;
    return String(value._id || value);
}

module.exports = {
    syncCaptainsToTournamentRoster
};
