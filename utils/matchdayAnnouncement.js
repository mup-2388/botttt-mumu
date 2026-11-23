const { vsLine } = require('./ai/emojiSlots');

const LINE_EMOJI = '<a:lineline:1555643251552292986>';
const LINE_REPEAT_COUNT = 10;
const STADIUM_EMOJI = '<:Stadium:1487010283506630776>';
const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_USER_ID_RE = /^\d{15,22}$/;

const MATCHDAY_NOTES = [
    '- TM IS NOT REQUIRED FOR MATCHES',
    '- IF HOST FORGET TO DO -ctn | HOST BAN',
    '- NOTE: Home Advantage is enabled'
];

const KNOCKOUT_ROUNDS = Object.freeze({
    roundof16: Object.freeze({ label: 'Round of 16', heading: 'ROUND OF 16' }),
    quarterfinal: Object.freeze({ label: 'Quarter Final', heading: 'QUARTER FINAL' }),
    semifinal: Object.freeze({ label: 'Semi Final', heading: 'SEMI FINAL' }),
    final: Object.freeze({ label: 'Final', heading: 'FINAL' })
});

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

function getKnockoutRound(phase) {
    return KNOCKOUT_ROUNDS[String(phase || '').trim().toLowerCase()] || null;
}

function selectKnockoutRound(fixtures = [], phase) {
    const normalizedPhase = String(phase || '').trim().toLowerCase();
    const round = getKnockoutRound(normalizedPhase);
    if (!round) return null;

    const selected = fixtures
        .filter(fixture =>
            String(fixture?.phase || '').trim().toLowerCase() === normalizedPhase &&
            isUnplayedFixture(fixture)
        )
        .sort((a, b) => numericMatchNumber(a) - numericMatchNumber(b));

    if (!selected.length) return null;
    return { phase: normalizedPhase, label: round.label, heading: round.heading, fixtures: selected };
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

function normalizeQuestionTagUserIds(userIds = []) {
    const values = Array.isArray(userIds) ? userIds : [];
    return [...new Set(values
        .map(userId => String(userId ?? '').trim())
        .filter(userId => DISCORD_USER_ID_RE.test(userId)))];
}

function formatQuestionsLine(userIds = [], includePings = true) {
    const ids = normalizeQuestionTagUserIds(userIds);
    if (!includePings || ids.length === 0) {
        return 'Questions? Contact your server organizers.';
    }

    return `Questions? ${ids.map(userId => `<@${userId}>`).join(' ')}`;
}

function formatMatchdayAnnouncement({
    matchdayNumber: day,
    heading = null,
    fixtures,
    deadline,
    guildId,
    lineRepeatCount = LINE_REPEAT_COUNT,
    includePings = true,
    questionTagUserIds = []
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
        const stadiumLine = fixture.venueLabel
            ? `${STADIUM_EMOJI} ${fixture.venueLabel}`
            : `${STADIUM_EMOJI} <#${fixture.stadiumChannelId}>`;

        return [
            `__Match ${matchNo}__`,
            vsLine(home, away, guildId),
            stadiumLine
        ].join('\n');
    });

    return [
        `# ${heading || `MATCHDAY ${day}`}`,
        separator,
        matchBlocks.join('\n\n'),
        `Deadline : \`${sanitizeDeadline(deadline)}\``,
        MATCHDAY_NOTES.join('\n'),
        separator,
        formatQuestionsLine(questionTagUserIds, includePings)
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
    DISCORD_MESSAGE_LIMIT,
    normalizeQuestionTagUserIds,
    formatQuestionsLine,
    MATCHDAY_NOTES,
    KNOCKOUT_ROUNDS,
    matchdayNumber,
    isUnplayedFixture,
    selectNextMatchday,
    getKnockoutRound,
    selectKnockoutRound,
    sanitizeDeadline,
    buildLineSeparator,
    formatMatchdayAnnouncement
};
