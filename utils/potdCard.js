'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');

const BASE_WIDTH = 1254;
const BASE_HEIGHT = 1254;
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const FONT_FILES = [
    ['Inter_18pt-Regular.ttf', 'Inter'],
    ['Inter_18pt-SemiBold.ttf', 'Inter SemiBold'],
    ['Oswald-Bold.ttf', 'Oswald']
];

let fontsRegistered = false;

function registerFonts() {
    if (fontsRegistered) return;

    for (const [file, family] of FONT_FILES) {
        const fontPath = path.join(ASSETS_DIR, 'fonts', file);
        if (fs.existsSync(fontPath)) {
            try {
                GlobalFonts.registerFromPath(fontPath, family);
            } catch (error) {
                console.warn(`[potdCard] Could not register ${file}:`, error?.message || error);
            }
        }
    }

    fontsRegistered = true;
}

function resolveTemplatePath() {
    const envPath = String(process.env.POTD_TEMPLATE_PATH || '').trim();
    const candidates = [
        envPath ? path.resolve(process.cwd(), envPath) : null,
        path.join(ASSETS_DIR, 'potd-template.png'),
        path.join(ASSETS_DIR, 'hfsl4-potd-template.png'),
        path.join(ASSETS_DIR, 'potd_template.png')
    ].filter(Boolean);
    const found = candidates.find(candidate => fs.existsSync(candidate));

    if (!found) {
        throw new Error('POTD template not found. Add the original HFSL 4 card as assets/potd-template.png (or set POTD_TEMPLATE_PATH).');
    }

    return found;
}

