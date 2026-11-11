/**
 * generateKnockoutBracketImage.js
 *
 * Renders the current knockout rounds as a two-sided bracket that converges
 * on a centered final. Missing later-round fixtures are shown as TBD slots.
 */

const { createCanvas } = require('@napi-rs/canvas');
const { Fixture } = require('../models/Tournament');
const { prettyPhase } = require('./displayHelpers');

const BRACKET_PHASES = ['roundof16', 'quarterfinal', 'semifinal', 'final'];
const MATCH_COUNTS_BY_PHASE = {
    roundof16: 8,
    quarterfinal: 4,
    semifinal: 2,
    final: 1
};

const THEME = {
    backgroundTop: '#071126',
    backgroundBottom: '#0b1730',
    panel: '#101d38',
    panelBorder: '#263c63',
    panelMuted: '#0c1830',
    connector: '#55729e',
    title: '#f1f6ff',
    accent: '#edc66e',
    team: '#dce7f8',
    muted: '#91a2bf',
    winner: '#75e0b4',
    score: '#f8fbff'
};

const CARD_WIDTH = 280;
const CARD_HEIGHT = 82;
const COLUMN_GAP = 35;
const COLUMN_PITCH = CARD_WIDTH + COLUMN_GAP;
const OUTER_MARGIN = 24;
const CONTENT_TOP = 176;
const SLOT_STEP = 170;

async function generateKnockoutBracketImage({ settings, guildId }) {
    const fixtures = await Fixture.find({
        guildId,
        tournamentId: settings._id,
        phase: { $in: BRACKET_PHASES }
    })
        .sort({ matchNumber: 1, leg: 1 })
        .lean();

    const rounds = buildBracketRounds(fixtures || []);
    if (!rounds) return null;

    const layout = buildBracketLayout(rounds);
    const canvas = createCanvas(layout.width, layout.height);
    const ctx = canvas.getContext('2d');

    drawBackground(ctx, layout.width, layout.height);
    drawHeader(ctx, settings, layout);
    drawConnectors(ctx, layout);

    for (const round of layout.rounds) {
        for (const slot of round.slots) {
            drawMatchCard(ctx, slot, round.phase);
        }
    }

    drawFooter(ctx, layout);

    return {
        buffer: canvas.toBuffer('image/png'),
        fileName: 'knockout-bracket.png'
    };
}

/**
 * Group stored fixtures into match ties, then add empty future-round slots.
 * A phase's expected size comes from its label so a partially entered draw
 * still keeps the correct bracket shape.
 */
function buildBracketRounds(fixtures) {
    const byPhase = new Map();

    for (const fixture of fixtures) {
        if (!BRACKET_PHASES.includes(fixture.phase)) continue;
        if (!byPhase.has(fixture.phase)) byPhase.set(fixture.phase, []);
        byPhase.get(fixture.phase).push(fixture);
    }

    const firstPhase = BRACKET_PHASES.find(phase => (byPhase.get(phase) || []).length > 0);
    if (!firstPhase) return null;

    const firstIndex = BRACKET_PHASES.indexOf(firstPhase);
    const firstTies = groupFixturesIntoTies(byPhase.get(firstPhase));
    const firstMatchCount = MATCH_COUNTS_BY_PHASE[firstPhase];
    if (firstTies.length > firstMatchCount) return null;

    let matchCount = firstMatchCount;
    return BRACKET_PHASES.slice(firstIndex).map(phase => {
        const phaseTies = groupFixturesIntoTies(byPhase.get(phase) || []);
        const matches = placeTiesInBracketSlots(phaseTies, matchCount);
        matchCount = Math.max(1, matchCount / 2);
        return { phase, matches };
    });
}

