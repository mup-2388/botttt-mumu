const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getSquadDisplayName,
    getSquadTournamentNames
} = require('../utils/squadDisplay');

const entries = [
    {
        playerNameSnapshot: 'Old League • Alex',
        tournamentId: { tournamentKey: 'old-league', name: 'Old League' }
    },
    {
        playerNameSnapshot: 'Alex',
        tournamentId: { tournamentKey: 'glory-cup', name: 'Glory Cup' }
    }
];

test('squad display prefers the global nickname over stale tournament snapshots', () => {
    assert.equal(getSquadDisplayName({
        globalName: 'Alex',
        tournamentEntries: entries,
        defaultTournamentKey: 'glory-cup'
    }), 'Alex');
});

test('squad display removes a known historical tournament prefix from the visible name', () => {
    assert.equal(getSquadDisplayName({
        globalName: 'Old League • Alex',
        tournamentEntries: entries,
        defaultTournamentKey: 'glory-cup'
    }), 'Alex');
});

test('squad display uses the current default tournament snapshot if no global name exists', () => {
    assert.equal(getSquadDisplayName({
        globalName: '',
        tournamentEntries: entries,
        defaultTournamentKey: 'GLORY-CUP'
    }), 'Alex');
});

test('squad tags show the current default tournament instead of historical tournament names', () => {
    assert.deepEqual(getSquadTournamentNames(entries, 'glory-cup'), ['Glory Cup']);
});

test('squad tags retain all tournament names only when no default tournament can be resolved', () => {
    assert.deepEqual(getSquadTournamentNames(entries), ['Old League', 'Glory Cup']);
});

test('squad tags match the default tournament by ID when populate does not resolve it', () => {
    const unpopulatedEntry = { tournamentId: 'tournament-default-id' };
    assert.deepEqual(getSquadTournamentNames(
        [unpopulatedEntry],
        'glory-cup-s4',
        'tournament-default-id',
        'Glory Cup S4'
    ), ['Glory Cup S4']);
});
