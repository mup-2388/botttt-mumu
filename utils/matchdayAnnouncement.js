const { vsLine } = require('./ai/emojiSlots');

const LINE_EMOJI = '<a:lineline:1555643251552292986>';
const LINE_REPEAT_COUNT = 10;
const STADIUM_EMOJI = '<:Stadium:1487010283506630776>';
const FIXTURES_ROLE_ID = '1554519598597021766';
const UNALDO_USER_ID = '774318165722529792';
const AASHANK_USER_ID = '1531201010532618241';
const DISCORD_MESSAGE_LIMIT = 2000;

const MATCHDAY_NOTES = [
    "- NO TM REQUIRED AND DON'T FORGET TO DO -ctn",
    '- IF HOST FORGET TO DO -ctn | HOST BAN',
    '- NOTE: Home Advantage is there'
];

function matchdayNumber(fixture) {
    const label = String(fixture?.roundLabel || '');
    const match = label.match(/\bmatchday\s*#?\s*(\d+)\b/i);
    return match ? Number(match[1]) : null;
}

function isUnplayedFixture(fixture) {
    if (fixture?.reserved?.isReserved === true) return false;

    const status = String(fixture?.status || 'Pending').trim().toLowerCase();
    return !['played', 'cancelled', 'canceled', 'completed'].includes(status);
}

function numericMatchNumber(fixture) {
    const value = Number(fixture?.matchNumber);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function selectNextMatchday(fixtures = []) {
    const candidates = fixtures
        .filter(isUnplayedFixture)
        .map(fixture => ({ fixture, day: matchdayNumber(fixture) }))
        .filter(item => Number.isInteger(item.day) && item.day > 0);

    if (!candidates.length) return null;

    const nextDay = Math.min(...candidates.map(item => item.day));
    const selected = candidates
        .filter(item => item.day === nextDay)
        .map(item => item.fixture)
        .sort((a, b) => numericMatchNumber(a) - numericMatchNumber(b));

    return { matchdayNumber: nextDay, fixtures: selected };
}

function sanitizeDeadline(value) {
    return String(value || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/`/g, 'ˋ')
        .trim();
}

function buildLineSeparator(repeatCount = LINE_REPEAT_COUNT) {
    return LINE_EMOJI.repeat(Math.max(1, Math.floor(Number(repeatCount) || 1)));
}

function formatMatchdayAnnouncement({
    matchdayNumber: day,
    fixtures,
    deadline,
    guildId,
    lineRepeatCount = LINE_REPEAT_COUNT,
    includePings = true
}) {
    const separator = buildLineSeparator(lineRepeatCount);
    const matchBlocks = (fixtures || []).map(fixture => {
        const matchNo = numericMatchNumber(fixture);
        const home = includePings
            ? fixture.homeMention || fixture.homeTeam
            : plainTextWithoutPings(fixture.homeTeam);
        const away = includePings
            ? fixture.awayMention || fixture.awayTeam
            : plainTextWithoutPings(fixture.awayTeam);
        const stadiumId = fixture.stadiumChannelId;

        return [
            `__Match ${matchNo}__`,
            vsLine(home, away, guildId),
            `${STADIUM_EMOJI} <#${stadiumId}>`
        ].join('\n');
    });

    return [
        `# MATCHDAY ${day}`,
        separator,
        matchBlocks.join('\n\n'),
        `Deadline : \`${sanitizeDeadline(deadline)}\``,
        MATCHDAY_NOTES.join('\n'),
        separator,
        includePings ? `<@&${FIXTURES_ROLE_ID}>` : 'HFSL fixtures',
        includePings
            ? `Questions? <@${UNALDO_USER_ID}> <@${AASHANK_USER_ID}>`
            : 'Questions? UNALDO · Aashank'
    ].join('\n\n');
}

function plainTextWithoutPings(value) {
    return String(value || 'Unknown team')
        .replace(/@/g, '@\u200b')
        .replace(/</g, '‹')
        .replace(/>/g, '›');
}

module.exports = {
    LINE_EMOJI,
    LINE_REPEAT_COUNT,
    STADIUM_EMOJI,
    FIXTURES_ROLE_ID,
    UNALDO_USER_ID,
    AASHANK_USER_ID,
    DISCORD_MESSAGE_LIMIT,
    MATCHDAY_NOTES,
    matchdayNumber,
    isUnplayedFixture,
    selectNextMatchday,
    sanitizeDeadline,
    buildLineSeparator,
    formatMatchdayAnnouncement
};
