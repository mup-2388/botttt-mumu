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

function shouldShowKnockoutBracket(tournament) {
    if (tournament?.formatType === 'knockout') return true;
    if (tournament?.formatType !== 'groups_knockout') return false;
    const phase = String(tournament.currentPhase || '').trim().toLowerCase();
    return phase === 'completed' || isKnockoutPhase(phase);
}

module.exports = { shouldShowKnockoutBracket, isKnockoutPhase };
