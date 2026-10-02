/**
 * generateStandingsImage.js
 *
 * Generates a PNG image of tournament standings.
 *
 * RENDERING: 2x scale for sharp text (retina-quality)
 * BACKGROUND: Trophy PNG from assets instead of emoji text
 * THEME: Champions League (navy/blue)
 */

const path = require('path');
const fs = require('fs');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const axios = require('axios');

const { TournamentTeam } = require('../models/Tournament');
const { sortTeams, getQualificationZone, compactName } = require('./standingsHelpers');

/*
========================================
SCALE — 2x for sharp text
========================================
*/
const SCALE = 2;

/*
========================================
FONT REGISTRATION
========================================
*/

let fontsRegistered = false;

function registerFonts() {
    if (fontsRegistered) return;

    const fontsDir = path.join(__dirname, '..', 'assets', 'fonts');
    const fontFiles = [
        ['Inter_18pt-Regular.ttf', 'Inter'],
        ['Inter_18pt-SemiBold.ttf', 'Inter SemiBold'],
        ['Oswald-Bold.ttf', 'Oswald']
    ];
    const registered = [];
    const failed = [];

    for (const [fileName, family] of fontFiles) {
        const fontPath = path.join(fontsDir, fileName);
        if (!fs.existsSync(fontPath)) {
            failed.push(`${fileName} (file not found)`);
            continue;
        }

        try {
            const result = GlobalFonts.registerFromPath(fontPath, family);
            if (result === false) throw new Error('Canvas rejected the font');
            registered.push(family);
        } catch (err) {
            failed.push(`${fileName} (${err.message})`);
        }
    }

    fontsRegistered = true;
    if (failed.length) {
        console.warn(`[generateStandingsImage] Registered ${registered.length}/${fontFiles.length} fonts; failed: ${failed.join(', ')}`);
    } else {
        console.log(`[generateStandingsImage] Fonts registered: ${registered.join(', ')}.`);
    }
}

/*
========================================
TROPHY IMAGE CACHE
========================================
*/

let trophyImage = null;

async function loadTrophyImage() {
    if (trophyImage) return trophyImage;

    const trophyPath = path.join(__dirname, '..', 'assets', 'trophy.png');

    if (fs.existsSync(trophyPath)) {
        try {
            trophyImage = await loadImage(trophyPath);
            console.log('[generateStandingsImage] Trophy image loaded.');
            return trophyImage;
        } catch (err) {
            console.warn('[generateStandingsImage] Trophy image failed:', err.message);
        }
    }

    return null;
}

/*
========================================
THEME — Champions League
========================================
*/

const THEME = {
    background: {
        overlay: 'rgba(2, 5, 20, 0.22)',
        primary: '#040820',
        secondary: '#0a1128',
        accentGlow: 'rgba(80, 120, 200, 0.10)',
        accentGlow2: 'rgba(60, 100, 180, 0.06)',
        border: 'rgba(100, 140, 200, 0.15)',
        accentLines: 'rgba(100, 140, 200, 0.03)'
    },
    container: {
        bg: 'rgba(4, 8, 28, 0.45)',
        border: 'rgba(100, 140, 200, 0.12)',
        radius: 14,
        marginX: 38,
        marginTop: 34,
        marginBottom: 34
    },
    title: {
        bg: 'rgba(13, 26, 58, 0.60)',
        text: '#e8e8e8',
        keyText: 'rgba(150, 180, 220, 0.55)',
        border: 'rgba(30, 58, 110, 0.40)',
        font: 'Oswald',
        height: 52
    },
    header: {
        bg: 'rgba(30, 58, 110, 0.35)',
        text: '#a8cbf5',
        border: 'rgba(30, 58, 110, 0.20)',
        font: 'Inter SemiBold',
        height: 34
    },
    row: {
        even: 'rgba(255, 255, 255, 0.015)',
        odd: 'rgba(0, 0, 0, 0.15)',
        border: 'rgba(100, 140, 200, 0.04)',
        textPrimary: '#e4ecf7',
        textSecondary: '#c0cee0',
        textMuted: '#3d5070',
        statShadow: 'rgba(0, 0, 0, 0.50)',
        colLine: 'rgba(100, 140, 200, 0.08)',
        height: 40,
        badgeFont: 'Inter SemiBold',
        badgeSize: 24,
        badgeBgUcl: 'rgba(52, 152, 219, 0.25)',
        badgeBgQual: 'rgba(46, 204, 113, 0.20)',
        badgeBgDefault: 'rgba(255, 255, 255, 0.06)',
        badgeBgFirst: 'rgba(201, 168, 76, 0.30)',
        badgeTextFirst: '#c9a84c',
        nameFont: 'Inter SemiBold',
        statFont: 'Inter'
    },
    zone: {
        ucl: { bg: 'rgba(52, 152, 219, 0.18)', accent: '#5dade2', gradientEnd: 'rgba(52, 152, 219, 0)' },
        qualification: { bg: 'rgba(46, 204, 113, 0.15)', accent: '#2ecc71', gradientEnd: 'rgba(46, 204, 113, 0)' }
    },
    legend: {
        bg: 'rgba(4, 8, 32, 0.45)',
        text: '#8a9bb5',
        time: '#4a5f80',
        border: 'rgba(100, 140, 200, 0.06)',
        font: 'Inter',
        height: 38
    },
    gd: {
        positive: '#5dade2',
        negative: '#e74c3c',
        zero: '#5a6e88',
        pillPositive: 'rgba(52, 152, 219, 0.15)',
        pillNegative: 'rgba(231, 76, 60, 0.15)',
        pillZero: 'rgba(255, 255, 255, 0.04)'
    },
    points: { text: '#eaf0f8', bg: 'rgba(255, 255, 255, 0.09)' }
};