function groupFixturesIntoTies(fixtures) {
    const ties = new Map();

    for (const fixture of [...fixtures].sort(compareFixtures)) {
        const key = fixture.aggregateTieKey
            ? `aggregate:${fixture.aggregateTieKey}`
            : `fixture:${fixture._id || fixture.matchNumber || ties.size}`;

        if (!ties.has(key)) ties.set(key, []);
        ties.get(key).push(fixture);
    }

    return Array.from(ties.values())
        .map(fixturesInTie => summarizeTie(fixturesInTie.sort((a, b) => (a.leg || 1) - (b.leg || 1))))
        .sort((a, b) => compareFixtures(a.firstFixture, b.firstFixture));
}

function placeTiesInBracketSlots(ties, matchCount) {
    const matches = Array.from({ length: matchCount }, () => null);
    const unpositioned = [];

    for (const tie of ties) {
        const rawSlot = Number(tie.firstFixture?.bracket?.slot);
        const index = rawSlot - 1;
        if (Number.isInteger(rawSlot) && index >= 0 && index < matchCount && matches[index] === null) {
            matches[index] = tie;
        } else {
            unpositioned.push(tie);
        }
    }

    let nextFree = 0;
    for (const tie of unpositioned) {
        while (nextFree < matchCount && matches[nextFree] !== null) nextFree++;
        if (nextFree >= matchCount) break;
        matches[nextFree++] = tie;
    }

    return matches;
}

function summarizeTie(fixtures) {
    const firstFixture = fixtures[0];
    const homeTeam = firstFixture.homeTeam || 'TBD';
    const awayTeam = firstFixture.awayTeam || 'TBD';
    const homeId = teamIdentity(firstFixture, 'home');
    const awayId = teamIdentity(firstFixture, 'away');
    let homeScore = 0;
    let awayScore = 0;
    let hasScore = false;

    for (const fixture of fixtures) {
        const score = fixture.result || {};
        const fixtureHomeScore = toScore(score.home);
        const fixtureAwayScore = toScore(score.away);
        if (fixtureHomeScore === null || fixtureAwayScore === null) continue;
        hasScore = true;

        if (teamIdentity(fixture, 'home') === homeId) {
            homeScore += fixtureHomeScore;
            awayScore += fixtureAwayScore;
        } else if (teamIdentity(fixture, 'away') === homeId) {
            homeScore += fixtureAwayScore;
            awayScore += fixtureHomeScore;
        }
    }

    const scores = hasScore ? { home: homeScore, away: awayScore } : null;
    const finalFixture = fixtures[fixtures.length - 1];
    const finalResult = finalFixture?.result || {};
    const fixturePenaltiesHome = toScore(finalResult.penaltiesHome);
    const fixturePenaltiesAway = toScore(finalResult.penaltiesAway);
    let homePenalties = null;
    let awayPenalties = null;

    if (fixturePenaltiesHome !== null && fixturePenaltiesAway !== null) {
        const finalHomeId = teamIdentity(finalFixture, 'home');
        if (finalHomeId === homeId) {
            homePenalties = fixturePenaltiesHome;
            awayPenalties = fixturePenaltiesAway;
        } else if (finalHomeId === awayId) {
            homePenalties = fixturePenaltiesAway;
            awayPenalties = fixturePenaltiesHome;
        }
    }

    const winner = resolveTieWinner(fixtures, {
        homeTeam,
        awayTeam,
        homeId,
        awayId,
        scores
    });

    return {
        firstFixture,
        fixtures,
        homeTeam,
        awayTeam,
        homeScore: scores?.home ?? null,
        awayScore: scores?.away ?? null,
        homePenalties,
        awayPenalties,
        winner
    };
}

function resolveTieWinner(fixtures, { homeTeam, awayTeam, homeId, awayId, scores }) {
    if (scores && scores.home !== scores.away) {
        return scores.home > scores.away ? homeTeam : awayTeam;
    }

    const finalFixture = fixtures[fixtures.length - 1];
    const result = finalFixture?.result || {};
    const penaltiesHome = toScore(result.penaltiesHome);
    const penaltiesAway = toScore(result.penaltiesAway);

    if (penaltiesHome !== null && penaltiesAway !== null && penaltiesHome !== penaltiesAway) {
        const winnerIdentity = penaltiesHome > penaltiesAway
            ? teamIdentity(finalFixture, 'home')
            : teamIdentity(finalFixture, 'away');

        if (winnerIdentity === homeId) return homeTeam;
        if (winnerIdentity === awayId) return awayTeam;
        return penaltiesHome > penaltiesAway ? finalFixture.homeTeam : finalFixture.awayTeam;
    }

    const explicitWinner = [...fixtures].reverse()
        .map(fixture => fixture.result?.winner)
        .find(Boolean);
    if (explicitWinner && [homeTeam, awayTeam].includes(String(explicitWinner))) {
        return String(explicitWinner);
    }
    return null;
}

