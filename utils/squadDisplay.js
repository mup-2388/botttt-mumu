function normalizeKey(value) {
    return String(value || '').trim().toLowerCase();
}

function getSquadDisplayName({ globalName, tournamentEntries = [], defaultTournamentKey = '' }) {
    const defaultKey = normalizeKey(defaultTournamentKey);
    const currentEntry = defaultKey
        ? tournamentEntries.find(entry => normalizeKey(entry.tournamentId?.tournamentKey) === defaultKey)
        : null;
    const sourceName = String(
        globalName ||
        currentEntry?.playerNameSnapshot ||
        tournamentEntries.find(entry => entry.playerNameSnapshot)?.playerNameSnapshot ||
        'Unknown'
    ).trim();

    return stripHistoricalTournamentPrefix(sourceName, tournamentEntries, defaultKey);
}

function stripHistoricalTournamentPrefix(name, tournamentEntries, defaultKey) {
    const historicalNames = [...new Set(
        tournamentEntries
            .filter(entry => !defaultKey || normalizeKey(entry.tournamentId?.tournamentKey) !== defaultKey)
            .map(entry => String(entry.tournamentId?.name || '').trim())
            .filter(Boolean)
    )].sort((a, b) => b.length - a.length);

    for (const tournamentName of historicalNames) {
        const escapedName = tournamentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`^${escapedName}(?:\\s*[-–—|:•·]\\s*|\\s{2,})(.+)$`, 'i');
        const match = name.match(pattern);
        if (match?.[1]) return match[1].trim();
    }

    return name;
}

function getSquadTournamentNames(
    tournamentEntries = [],
    defaultTournamentKey = '',
    defaultTournamentId = null,
    defaultTournamentName = ''
) {
    const defaultKey = normalizeKey(defaultTournamentKey);
    const visibleEntries = defaultKey || defaultTournamentId
        ? tournamentEntries.filter(entry => {
            const tournament = entry.tournamentId;
            const linkedId = tournament?._id || tournament;
            return (defaultKey && normalizeKey(tournament?.tournamentKey) === defaultKey)
                || (defaultTournamentId && String(linkedId) === String(defaultTournamentId));
        })
        : tournamentEntries;
    const names = [...new Set(
        visibleEntries
            .map(entry => entry.tournamentId?.name)
            .filter(Boolean)
    )];

    // If populate() did not resolve the tournament reference, the matching
    // roster entry still proves the default tournament label belongs here.
    if (visibleEntries.length && defaultTournamentName && !names.includes(defaultTournamentName)) {
        names.push(defaultTournamentName);
    }

    return names;
}

module.exports = {
    getSquadDisplayName,
    getSquadTournamentNames
};
