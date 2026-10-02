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
        "- NO TM REQUIRED AND DON'T FORGET TO DO -ctn",
        '- IF HOST FORGET TO DO -ctn | HOST BAN',
        '- NOTE: Home Advantage is there'
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