function cleanText(value, maxLength = 48) {
    return String(value ?? '')
        .replace(/<@!?\d+>|<@&\d+>|<#[0-9]+>/g, '')
        .replace(/@\s?(everyone|here)/gi, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function parseStats(input) {
    const items = Array.isArray(input)
        ? input.filter(item => item != null && (typeof item === 'object' || String(item).trim()))
        : String(input ?? '')
            .split(/[,;|\n•]+/g)
            .map(item => item.trim())
            .filter(Boolean);

    if (!items.length) throw new Error('Provide at least one match-day stat, e.g. `2 Goals, 1 Assist, 4 Shots`.');
    if (items.length > 3) throw new Error('The POTD card supports up to three stats; separate them with commas.');

    return items.map(item => {
        if (item && typeof item === 'object') {
            return {
                value: cleanText(item.value, 12) || '—',
                label: cleanText(item.label, 20).toUpperCase()
            };
        }

        const raw = String(item).trim();
        let value = '';
        let label = '';
        let match = raw.match(/^(.{1,24}?)\s*[:=]\s*(.{1,14})$/);

        if (match) {
            label = match[1].trim();
            value = match[2].trim();
        } else if ((match = raw.match(/^([+-]?\d+(?:\.\d+)?%?)\s+(.{1,24})$/))) {
            value = match[1].trim();
            label = match[2].trim();
        } else if ((match = raw.match(/^(.{1,24}?)\s+([+-]?\d+(?:\.\d+)?%?)$/))) {
            label = match[1].trim();
            value = match[2].trim();
        } else {
            value = raw;
        }

        return {
            value: cleanText(value, 12) || '—',
            label: cleanText(label, 20).toUpperCase()
        };
    });
}

function setFont(ctx, size, family) {
    ctx.font = `${Math.max(8, size)}px "${family}"`;
}

function hasNativeLetterSpacing(ctx) {
    return Boolean(ctx && 'letterSpacing' in ctx);
}

function measureTextWidth(ctx, text, letterSpacing = 0) {
    const value = String(text ?? '');
    if (!value) return 0;

    if (!letterSpacing) return ctx.measureText(value).width;

    if (hasNativeLetterSpacing(ctx)) {
        const previous = ctx.letterSpacing;
        ctx.letterSpacing = `${letterSpacing}px`;
        const width = ctx.measureText(value).width;
        ctx.letterSpacing = previous;
        return width;
    }

    const glyphs = Array.from(value);
    const glyphWidth = glyphs.reduce((width, glyph) => width + ctx.measureText(glyph).width, 0);
    return glyphWidth + letterSpacing * Math.max(0, glyphs.length - 1);
}

function fitFontSize(ctx, text, maxWidth, startSize, minSize, family, letterSpacing = 0) {
    if (!text || maxWidth <= 0) return startSize;

    setFont(ctx, startSize, family);
    const measuredWidth = measureTextWidth(ctx, text, letterSpacing);
    if (measuredWidth <= maxWidth) return startSize;

    let size = Math.max(minSize, startSize * maxWidth / measuredWidth);
    setFont(ctx, size, family);
    while (size > minSize && measureTextWidth(ctx, text, letterSpacing) > maxWidth) {
        size = Math.max(minSize, size - 0.1);
        setFont(ctx, size, family);
    }
    return Number(size.toFixed(2));
}

function drawTrackedText(ctx, text, x, y, align, letterSpacing = 0) {
    if (!letterSpacing || hasNativeLetterSpacing(ctx)) {
        if (hasNativeLetterSpacing(ctx)) {
            const previous = ctx.letterSpacing;
            ctx.letterSpacing = `${letterSpacing}px`;
            ctx.fillText(text, x, y);
            ctx.letterSpacing = previous;
        } else {
            ctx.fillText(text, x, y);
        }
        return;
    }

    const glyphs = Array.from(String(text));
    const totalWidth = measureTextWidth(ctx, text, letterSpacing);
    let cursorX = align === 'center' ? x - totalWidth / 2 : align === 'right' ? x - totalWidth : x;
    const previousAlign = ctx.textAlign;
    ctx.textAlign = 'left';

    glyphs.forEach((glyph, index) => {
        ctx.fillText(glyph, cursorX, y);
        cursorX += ctx.measureText(glyph).width;
        if (index < glyphs.length - 1) cursorX += letterSpacing;
    });

    ctx.textAlign = previousAlign;
}

function shadowColor(hex, opacity = 0.8) {
    const match = String(hex || '').match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
    if (!match) return 'rgba(0, 0, 0, 0)';
    const [, red, green, blue] = match;
    return `rgba(${parseInt(red, 16)}, ${parseInt(green, 16)}, ${parseInt(blue, 16)}, ${opacity})`;
}

function drawFittedText(ctx, text, {
    x,
    y,
    width,
    size,
    minSize = 10,
    family = 'Inter',
    color = '#F5FCFF',
    align = 'left',
    letterSpacing = 0,
    shadow = null
}) {
    if (!text) return size;

    ctx.save();
    const fitted = fitFontSize(ctx, text, width, size, minSize, family, letterSpacing);
    setFont(ctx, fitted, family);
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.shadowColor = shadow ? shadowColor(shadow.color, shadow.opacity ?? 0.8) : 'rgba(0, 0, 0, 0)';
    ctx.shadowBlur = shadow?.blur ?? 0;
    ctx.shadowOffsetX = shadow?.offsetX ?? 0;
    ctx.shadowOffsetY = shadow?.offsetY ?? 0;
    drawTrackedText(ctx, text, x, y, align, letterSpacing);
    ctx.restore();
    return fitted;
}

function findTwoLineSplit(ctx, text, maxWidth, family, size, letterSpacing = 0) {
    const value = String(text ?? '').trim();
    if (!value) return null;
    setFont(ctx, size, family);

    const candidates = [];
    const consider = (first, second) => {
        const lineOne = String(first || '').trim();
        const lineTwo = String(second || '').trim();
        if (!lineOne || !lineTwo) return;
        const widthOne = measureTextWidth(ctx, lineOne, letterSpacing);
        const widthTwo = measureTextWidth(ctx, lineTwo, letterSpacing);
        if (widthOne <= maxWidth && widthTwo <= maxWidth) {
            candidates.push({
                lines: [lineOne, lineTwo],
                balance: Math.abs(widthOne - widthTwo),
                widest: Math.max(widthOne, widthTwo)
            });
        }
    };

    const words = value.split(/\s+/);
    for (let index = 1; index < words.length; index += 1) {
        consider(words.slice(0, index).join(' '), words.slice(index).join(' '));
    }
    if (candidates.length) {
        candidates.sort((a, b) => a.widest - b.widest || a.balance - b.balance);
        return candidates[0].lines;
    }

    const glyphs = Array.from(value);
    for (let index = 1; index < glyphs.length; index += 1) {
        consider(glyphs.slice(0, index).join(''), glyphs.slice(index).join(''));
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.widest - b.widest || a.balance - b.balance);
    return candidates[0].lines;
}

function centeredBaselines(ctx, family, size, top, bottom, lineHeight, count) {
    setFont(ctx, size, family);
    const metrics = ctx.measureText('Hg');
    const ascent = metrics.actualBoundingBoxAscent || size * 0.8;
    const descent = metrics.actualBoundingBoxDescent || size * 0.2;
    const blockHeight = ascent + descent + (count - 1) * lineHeight;
    const firstBaseline = top + Math.max(0, (bottom - top - blockHeight) / 2) + ascent;
    return Array.from({ length: count }, (_, index) => firstBaseline + index * lineHeight);
}

function drawAdaptiveText(ctx, text, {
    x,
    top,
    bottom,
    baseline,
    width,
    size,
    minSize,
    fallbackMinSize,
    lineHeight,
    family,
    color,
    letterSpacing = 0,
    shadow = null
}) {
    if (!text) return;

    const fitted = fitFontSize(ctx, text, width, size, minSize, family, letterSpacing);
    setFont(ctx, fitted, family);
    if (measureTextWidth(ctx, text, letterSpacing) <= width) {
        drawFittedText(ctx, text, {
            x, y: baseline, width, size: fitted, minSize: fitted, family, color,
            align: 'left', letterSpacing, shadow
        });
        return;
    }

    // First honor the requested minimum (25 px for names, 19 px for teams) and use two lines.
    // Only exceptionally long text falls below that size, as a last resort to stay inside the safe zone.
    let layout = null;
    let chosenSize = minSize;
    for (let candidateSize = minSize; candidateSize >= fallbackMinSize; candidateSize -= 0.5) {
        layout = findTwoLineSplit(ctx, text, width, family, candidateSize, letterSpacing);
        if (layout) {
            chosenSize = candidateSize;
            break;
        }
    }
    if (!layout) return;

    const baselines = centeredBaselines(ctx, family, chosenSize, top, bottom, lineHeight, 2);
    layout.forEach((line, index) => drawFittedText(ctx, line, {
        x,
        y: baselines[index],
        width,
        size: chosenSize,
        minSize: chosenSize,
        family,
        color,
        align: 'left',
        letterSpacing,
        shadow
    }));
}

function drawMatchDate(ctx, parts) {
    const values = parts.filter(Boolean);
    if (!values.length) return;

    const text = values.join(' · ');
    const x = 571;
    const width = 388;
    const top = 646;
    const bottom = 755;
    const family = 'Inter SemiBold';
    const size = 25;
    const minSize = 18;
    const letterSpacing = 0.3;
    const fitted = fitFontSize(ctx, text, width, size, minSize, family, letterSpacing);
    setFont(ctx, fitted, family);

    if (measureTextWidth(ctx, text, letterSpacing) <= width) {
        drawFittedText(ctx, text, {
            x,
            y: 696,
            width,
            size: fitted,
            minSize: fitted,
            family,
            color: '#F5FCFF',
            align: 'left',
            letterSpacing,
            shadow: { color: '#06205C', offsetX: 0, offsetY: 2, blur: 0, opacity: 0.8 }
        });
        return;
    }

    let lines = values.length > 1 ? values.slice(0, 2) : null;
    let chosenSize = size;
    let fits = false;
    while (chosenSize >= minSize) {
        setFont(ctx, chosenSize, family);
        if (lines && lines.every(line => measureTextWidth(ctx, line, letterSpacing) <= width)) {
            fits = true;
            break;
        }
        lines = findTwoLineSplit(ctx, text, width, family, chosenSize, letterSpacing);
        if (lines) {
            fits = true;
            break;
        }
        chosenSize -= 0.5;
        lines = null;
    }
    if (!fits || !lines) return;

    const baselines = centeredBaselines(ctx, family, chosenSize, top, bottom, 30, 2);
    lines.forEach((line, index) => drawFittedText(ctx, line, {
        x,
        y: baselines[index],
        width,
        size: chosenSize,
        minSize: chosenSize,
        family,
        color: '#F5FCFF',
        align: 'left',
        letterSpacing,
        shadow: { color: '#06205C', offsetX: 0, offsetY: 2, blur: 0, opacity: 0.8 }
    }));
}
async function fetchAvatar(url) {
    if (!url) return null;
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10_000,
            maxContentLength: 5 * 1024 * 1024
        });
        return await loadImage(Buffer.from(response.data));
    } catch (error) {
        console.warn('[potdCard] Player avatar could not be loaded; using initials:', error?.message || error);
        return null;
    }
}