const DEFAULT_BG_PATH = path.join(__dirname, '..', 'assets', 'standings_bg_default.png');

const SIZES = {
    logoSize: 28,
    logoPad: 5,
    paddingX: 18
};

/*
========================================
MAIN EXPORT
========================================
*/

async function generateStandingsImage({ settings, guildId, groupKey = null }) {
    registerFonts();
    await loadTrophyImage();

    const query = { guildId, tournamentId: settings._id, isActive: true };
    if (groupKey) query.groupKey = groupKey;

    const tournamentTeams = await TournamentTeam.find(query).populate('teamId').lean();
    const sorted = sortTeams(tournamentTeams);
    const zones = sorted.map((_, i) =>
        getQualificationZone({ position: i + 1, settings, groupKey })
    );

    const logoCache = new Map();
    await preloadLogos(sorted, logoCache);

    return renderImage({ settings, sorted, zones, groupKey, logoCache });
}

/*
========================================
LOGO PRELOADING
========================================
*/

async function preloadLogos(teams, logoCache) {
    const tasks = teams.map(async (entry) => {
        const url = entry.teamId?.logoURL || entry.logoURL || null;
        if (!url) return;
        try {
            const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            logoCache.set(entry._id?.toString() || entry.teamNameSnapshot, await loadImage(Buffer.from(resp.data, 'binary')));
        } catch { /* placeholder later */ }
    });
    await Promise.allSettled(tasks);
}

/*
========================================
RENDERING
========================================
*/

