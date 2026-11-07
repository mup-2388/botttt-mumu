function sameId(a, b) {
    return a != null && b != null && String(a) === String(b);
}

function effectiveCaptainId(entry, team) {
    return entry?.captainID || team?.captainID || null;
}

function effectiveViceCaptainId(entry, team) {
    if (entry?.viceCaptainID) return entry.viceCaptainID;
    if (entry?.captainID) return null;
    return team?.viceCaptainID || null;
}

/**
 * Resolve a user's leadership role from the authoritative team records.
 * TournamentPlayer and global Player role flags are cached display metadata;
 * they must never grant permissions when the team leadership IDs disagree.
 */
function getUserLeadershipRole({ userId, team, entry = null }) {
    if (sameId(effectiveCaptainId(entry, team), userId)) return 'captain';
    if (sameId(effectiveViceCaptainId(entry, team), userId)) return 'vice';
    return 'player';
}

module.exports = {
    sameId,
    effectiveCaptainId,
    effectiveViceCaptainId,
    getUserLeadershipRole
};