function buildBracketLayout(rounds) {
    const roundCount = rounds.length;
    const firstRoundMatchCount = rounds[0].matches.length;
    const matchesPerSide = Math.floor(firstRoundMatchCount / 2);
    const width = CARD_WIDTH + (OUTER_MARGIN * 2) + ((roundCount - 1) * COLUMN_PITCH * 2);
    const height = Math.max(450, CONTENT_TOP + (matchesPerSide * SLOT_STEP) + 110);
    const finalX = (width - CARD_WIDTH) / 2;
    const columns = rounds.map((round, roundIndex) => {
        const distanceFromFinal = roundCount - roundIndex - 1;
        return {
            phase: round.phase,
            matches: round.matches,
            xLeft: finalX - (distanceFromFinal * COLUMN_PITCH),
            xRight: finalX + (distanceFromFinal * COLUMN_PITCH),
            xFinal: finalX
        };
    });

    const firstCenters = Array.from({ length: matchesPerSide }, (_, index) =>
        CONTENT_TOP + (SLOT_STEP / 2) + (index * SLOT_STEP)
    );
    let previousLeftCenters = firstCenters;
    let previousRightCenters = [...firstCenters];

    const positionedRounds = columns.map((round, roundIndex) => {
        const matchCount = round.matches.length;
        const slots = new Array(matchCount);

        if (matchCount === 1) {
            const centerY = roundIndex === 0
                ? height / 2
                : (previousLeftCenters[0] + previousRightCenters[0]) / 2;
            slots[0] = {
                ...round.matches[0],
                phase: round.phase,
                matchIndex: 0,
                side: 'center',
                x: round.xFinal,
                y: centerY,
                cardWidth: CARD_WIDTH,
                cardHeight: CARD_HEIGHT
            };
            return { phase: round.phase, slots };
        }

        const half = matchCount / 2;
        const leftCenters = [];
        const rightCenters = [];

        for (let index = 0; index < half; index++) {
            const centerY = roundIndex === 0
                ? firstCenters[index]
                : (previousLeftCenters[index * 2] + previousLeftCenters[index * 2 + 1]) / 2;
            leftCenters.push(centerY);
            slots[index] = makeSlot(round, index, 'left', round.xLeft, centerY);
        }

        for (let visualIndex = 0; visualIndex < half; visualIndex++) {
            const matchIndex = matchCount - visualIndex - 1;
            const centerY = roundIndex === 0
                ? firstCenters[visualIndex]
                : (previousRightCenters[visualIndex * 2] + previousRightCenters[visualIndex * 2 + 1]) / 2;
            rightCenters.push(centerY);
            slots[matchIndex] = makeSlot(round, matchIndex, 'right', round.xRight, centerY);
        }

        previousLeftCenters = leftCenters;
        previousRightCenters = rightCenters;
        return { phase: round.phase, slots };
    });

    return {
        width,
        height,
        finalX,
        matchesPerSide,
        rounds: positionedRounds
    };
}

function makeSlot(round, matchIndex, side, x, y) {
    return {
        ...round.matches[matchIndex],
        phase: round.phase,
        matchIndex,
        side,
        x,
        y,
        cardWidth: CARD_WIDTH,
        cardHeight: CARD_HEIGHT
    };
}

function drawBackground(ctx, width, height) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, THEME.backgroundTop);
    gradient.addColorStop(1, THEME.backgroundBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = '#41618e';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 56) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x - height * 0.22, height);
        ctx.stroke();
    }
    ctx.restore();
}