async function renderImage({ settings, sorted, zones, groupKey, logoCache }) {
    const count = sorted.length;
    const c = THEME.container;
    const tableW = Math.max(740, Math.min(920, 740 + (count > 10 ? 50 : 0)));

    const tableH =
        THEME.title.height +
        THEME.header.height +
        (count * THEME.row.height) +
        THEME.legend.height;

    const totalW = tableW + (c.marginX * 2);
    const totalH = tableH + c.marginTop + c.marginBottom;

    // 2x canvas for sharp rendering
    const canvas = createCanvas(totalW * SCALE, totalH * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // ── BACKGROUND ──
    await drawBackground(ctx, { width: totalW, height: totalH, customURL: settings.standingsBackground });

    // ── TABLE CONTAINER ──
    drawContainer(ctx, { x: c.marginX, y: c.marginTop, w: tableW, h: tableH });

    // ── COLUMNS ──
    const cols = calculateColumns(tableW);

    let y = c.marginTop;

    // ── TITLE ──
    drawTitle(ctx, { settings, groupKey, x: c.marginX, y, w: tableW });
    y += THEME.title.height;

    // ── HEADER ──
    drawHeader(ctx, { cols, x: c.marginX, y, w: tableW });
    y += THEME.header.height;

    // ── ROWS ──
    for (let i = 0; i < sorted.length; i++) {
        const prevZone = i > 0 ? zones[i - 1] : null;
        const zone = zones[i];

        if (zone !== prevZone && prevZone !== null) {
            drawZoneSeparator(ctx, { x: c.marginX, y, w: tableW, zone: prevZone });
        }

        drawTeamRow(ctx, {
            entry: sorted[i], position: i + 1, zone, cols,
            x: c.marginX, y, w: tableW,
            isEven: i % 2 === 0,
            teamColor: sorted[i].teamId?.color || null,
            logoKey: sorted[i]._id?.toString() || sorted[i].teamNameSnapshot,
            logoCache
        });

        y += THEME.row.height;
    }

    // ── LEGEND ──
    drawLegend(ctx, { settings, zones, groupKey, x: c.marginX, y, w: tableW });

    // ── OUTPUT at 1x size (scaled down = sharper)
    const finalCanvas = createCanvas(totalW, totalH);
    const finalCtx = finalCanvas.getContext('2d');
    finalCtx.drawImage(canvas, 0, 0, totalW, totalH);

    const buffer = finalCanvas.toBuffer('image/png');
    const safeName = (settings.tournamentKey || 'standings').replace(/[^a-zA-Z0-9_-]/g, '');
    const groupSuffix = groupKey ? `_group${groupKey}` : '';

    return { buffer, fileName: `standings_${safeName}${groupSuffix}_${Date.now()}.png` };
}

/*
========================================
DRAW: BACKGROUND
========================================
*/

async function drawBackground(ctx, { width, height, customURL }) {
    let bgImage = null;

    if (customURL) {
        try {
            const resp = await axios.get(customURL, { responseType: 'arraybuffer', timeout: 8000 });
            bgImage = await loadImage(Buffer.from(resp.data, 'binary'));
        } catch { /* fallback */ }
    }

    if (!bgImage && fs.existsSync(DEFAULT_BG_PATH)) {
        try { bgImage = await loadImage(DEFAULT_BG_PATH); } catch { /* fallback */ }
    }

    if (bgImage) {
        const scale = Math.max(width / bgImage.width, height / bgImage.height);
        const dw = bgImage.width * scale;
        const dh = bgImage.height * scale;
        ctx.drawImage(bgImage, (width - dw) / 2, (height - dh) / 2, dw, dh);
        ctx.fillStyle = THEME.background.overlay;
        ctx.fillRect(0, 0, width, height);
        return;
    }

    // Gradient fallback
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, THEME.background.primary);
    grad.addColorStop(0.5, THEME.background.secondary);
    grad.addColorStop(1, THEME.background.primary);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    const g1 = ctx.createRadialGradient(0, 0, 0, 0, 0, 320);
    g1.addColorStop(0, THEME.background.accentGlow);
    g1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = THEME.background.border;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.75, 0.75, width - 1.5, height - 1.5);
}

/*
========================================
DRAW: TABLE CONTAINER
========================================
*/

