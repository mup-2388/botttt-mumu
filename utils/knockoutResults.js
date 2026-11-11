const KNOCKOUT_PHASES = new Set([
    'knockout',
    'qualifier',
    'eliminator',
    'roundof16',
    'quarterfinal',
    'semifinal',
    'final'
]);

function isKnockoutPhase(phase) {
    return KNOCKOUT_PHASES.has(String(phase || '').trim().toLowerCase());
}

/**
 * Validate full-time and optional shootout scores before persisting a result.
 * A tied knockout match must have a decisive penalty score; league/group draws
 * remain valid without a winner.
 */
function validateReportedScore({
    phase,
    homeScore,
    awayScore,
    penaltiesHome = null,
    penaltiesAway = null
} = {}) {
    if (!isValidScore(homeScore) || !isValidScore(awayScore)) {
        return 'Full-time scores must be valid non-negative whole numbers.';
    }

    const hasHomePenalties = hasScore(penaltiesHome);
    const hasAwayPenalties = hasScore(penaltiesAway);
    const hasPenalties = hasHomePenalties || hasAwayPenalties;

    if (!isKnockoutPhase(phase)) {
        return hasPenalties
            ? 'Penalty scores can only be reported for knockout fixtures.'
            : null;
    }

    if (hasHomePenalties !== hasAwayPenalties) {
        return 'Enter both penalty scores, or leave both blank.';
    }

    if (hasPenalties && (!isValidScore(penaltiesHome) || !isValidScore(penaltiesAway))) {
        return 'Penalty scores must be valid non-negative whole numbers.';
    }

    if (homeScore !== awayScore && hasPenalties) {
        return 'Only enter penalty scores when the full-time score is tied.';
    }

    if (homeScore === awayScore && !hasPenalties) {
        return 'A tied knockout match needs both penalty scores to determine the winner.';
    }

    if (homeScore === awayScore && penaltiesHome === penaltiesAway) {
        return 'Penalty scores must be different to decide a knockout match.';
    }

    return null;
}

/** Return 'home', 'away', or null for a fixture's saved result. */
function getFixtureWinnerSide(fixture) {
    if (!fixture) return null;

    const result = fixture.result || {};
    const explicitWinner = normalizeName(result.winner);
    const homeName = normalizeName(fixture.homeTeam);
    const awayName = normalizeName(fixture.awayTeam);
    const homeScore = toScore(result.home);
    const awayScore = toScore(result.away);

    if (homeScore !== null && awayScore !== null) {
        if (homeScore > awayScore) return 'home';
        if (awayScore > homeScore) return 'away';

        const penaltiesHome = toScore(result.penaltiesHome);
        const penaltiesAway = toScore(result.penaltiesAway);
        if (penaltiesHome !== null && penaltiesAway !== null && penaltiesHome !== penaltiesAway) {
            return penaltiesHome > penaltiesAway ? 'home' : 'away';
        }
    }

    // Keep manually saved winners (for example, an awarded result) as a final
    // fallback, but never let a stale winner override the actual scoreline.
    if (explicitWinner && explicitWinner === homeName) return 'home';
    if (explicitWinner && explicitWinner === awayName) return 'away';
    return null;
}

function isValidScore(value) {
    return Number.isInteger(value) && value >= 0;
}

function hasScore(value) {
    return value !== null && typeof value !== 'undefined' && value !== '';
}

function toScore(value) {
    if (!hasScore(value)) return null;
    const score = Number(value);
    return Number.isInteger(score) && score >= 0 ? score : null;
}

function normalizeName(value) {
    return String(value || '').trim().toLowerCase();
}

module.exports = {
    KNOCKOUT_PHASES,
    isKnockoutPhase,
    validateReportedScore,
    getFixtureWinnerSide
};