function drawHeader(ctx, settings, layout) {
    const title = String(settings.name || 'Tournament').toUpperCase();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = THEME.title;
    ctx.font = 'bold 31px Arial, sans-serif';
    ctx.fillText(fitText(ctx, title, layout.width - 100), layout.width / 2, 42);

    ctx.fillStyle = THEME.accent;
    ctx.font = 'bold 17px Arial, sans-serif';
    ctx.fillText('KNOCKOUT BRACKET', layout.width / 2, 79);

    ctx.fillStyle = 'rgba(237, 198, 110, 0.45)';
    ctx.fillRect(layout.width / 2 - 72, 103, 144, 2);

    for (const round of layout.rounds) {
        const representatives = round.slots.length === 1
            ? [round.slots[0]]
            : [round.slots.find(slot => slot.side === 'left'), round.slots.find(slot => slot.side === 'right')];

        for (const slot of representatives.filter(Boolean)) {
            const label = prettyPhase(round.phase).toUpperCase();
            ctx.fillStyle = THEME.muted;
            ctx.font = 'bold 14px Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(label, slot.x + (CARD_WIDTH / 2), 143);
        }
    }
}

function drawConnectors(ctx, layout) {
    ctx.save();
    ctx.strokeStyle = THEME.connector;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.85;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let roundIndex = 0; roundIndex < layout.rounds.length - 1; roundIndex++) {
        const current = layout.rounds[roundIndex];
        const next = layout.rounds[roundIndex + 1];
        const matchCount = current.slots.length;

        if (next.slots.length === 1) {
            drawJoinConnector(ctx, [current.slots[0]], next.slots[0], 'left');
            drawJoinConnector(ctx, [current.slots[matchCount - 1]], next.slots[0], 'right');
            continue;
        }

        const half = matchCount / 2;
        const nextHalf = next.slots.length / 2;

        for (let index = 0; index < nextHalf; index++) {
            drawJoinConnector(
                ctx,
                [current.slots[index * 2], current.slots[index * 2 + 1]],
                next.slots[index],
                'left'
            );
        }

        for (let visualIndex = 0; visualIndex < nextHalf; visualIndex++) {
            const parentIndex = next.slots.length - visualIndex - 1;
            const childIndex = matchCount - (visualIndex * 2) - 1;
            drawJoinConnector(
                ctx,
                [current.slots[childIndex], current.slots[childIndex - 1]],
                next.slots[parentIndex],
                'right'
            );
        }
    }

    ctx.restore();
}