function drawPortrait(ctx, avatar, playerName) {
    const cx = 715;
    const cy = 525;
    const diameter = 220;
    const radius = diameter / 2;
    const left = cx - radius;
    const top = cy - radius;

    // A clean circular crop only; the original card artwork remains visible around it.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    if (avatar && avatar.width > 0 && avatar.height > 0) {
        const cropSize = Math.min(avatar.width, avatar.height);
        const sourceX = (avatar.width - cropSize) / 2;
        const sourceY = (avatar.height - cropSize) / 2;
        ctx.drawImage(avatar, sourceX, sourceY, cropSize, cropSize, left, top, diameter, diameter);
    } else {
        const gradient = ctx.createLinearGradient(left, top, left + diameter, top + diameter);
        gradient.addColorStop(0, '#0C83E8');
        gradient.addColorStop(1, '#061943');
        ctx.fillStyle = gradient;
        ctx.fillRect(left, top, diameter, diameter);
        const initials = cleanText(playerName, 48).split(/\s+/).map(part => part[0] || '').join('').slice(0, 2).toUpperCase();
        setFont(ctx, 48, 'Oswald');
        ctx.fillStyle = '#F5FCFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials || '?', cx, cy);
    }
    ctx.restore();
}

function drawStats(ctx, stats) {
    const count = stats.length;
    if (!count) return;

    // For three stats these resolve to the requested centers: 420, 627 and 834 px.
    const centerSpacing = 207;
    const groupCenter = 627;
    const firstCenter = groupCenter - ((count - 1) * centerSpacing) / 2;
    const maxTextWidth = count === 1 ? 640 : 180;
    const valueShadow = { color: '#061B55', offsetX: 0, offsetY: 2, blur: 0, opacity: 0.8 };

    stats.forEach((stat, index) => {
        const centerX = firstCenter + index * centerSpacing;
        drawFittedText(ctx, stat.value, {
            x: centerX,
            y: 918,
            width: maxTextWidth,
            size: 25,
            minSize: 18,
            family: 'Oswald',
            color: '#F5FCFF',
            align: 'center',
            letterSpacing: 0.2,
            shadow: valueShadow
        });
        if (stat.label) {
            drawFittedText(ctx, stat.label, {
                x: centerX,
                y: 947,
                width: maxTextWidth,
                size: 17,
                minSize: 12,
                family: 'Inter SemiBold',
                color: '#73EFFF',
                align: 'center',
                letterSpacing: 0.2,
                shadow: valueShadow
            });
        }
    });
}