function drawContainer(ctx, { x, y, w, h }) {
    const c = THEME.container;

    ctx.save();
    roundRect(ctx, x, y, w, h, c.radius);
    ctx.fillStyle = c.bg;
    ctx.fill();

    roundRect(ctx, x, y, w, h, c.radius);
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

/*
========================================
DRAW: TITLE BAR
========================================
*/

function drawTitle(ctx, { settings, groupKey, x, y, w }) {
    const t = THEME.title;

    ctx.save();
    roundRect(ctx, x, y, w, t.height, THEME.container.radius);
    ctx.clip();

    ctx.fillStyle = t.bg;
    ctx.fillRect(x, y, w, t.height);

    // Bottom border
    ctx.fillStyle = t.border;
    ctx.fillRect(x, y + t.height - 1.5, w, 1.5);

    const name = (settings.name || 'Tournament').toUpperCase();
    const group = groupKey ? ` \u2014 GROUP ${groupKey}` : '';

    let textX = x + SIZES.paddingX;
    const midY = y + t.height / 2;

    // ── TROPHY IMAGE (replaces emoji) ──
    if (trophyImage) {
        const tSize = 30;
        const tY = midY - tSize / 2 - 1;
        ctx.save();
        ctx.globalAlpha = 0.90;
        ctx.drawImage(trophyImage, textX, tY, tSize, tSize);
        ctx.restore();
        textX += tSize + 8;
    }

    // Title text with subtle shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.40)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = t.text;
    ctx.font = `bold 22px "${t.font}", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`${name}${group}`, textX, midY);
    ctx.restore();

    // Key on right
    ctx.fillStyle = t.keyText;
    ctx.font = `12px "Inter", sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(`Key: ${settings.tournamentKey}`, x + w - SIZES.paddingX, midY);

    ctx.restore();
}

/*
========================================
COLUMNS
========================================
*/

function calculateColumns(tableW) {
    const px = SIZES.paddingX;
    const usable = tableW - (px * 2);

    const c = {
        pos:   { x: px, w: 38 },
        logo:  { x: px + 42, w: SIZES.logoSize + SIZES.logoPad },
        team:  { x: 0, w: 0 },
        played:{ x: 0, w: 36 },
        wins:  { x: 0, w: 36 },
        draws: { x: 0, w: 36 },
        losses:{ x: 0, w: 36 },
        gf:    { x: 0, w: 40 },
        ga:    { x: 0, w: 40 },
        gd:    { x: 0, w: 46 },
        points:{ x: 0, w: 46 }
    };

    const fixed =
        c.pos.w + c.logo.w +
        c.played.w + c.wins.w + c.draws.w + c.losses.w +
        c.gf.w + c.ga.w + c.gd.w + c.points.w;

    c.team.w = usable - fixed;
    c.team.x = c.logo.x + c.logo.w;

    let nx = c.team.x + c.team.w;
    for (const key of ['played', 'wins', 'draws', 'losses', 'gf', 'ga', 'gd', 'points']) {
        c[key].x = nx;
        nx += c[key].w;
    }

    return c;
}

/*
========================================
DRAW: HEADER
========================================
*/

function drawHeader(ctx, { cols, x, y, w }) {
    const h = THEME.header;

    ctx.fillStyle = h.bg;
    ctx.fillRect(x, y, w, h.height);

    // Gradient glow separator under header
    const sepGrad = ctx.createLinearGradient(x, y + h.height - 1, x + w, y + h.height - 1);
    sepGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    sepGrad.addColorStop(0.15, 'rgba(93, 173, 226, 0.30)');
    sepGrad.addColorStop(0.5, 'rgba(93, 173, 226, 0.50)');
    sepGrad.addColorStop(0.85, 'rgba(93, 173, 226, 0.30)');
    sepGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = sepGrad;
    ctx.fillRect(x, y + h.height - 1.5, w, 1.5);

    ctx.fillStyle = h.text;
    ctx.font = `bold 11px "${h.font}", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const midY = y + h.height / 2;

    ctx.fillText('#', x + cols.pos.x + cols.pos.w / 2, midY);

    ctx.textAlign = 'left';
    ctx.fillText('TEAM', x + cols.team.x + 6, midY);

    ctx.textAlign = 'center';
    const headers = {
        played: 'P', wins: 'W', draws: 'D', losses: 'L',
        gf: 'GF', ga: 'GA', gd: 'GD', points: 'PTS'
    };

    for (const [key, label] of Object.entries(headers)) {
        ctx.fillText(label, x + cols[key].x + cols[key].w / 2, midY);
    }

    // Column separator lines in header
    ctx.fillStyle = 'rgba(100, 140, 200, 0.10)';
    for (const key of ['played', 'wins', 'draws', 'losses', 'gf', 'ga', 'gd', 'points']) {
        ctx.fillRect(x + cols[key].x, y + 6, 1, h.height - 12);
    }

    ctx.textAlign = 'left';
}

/*
========================================
DRAW: TEAM ROW
========================================
*/

function drawTeamRow(ctx, {
    entry, position, zone, cols, x, y, w,
    isEven, teamColor, logoKey, logoCache
}) {
    const r = THEME.row;
    const z = THEME.zone;
    const h = r.height;
    const midY = y + h / 2;
    const stats = entry.stats || {};
    const gd = (stats.gf || 0) - (stats.ga || 0);

    const tc = parseTeamColor(teamColor);

    // Row background
    ctx.fillStyle = isEven ? r.even : r.odd;
    ctx.fillRect(x, y, w, h);

    // ── LEFT: Team color stripe (3px) ──
    if (tc) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = tc.raw;
        ctx.fillRect(x, y, 3, h);
        ctx.restore();
    }

    // ── RIGHT: Qualification zone (gradient from right + accent bar) ──
    if (zone === 'ucl' || zone === 'qualification') {
        const zd = zone === 'ucl' ? z.ucl : z.qualification;

        // Gradient tint from RIGHT edge, fading left 250px
        const grad = ctx.createLinearGradient(x + w, y, x + w - 250, y);
        grad.addColorStop(0, zd.bg);
        grad.addColorStop(1, zd.gradientEnd);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);

        // Right accent bar (thicker, 4px)
        ctx.fillStyle = zd.accent;
        ctx.fillRect(x + w - 4, y, 4, h);
    }

    // Column separator lines
    for (const key of ['played', 'wins', 'draws', 'losses', 'gf', 'ga', 'gd', 'points']) {
        ctx.fillStyle = r.colLine;
        ctx.fillRect(x + cols[key].x, y + 6, 1, h - 12);
    }

    // Bottom border
    ctx.fillStyle = r.border;
    ctx.fillRect(x, y + h - 1, w, 1);

    // ── Position badge ──
    const badgeR = r.badgeSize / 2;
    const badgeCx = x + cols.pos.x + cols.pos.w / 2;

    let badgeBg, badgeText;

    if (position === 1) {
        badgeBg = r.badgeBgFirst;
        badgeText = r.badgeTextFirst;
    } else if (zone === 'ucl') {
        badgeBg = r.badgeBgUcl;
        badgeText = z.ucl.accent;
    } else if (zone === 'qualification') {
        badgeBg = r.badgeBgQual;
        badgeText = z.qualification.accent;
    } else {
        badgeBg = r.badgeBgDefault;
        badgeText = r.textSecondary;
    }

    if (position === 1) {
        ctx.save();
        ctx.shadowColor = 'rgba(201, 168, 76, 0.25)';
        ctx.shadowBlur = 8;
    }

    ctx.fillStyle = badgeBg;
    ctx.beginPath();
    ctx.arc(badgeCx, midY, badgeR, 0, Math.PI * 2);
    ctx.fill();

    if (position === 1) {
        ctx.restore();
    }

    ctx.fillStyle = badgeText;
    ctx.font = `bold 12px "${r.badgeFont}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(position), badgeCx, midY + 1);

    // ── Logo ──
    const logoImg = logoCache.get(logoKey);
    if (logoImg) {
        const lx = x + cols.logo.x + SIZES.logoPad / 2;
        const ly = midY - SIZES.logoSize / 2;
        ctx.save();
        drawCircularImage(ctx, logoImg, lx, ly, SIZES.logoSize);
        ctx.restore();
    } else {
        const cx = x + cols.logo.x + SIZES.logoPad / 2 + SIZES.logoSize / 2;

        ctx.fillStyle = tc ? tc.muted : r.textMuted;
        ctx.beginPath();
        ctx.arc(cx, midY, SIZES.logoSize / 2, 0, Math.PI * 2);
        ctx.fill();

        const ch = (getTeamName(entry) || '?')[0].toUpperCase();
        ctx.fillStyle = tc ? tc.bright : r.textSecondary;
        ctx.font = `bold ${Math.floor(SIZES.logoSize * 0.5)}px "Inter SemiBold", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(ch, cx, midY + 1);
    }

    // ── Team name in team color with subtle shadow ──
    const maxChars = Math.floor(cols.team.w / 8);
    const displayName = compactName(getTeamName(entry), maxChars);
    const nameX = x + cols.team.x + 6;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `bold 14px "${r.nameFont}", sans-serif`;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = tc ? tc.bright : r.textPrimary;
    ctx.fillText(displayName, nameX, midY);
    ctx.restore();

    // Stats
    const statFields = {
        played: String(stats.played || 0),
        wins:   String(stats.wins || 0),
        draws:  String(stats.draws || 0),
        losses: String(stats.losses || 0),
        gf:     String(stats.gf || 0),
        ga:     String(stats.ga || 0),
        gd:     `${gd >= 0 ? '+' : ''}${gd}`,
        points: String(stats.points || 0)
    };

    ctx.textAlign = 'center';

    for (const [key, value] of Object.entries(statFields)) {
        if (key === 'points') {
            const px = x + cols[key].x;
            const pw = cols[key].w;
            ctx.fillStyle = THEME.points.bg;
            ctx.fillRect(px, y + 4, pw, h - 8);

            ctx.save();
            ctx.shadowColor = r.statShadow;
            ctx.shadowBlur = 3;
            ctx.shadowOffsetY = 1;
            ctx.fillStyle = THEME.points.text;
            ctx.font = `bold 15px "Inter SemiBold", sans-serif`;
            ctx.fillText(value, x + cols[key].x + cols[key].w / 2, midY);
            ctx.restore();
        } else if (key === 'gd') {
            const px = x + cols[key].x;
            const pw = cols[key].w;
            const pillH = 18;
            const pillY = midY - pillH / 2;

            if (gd > 0) {
                ctx.fillStyle = THEME.gd.pillPositive;
            } else if (gd < 0) {
                ctx.fillStyle = THEME.gd.pillNegative;
            } else {
                ctx.fillStyle = THEME.gd.pillZero;
            }
            roundRect(ctx, px + 2, pillY, pw - 4, pillH, 4);
            ctx.fill();

            ctx.save();
            ctx.shadowColor = r.statShadow;
            ctx.shadowBlur = 3;
            ctx.shadowOffsetY = 1;
            ctx.fillStyle = gd > 0 ? THEME.gd.positive : gd < 0 ? THEME.gd.negative : THEME.gd.zero;
            ctx.font = `bold 12px "Inter SemiBold", sans-serif`;
            ctx.fillText(value, x + cols[key].x + cols[key].w / 2, midY);
            ctx.restore();
        } else {
            ctx.save();
            ctx.shadowColor = r.statShadow;
            ctx.shadowBlur = 2;
            ctx.shadowOffsetY = 1;
            ctx.fillStyle = r.textSecondary;
            ctx.font = `14px "${r.statFont}", sans-serif`;
            ctx.fillText(value, x + cols[key].x + cols[key].w / 2, midY);
            ctx.restore();
        }
    }

    ctx.textAlign = 'left';
}

/*
========================================
DRAW: ZONE SEPARATOR
========================================
*/

function drawZoneSeparator(ctx, { x, y, w, zone }) {
    const zd = zone === 'ucl' ? THEME.zone.ucl : THEME.zone.qualification;
    const accent = zd.accent;

    // Draw from RIGHT side
    const grad = ctx.createLinearGradient(x + w, y, x, y);
    grad.addColorStop(0, accent);
    grad.addColorStop(0.3, accent);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, 1);
}

/*
========================================
DRAW: LEGEND
========================================
*/

function drawLegend(ctx, { settings, zones, groupKey, x, y, w }) {
    const l = THEME.legend;
    const h = l.height;

    ctx.fillStyle = l.bg;
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = l.border;
    ctx.fillRect(x, y, w, 1);

    const midY = y + h / 2;
    let lx = x + SIZES.paddingX;

    const hasUcl = zones.includes('ucl');
    const hasQual = zones.includes('qualification');

    ctx.textBaseline = 'middle';

    if (hasUcl) {
        ctx.fillStyle = THEME.zone.ucl.accent;
        ctx.beginPath();
        ctx.arc(lx + 5, midY, 4, 0, Math.PI * 2);
        ctx.fill();
        lx += 14;

        ctx.fillStyle = l.text;
        ctx.font = `11px "${l.font}", sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText('UCL', lx, midY);
        lx += ctx.measureText('UCL').width + 18;
    }

    if (hasQual) {
        ctx.fillStyle = THEME.zone.qualification.accent;
        ctx.beginPath();
        ctx.arc(lx + 5, midY, 4, 0, Math.PI * 2);
        ctx.fill();
        lx += 14;

        ctx.fillStyle = l.text;
        ctx.font = `11px "${l.font}", sans-serif`;
        ctx.fillText('Qualification', lx, midY);
        lx += ctx.measureText('Qualification').width + 18;
    }

    if (hasUcl || hasQual) {
        const parts = [];
        if (hasUcl) parts.push(`UCL: Top ${settings.uclQualificationSpots || 0}`);
        if (hasQual) {
            parts.push(groupKey
                ? `Qualify: Top ${settings.qualificationSpotsPerGroup || 0}/group`
                : `Qualify: Top ${settings.qualificationSpotsPerGroup || 0}`);
        }
        ctx.fillStyle = THEME.row.textMuted;
        ctx.font = `10px "${l.font}", sans-serif`;
        ctx.fillText(parts.join('  \u00B7  '), lx, midY);
    }

    ctx.fillStyle = l.time;
    ctx.font = `10px "${l.font}", sans-serif`;
    ctx.textAlign = 'right';
    const now = new Date();
    ctx.fillText(
        `Updated: ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        x + w - SIZES.paddingX,
        midY
    );
    ctx.textAlign = 'left';
}

/*
========================================
UTILITIES
========================================
*/

/**
 * Scatter team logos as subtle particles in the background area.
 */
function getTeamName(entry) {
    return entry.teamNameSnapshot || entry.teamId?.name || 'Unknown';
}

/**
 * Parse a team color hex string into usable color variants.
 * Returns null if no valid color. Generates:
 *   - raw: the hex color
 *   - bright: brightened version for text (ensures visibility on dark bg)
 *   - muted: dark muted version for placeholder circles
 *   - badgeBg: semi-transparent version for position badge bg
 *   - tintBg: very subtle row tint
 *   - pillBg: subtle points pill background
 */
function parseTeamColor(hex) {
    if (!hex || typeof hex !== 'string') return null;

    // Normalize
    hex = hex.trim();
    if (!hex.startsWith('#')) return null;

    // Strip alpha if present
    hex = hex.slice(0, 7);

    let r, g, b;
    if (hex.length === 4) {
        r = parseInt(hex[1] + hex[1], 16);
        g = parseInt(hex[2] + hex[2], 16);
        b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length === 7) {
        r = parseInt(hex.slice(1, 3), 16);
        g = parseInt(hex.slice(3, 5), 16);
        b = parseInt(hex.slice(5, 7), 16);
    } else {
        return null;
    }

    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;

    // Perceived brightness (0-255)
    const lum = (0.299 * r + 0.587 * g + 0.114 * b);

    // Too dark to see on dark background — fall back to theme defaults
    if (lum < 60) return null;

    // Bright version: ensure minimum luminance ~140 so it's readable on dark bg
    let br = r, bg = g, bb = b;
    if (lum < 140) {
        const boost = 1 + ((140 - lum) / lum) * 0.8;
        br = Math.min(255, Math.round(r * boost));
        bg = Math.min(255, Math.round(g * boost));
        bb = Math.min(255, Math.round(b * boost));
    }
    // Don't oversaturate brights — cap at 230 so they don't wash out
    br = Math.min(br, 230);
    bg = Math.min(bg, 230);
    bb = Math.min(bb, 230);

    const raw = `rgb(${r}, ${g}, ${b})`;
    const bright = `rgb(${br}, ${bg}, ${bb})`;
    const muted = `rgba(${Math.round(r * 0.4)}, ${Math.round(g * 0.4)}, ${Math.round(b * 0.4)}, 0.5)`;
    const badgeBg = `rgba(${r}, ${g}, ${b}, 0.25)`;
    const tintBg = `rgba(${r}, ${g}, ${b}, 0.06)`;
    const pillBg = `rgba(${r}, ${g}, ${b}, 0.12)`;

    return { raw, bright, muted, badgeBg, tintBg, pillBg };
}

function drawCircularImage(ctx, image, x, y, size) {
    const r = size / 2;
    const cx = x + r;
    const cy = y + r;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(image, x, y, size, size);
    ctx.restore();

    ctx.strokeStyle = 'rgba(126, 170, 230, 0.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
}

module.exports = { generateStandingsImage, registerFonts };