function drawJoinConnector(ctx, sources, target, side) {
    const startX = side === 'left'
        ? sources[0].x + CARD_WIDTH
        : sources[0].x;
    const endX = side === 'left'
        ? target.x
        : target.x + CARD_WIDTH;
    const channelX = (startX + endX) / 2;
    const sourceYs = sources.map(source => source.y);
    const topY = Math.min(...sourceYs, target.y);
    const bottomY = Math.max(...sourceYs, target.y);

    for (const source of sources) {
        ctx.beginPath();
        ctx.moveTo(startX, source.y);
        ctx.lineTo(channelX, source.y);
        ctx.stroke();
    }

    if (bottomY > topY) {
        ctx.beginPath();
        ctx.moveTo(channelX, topY);
        ctx.lineTo(channelX, bottomY);
        ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(channelX, target.y);
    ctx.lineTo(endX, target.y);
    ctx.stroke();
}

function drawMatchCard(ctx, slot, phase) {
    const x = slot.x;
    const y = slot.y - (CARD_HEIGHT / 2);
    const resolved = Boolean(slot.winner);

    roundedRect(ctx, x, y, CARD_WIDTH, CARD_HEIGHT, 11);
    ctx.fillStyle = THEME.panel;
    ctx.fill();
    ctx.strokeStyle = resolved ? 'rgba(117, 224, 180, 0.75)' : THEME.panelBorder;
    ctx.lineWidth = resolved ? 2 : 1;
    ctx.stroke();

    ctx.fillStyle = THEME.panelMuted;
    roundedRect(ctx, x + 1, y + 1, CARD_WIDTH - 2, 20, 10);
    ctx.fill();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = THEME.accent;
    ctx.font = 'bold 11px Arial, sans-serif';
    const matchNumber = slot.firstFixture?.matchNumber;
    const matchLabel = matchNumber ? `MATCH ${matchNumber}` : prettyPhase(phase).toUpperCase();
    ctx.fillText(matchLabel, x + 12, y + 11);

    const rowTop = y + 22;
    drawTeamRow(ctx, slot.homeTeam || 'TBD', slot.homeScore, slot.homePenalties, slot.winner, x, rowTop, 'home');
    drawTeamRow(ctx, slot.awayTeam || 'TBD', slot.awayScore, slot.awayPenalties, slot.winner, x, rowTop + 29, 'away');
}

function drawTeamRow(ctx, name, score, penalties, winner, x, y, side) {
    const isWinner = Boolean(winner) && name === winner;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isWinner ? THEME.winner : name === 'TBD' ? THEME.muted : THEME.team;
    ctx.font = isWinner ? 'bold 16px Arial, sans-serif' : '15px Arial, sans-serif';
    ctx.fillText(fitText(ctx, name, 185), x + 12, y + 14);

    const scoreText = formatBracketScore(score, penalties);
    ctx.textAlign = 'right';
    ctx.fillStyle = scoreText === '—'
        ? THEME.muted
        : isWinner ? THEME.winner : THEME.score;
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.fillText(scoreText, x + CARD_WIDTH - 12, y + 14);

    if (side === 'home') {
        ctx.fillStyle = 'rgba(145, 162, 191, 0.16)';
        ctx.fillRect(x + 12, y + 28, CARD_WIDTH - 24, 1);
    }
}

function formatBracketScore(score, penalties = null) {
    if (score === null || typeof score === 'undefined') return '—';
    const shootout = penalties === null || typeof penalties === 'undefined'
        ? ''
        : ` (${penalties})`;
    return `- ${score}${shootout}`;
}

function drawFooter(ctx, layout) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(145, 162, 191, 0.75)';
    ctx.font = '13px Arial, sans-serif';
    ctx.fillText('Fixtures and results update as the knockout stage progresses', layout.width / 2, layout.height - 28);
}

function roundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.arcTo(x + width, y, x + width, y + radius, radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
    ctx.lineTo(x + radius, y + height);
    ctx.arcTo(x, y + height, x, y + height - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
}

function fitText(ctx, value, maxWidth) {
    let text = String(value || 'TBD');
    if (ctx.measureText(text).width <= maxWidth) return text;

    while (text.length > 4 && ctx.measureText(`${text.slice(0, -4)}…`).width > maxWidth) {
        text = text.slice(0, -4);
    }
    return `${text.slice(0, -4)}…`;
}

function teamIdentity(fixture, side) {
    const id = fixture[`${side}TeamId`] || fixture[`${side}TournamentTeamId`];
    return id ? String(id) : String(fixture[`${side}Team`] || '').trim().toLowerCase();
}

function toScore(value) {
    if (value === null || typeof value === 'undefined' || value === '') return null;
    const score = Number(value);
    return Number.isFinite(score) ? score : null;
}

function compareFixtures(a, b) {
    const aSlot = Number(a.bracket?.slot);
    const bSlot = Number(b.bracket?.slot);
    if (Number.isInteger(aSlot) && aSlot > 0 && Number.isInteger(bSlot) && bSlot > 0 && aSlot !== bSlot) {
        return aSlot - bSlot;
    }
    return Number(a.matchNumber || 0) - Number(b.matchNumber || 0) ||
        Number(a.leg || 1) - Number(b.leg || 1);
}

module.exports = {
    generateKnockoutBracketImage,
    buildBracketRounds,
    buildBracketLayout,
    groupFixturesIntoTies,
    summarizeTie,
    resolveTieWinner,
    formatBracketScore
};
