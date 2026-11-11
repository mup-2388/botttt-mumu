const test = require('node:test');
const assert = require('node:assert/strict');
const {
    effectiveCaptainId,
    effectiveViceCaptainId,
    getUserLeadershipRole
} = require('../utils/tournamentLeadership');

test('tournament captain override wins over stale roster leadership flags', () => {
    const team = { captainID: 'old-global-captain', viceCaptainID: 'old-global-vice' };
    const entry = { captainID: 'current-captain', viceCaptainID: 'current-vice' };

    assert.equal(effectiveCaptainId(entry, team), 'current-captain');
    assert.equal(effectiveViceCaptainId(entry, team), 'current-vice');
    assert.equal(getUserLeadershipRole({
        userId: 'old-global-captain',
        team,
        entry,
        tournamentPlayer: { isCaptain: true }
    }), 'player');
    assert.equal(getUserLeadershipRole({
        userId: 'current-captain',
        team,
        entry,
        tournamentPlayer: { isCaptain: false }
    }), 'captain');
    assert.equal(getUserLeadershipRole({
        userId: 'current-vice',
        team,
        entry,
        tournamentPlayer: { isViceCaptain: false }
    }), 'vice');
});

test('global leadership is inherited only when the tournament has no captain override', () => {
    const team = { captainID: 'global-captain', viceCaptainID: 'global-vice' };
    const entry = { captainID: null, viceCaptainID: null };

    assert.equal(getUserLeadershipRole({ userId: 'global-captain', team, entry }), 'captain');
    assert.equal(getUserLeadershipRole({ userId: 'global-vice', team, entry }), 'vice');
});

test('cached TournamentPlayer flags never grant leadership when team leadership is unset', () => {
    const team = { captainID: null, viceCaptainID: null };
    const entry = { captainID: null, viceCaptainID: null };

    assert.equal(getUserLeadershipRole({
        userId: 'rostered-captain',
        team,
        entry,
        tournamentPlayer: { isCaptain: true }
    }), 'player');
    assert.equal(getUserLeadershipRole({
        userId: 'rostered-vice',
        team,
        entry,
        tournamentPlayer: { isViceCaptain: true }
    }), 'player');
});
