const test = require('node:test');
const assert = require('node:assert/strict');

const {
    LINE_EMOJI,
    LINE_REPEAT_COUNT,
    FIXTURES_ROLE_ID,
    UNALDO_USER_ID,
    AASHANK_USER_ID,
    MATCHDAY_NOTES,
    selectNextMatchday,
    selectKnockoutRound,
    sanitizeDeadline,
    formatMatchdayAnnouncement
} = require('../utils/matchdayAnnouncement');

test('selects the earliest unplayed matchday and sorts its fixtures numerically', () => {
    const result = selectNextMatchday([
        { roundLabel: 'Matchday 2', status: 'Pending', matchNumber: 11 },
        { roundLabel: 'Group B Matchday 1', status: 'Live', matchNumber: 10 },
        { roundLabel: 'Group A Matchday 1', status: 'Pending', matchNumber: 2 },
        { roundLabel: 'Matchday 1', status: 'Pending', matchNumber: 1, reserved: { isReserved: true } },
        { roundLabel: 'Matchday 1', status: 'Played', matchNumber: 4 },
        { roundLabel: 'Matchday 1', status: 'Cancelled', matchNumber: 3 },
        { roundLabel: 'Quarter Final 1', status: 'Pending', matchNumber: 4 }
    ]);

    assert.equal(result.matchdayNumber, 1);
    assert.deepEqual(result.fixtures.map(fixture => fixture.matchNumber), [2, 10]);
});

test('includes scheduled unplayed fixtures and ignores rounds without a Matchday label', () => {
    const result = selectNextMatchday([
        {
            roundLabel: 'Group A Matchday 3',
            status: 'Pending',
            matchNumber: 18,
            scheduledAt: new Date('2026-10-04T12:00:00Z'),
            channelPlan: { state: 'locked' }
        },
        { roundLabel: 'Semi Final 1', status: 'Pending', matchNumber: 19 }
    ]);

    assert.equal(result.matchdayNumber, 3);
    assert.equal(result.fixtures.length, 1);
    assert.equal(result.fixtures[0].matchNumber, 18);
});

test('selects all unplayed fixtures for the requested knockout phase in match-number order', () => {
    const result = selectKnockoutRound([
        { phase: 'roundof16', status: 'Pending', matchNumber: 8 },
        { phase: 'roundof16', status: 'Live', matchNumber: 2, leg: 2 },
        { phase: 'roundof16', status: 'Played', matchNumber: 1 },
        { phase: 'quarterfinal', status: 'Pending', matchNumber: 9 },
        { phase: 'roundof16', status: 'Pending', matchNumber: 3, reserved: { isReserved: true } }
    ], 'roundof16');

    assert.equal(result.label, 'Round of 16');
    assert.equal(result.heading, 'ROUND OF 16');
    assert.deepEqual(result.fixtures.map(fixture => fixture.matchNumber), [2, 8]);
    assert.equal(selectKnockoutRound([{ phase: 'quarterfinal', status: 'Pending', matchNumber: 9 }], 'semifinal'), null);
    assert.equal(selectKnockoutRound([], 'league'), null);
});

test('supports every configured knockout phase and its display heading', () => {
    const expectedRounds = [
        ['roundof16', 'Round of 16', 'ROUND OF 16'],
        ['quarterfinal', 'Quarter Final', 'QUARTER FINAL'],
        ['semifinal', 'Semi Final', 'SEMI FINAL'],
        ['final', 'Final', 'FINAL']
    ];

    for (const [phase, label, heading] of expectedRounds) {
        const selected = selectKnockoutRound([
            { phase, status: 'Pending', matchNumber: 1 }
        ], phase);
        assert.equal(selected.label, label);
        assert.equal(selected.heading, heading);
    }
});

test('formats knockout fixtures with a round heading while preserving the matchday template', () => {
    const content = formatMatchdayAnnouncement({
        heading: 'QUARTER FINAL',
        deadline: 'Sunday 8 PM',
        guildId: 'guild-1',
        fixtures: [{
            matchNumber: 9,
            homeTeam: 'Falcons',
            awayTeam: 'Wolves',
            stadiumChannelId: '333333333333333333'
        }],
        includePings: false
    });

    assert.match(content, /^# QUARTER FINAL/m);
    assert.doesNotMatch(content, /MATCHDAY undefined/);
    assert.match(content, /Deadline : `Sunday 8 PM`/);
});

test('formats the selected matchday with the specified real emoji and ping markup', () => {
    const content = formatMatchdayAnnouncement({
        matchdayNumber: 4,
        deadline: 'Friday 8 PM',
        guildId: 'guild-1',
        fixtures: [{
            matchNumber: 3,
            homeTeam: 'Falcons',
            awayTeam: 'Wolves',
            homeMention: '<@&111111111111111111>',
            awayMention: '<@&222222222222222222>',
            stadiumChannelId: '333333333333333333'
        }]
    });

    assert.match(content, /^# MATCHDAY 4/m);
    assert.match(content, new RegExp(`(?:${LINE_EMOJI}){${LINE_REPEAT_COUNT}}`));
    assert.match(content, /__Match 3__/);
    assert.match(content, /<@&111111111111111111> <:vsvs:1555297535361286225> <@&222222222222222222>/);
    assert.match(content, /<:Stadium:1487010283506630776> <#333333333333333333>/);
    assert.match(content, /Deadline : `Friday 8 PM`/);
    assert.deepEqual(MATCHDAY_NOTES, [
        '- TM IS REQUIRED FOR EVERY MATCH',
        '- IF HOST FORGET TO DO -ctn | HOST BAN',
        '- NOTE: Home Advantage is disabled'
    ]);
    assert.ok(MATCHDAY_NOTES.every(note => content.includes(`\n${note}`)));
    assert.ok(content.includes(`<@&${FIXTURES_ROLE_ID}>`));
    assert.ok(content.includes(`<@${UNALDO_USER_ID}>`));
    assert.ok(content.includes(`<@${AASHANK_USER_ID}>`));
    assert.doesNotMatch(content, /⚽/);
});

test('sanitizes a deadline so it stays on one line and inside the inline-code span', () => {
    assert.equal(sanitizeDeadline('  Friday\n`8 PM`  '), 'Friday ˋ8 PMˋ');
});
