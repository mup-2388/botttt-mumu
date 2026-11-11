const { isKnockoutPhase } = require('./knockoutResults');

function shouldShowKnockoutBracket(tournament) {
    if (tournament?.formatType === 'knockout') return true;
    if (tournament?.formatType !== 'groups_knockout') return false;
    const phase = String(tournament.currentPhase || '').trim().toLowerCase();
    return phase === 'completed' || isKnockoutPhase(phase);
}

module.exports = { shouldShowKnockoutBracket };