async function renderPotdCard({ playerName, teamName, avatarUrl, stats, matchLabel = '', dateText = '' }) {
    registerFonts();
    const templatePath = resolveTemplatePath();
    const template = await loadImage(templatePath);
    const width = template.width;
    const height = template.height;

    if (!width || !height || Math.abs(width / height - 1) > 0.02) {
        throw new Error('POTD template must be a square card image.');
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const scaleX = width / BASE_WIDTH;
    const scaleY = height / BASE_HEIGHT;
    const name = cleanText(playerName, 48) || 'PLAYER';
    const team = cleanText(teamName, 34).toUpperCase();
    const match = cleanText(matchLabel, 32).toUpperCase();
    const date = cleanText(dateText, 24).toUpperCase();
    const cardStats = parseStats(stats);

    // Draw the supplied artwork at its exact aspect ratio and dimensions; never recreate its frame or logo.
    ctx.drawImage(template, 0, 0, width, height);
    ctx.save();
    ctx.scale(scaleX, scaleY);

    // The source template is the untouched background; only user data is overlaid in its safe zones.
    drawPortrait(ctx, await fetchAvatar(avatarUrl), name);
    drawAdaptiveText(ctx, name.toUpperCase(), {
        x: 282,
        top: 637,
        bottom: 696,
        baseline: 675,
        width: 203,
        size: 31,
        minSize: 25,
        fallbackMinSize: 12,
        lineHeight: 29,
        family: 'Oswald',
        color: '#F5FCFF',
        letterSpacing: 0,
        shadow: { color: '#071A50', offsetX: 0, offsetY: 2, blur: 0, opacity: 0.8 }
    });
    if (team) {
        drawAdaptiveText(ctx, team, {
            x: 282,
            top: 696,
            bottom: 755,
            baseline: 736,
            width: 203,
            size: 23,
            minSize: 19,
            fallbackMinSize: 12,
            lineHeight: 27,
            family: 'Inter SemiBold',
            color: '#73EFFF',
            letterSpacing: 0.2,
            shadow: { color: '#071A50', offsetX: 0, offsetY: 1, blur: 0, opacity: 0.8 }
        });
    }

    drawMatchDate(ctx, [match, date]);
    drawStats(ctx, cardStats);
    ctx.restore();

    return canvas.toBuffer('image/png');
}

module.exports = {
    parseStats,
    resolveTemplatePath,
    renderPotdCard
};