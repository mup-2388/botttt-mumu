'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');

const BASE_WIDTH = 1254;
const BASE_HEIGHT = 1254;

/*
 * Hierarchy rule: untouched HFSL 4 wordmark > portrait > player name > team/date > stat value > stat label.
 * Secondary information must not compete with the name or portrait; each stat value is the anchor for its label.
 * Keep all additions typographic/cutout-only—never add panels, badges, separators, or other containers.
 */
const VISUAL_HIERARCHY = Object.freeze({
    portrait: { centerX: 715, centerY: 515, diameter: 255 },
    playerName: { size: 40, minSize: 38, wrapSize: 30, color: '#F6FAFD' },
    team: { size: 24, minSize: 21, color: '#75C9D9' },
    date: { size: 21, minSize: 18, color: '#C6D0DA' },
    statValue: { size: 32, color: '#F6FAFD' },
    statLabel: { size: 17, color: '#83C7D3' },
    textShadow: '#071A32'
});

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
    color = VISUAL_HIERARCHY.playerName.color,
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
    wrapStartSize = minSize,
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

    // Preserve a headline-sized single line first; wrap only when required by the fixed safe zone.
    // Exceptionally long text may shrink slightly after wrapping so it never overlaps the artwork.
    let layout = null;
    let chosenSize = wrapStartSize;
    for (let candidateSize = wrapStartSize; candidateSize >= fallbackMinSize; candidateSize -= 0.5) {
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
    const x = 959;
    const width = 388;
    const top = 646;
    const bottom = 755;
    const family = 'Inter SemiBold';
    const size = VISUAL_HIERARCHY.date.size;
    const minSize = VISUAL_HIERARCHY.date.minSize;
    const letterSpacing = 0.2;
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
            color: VISUAL_HIERARCHY.date.color,
            align: 'right',
            letterSpacing,
            shadow: { color: VISUAL_HIERARCHY.textShadow, offsetX: 0, offsetY: 1, blur: 0, opacity: 0.55 }
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
        color: VISUAL_HIERARCHY.date.color,
        align: 'right',
        letterSpacing,
        shadow: { color: VISUAL_HIERARCHY.textShadow, offsetX: 0, offsetY: 1, blur: 0, opacity: 0.55 }
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

function isNeutralBackdropPixel(data, pixelIndex, referenceColor = null) {
    const offset = pixelIndex * 4;
    if (data[offset + 3] < 16) return false;

    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    const luminance = (red + green + blue) / 3;
    if (spread > 46 || luminance > 225) return false;

    if (referenceColor) {
        const colorDistance = Math.max(
            Math.abs(red - referenceColor.red),
            Math.abs(green - referenceColor.green),
            Math.abs(blue - referenceColor.blue)
        );
        if (colorDistance > 58) return false;
    }

    return true;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// Remove only flat neutral gray/black backdrop pixels connected to the edge or an inset circular backdrop ring.
// Transparent source pixels and isolated neutral details in the player are preserved.
function removeNeutralEdgeBackground(imageData, width, height) {
    const data = imageData?.data;
    if (!data || width < 3 || height < 3 || data.length < width * height * 4) return 0;

    const edgeIndices = [];
    const edgeColors = [];
    const addEdgePixel = (x, y) => {
        const pixelIndex = y * width + x;
        edgeIndices.push(pixelIndex);
        if (!isNeutralBackdropPixel(data, pixelIndex)) return;
        const offset = pixelIndex * 4;
        edgeColors.push([data[offset], data[offset + 1], data[offset + 2]]);
    };

    for (let x = 0; x < width; x += 1) {
        addEdgePixel(x, 0);
        addEdgePixel(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
        addEdgePixel(0, y);
        addEdgePixel(width - 1, y);
    }

    let seedIndices = [];
    let referenceSamples = [];
    const edgePixelCount = width * 2 + (height - 2) * 2;
    if (edgeColors.length / edgePixelCount >= 0.08) {
        seedIndices = edgeIndices.filter(pixelIndex => isNeutralBackdropPixel(data, pixelIndex));
        referenceSamples = edgeColors;
    } else {
        // Also detect a neutral circular backdrop that is inset from transparent square corners.
        const centerX = (width - 1) / 2;
        const centerY = (height - 1) / 2;
        const side = Math.min(width, height);
        let bestRing = null;
        for (const radiusRatio of [0.3, 0.36, 0.42, 0.47]) {
            const ring = new Set();
            for (let step = 0; step < 40; step += 1) {
                const angle = (step / 40) * Math.PI * 2;
                const x = Math.max(0, Math.min(width - 1, Math.round(centerX + Math.cos(angle) * side * radiusRatio)));
                const y = Math.max(0, Math.min(height - 1, Math.round(centerY + Math.sin(angle) * side * radiusRatio)));
                const pixelIndex = y * width + x;
                if (isNeutralBackdropPixel(data, pixelIndex)) ring.add(pixelIndex);
            }
            if (!bestRing || ring.size > bestRing.size) bestRing = ring;
        }

        if (!bestRing || bestRing.size < 10) return 0;
        seedIndices = [...bestRing];
        referenceSamples = seedIndices.map(pixelIndex => {
            const offset = pixelIndex * 4;
            return [data[offset], data[offset + 1], data[offset + 2]];
        });
    }

    if (!seedIndices.length) return 0;
    const referenceColor = {
        red: median(referenceSamples.map(color => color[0])),
        green: median(referenceSamples.map(color => color[1])),
        blue: median(referenceSamples.map(color => color[2]))
    };
    const pixelCount = width * height;
    const candidates = new Uint8Array(pixelCount);
    const visited = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        if (isNeutralBackdropPixel(data, pixelIndex, referenceColor)) candidates[pixelIndex] = 1;
    }

    let head = 0;
    let tail = 0;
    const enqueue = pixelIndex => {
        if (!candidates[pixelIndex] || visited[pixelIndex]) return;
        visited[pixelIndex] = 1;
        queue[tail] = pixelIndex;
        tail += 1;
    };
    seedIndices.forEach(enqueue);

    while (head < tail) {
        const pixelIndex = queue[head];
        head += 1;
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);
        if (x > 0) enqueue(pixelIndex - 1);
        if (x + 1 < width) enqueue(pixelIndex + 1);
        if (y > 0) enqueue(pixelIndex - width);
        if (y + 1 < height) enqueue(pixelIndex + width);
    }

    let opaquePixelCount = 0;
    for (let offset = 3; offset < data.length; offset += 4) {
        if (data[offset] >= 16) opaquePixelCount += 1;
    }
    if (!tail || tail > opaquePixelCount * 0.98) return 0;

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        if (visited[pixelIndex]) data[pixelIndex * 4 + 3] = 0;
    }

    return tail;
}
function createPortraitCutout(avatar) {
    if (!avatar || !avatar.width || !avatar.height) return null;

    const side = Math.floor(Math.min(avatar.width, avatar.height));
    if (!side) return null;

    try {
        const canvas = createCanvas(side, side);
        const ctx = canvas.getContext('2d');
        if (typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') return null;

        const sourceX = (avatar.width - side) / 2;
        const sourceY = (avatar.height - side) / 2;
        ctx.drawImage(avatar, sourceX, sourceY, side, side, 0, 0, side, side);
        const imageData = ctx.getImageData(0, 0, side, side);
        if (!removeNeutralEdgeBackground(imageData, side, side)) return null;
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    } catch (error) {
        console.warn('[potdCard] Could not remove a neutral avatar backdrop; preserving the source alpha:', error?.message || error);
        return null;
    }
}

function drawPortrait(ctx, avatar, playerName) {
    const { centerX: cx, centerY: cy, diameter } = VISUAL_HIERARCHY.portrait;
    const radius = diameter / 2;
    const left = cx - radius;
    const top = cy - radius;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    if (avatar && avatar.width > 0 && avatar.height > 0) {
        const cutout = createPortraitCutout(avatar);
        if (cutout) {
            ctx.drawImage(cutout, left, top, diameter, diameter);
        } else {
            const cropSize = Math.min(avatar.width, avatar.height);
            const sourceX = (avatar.width - cropSize) / 2;
            const sourceY = (avatar.height - cropSize) / 2;
            ctx.drawImage(avatar, sourceX, sourceY, cropSize, cropSize, left, top, diameter, diameter);
        }
    } else {
        // Fallback only when no portrait can be loaded; no frame or badge is added.
        const gradient = ctx.createLinearGradient(left, top, left + diameter, top + diameter);
        gradient.addColorStop(0, '#0C83E8');
        gradient.addColorStop(1, '#061943');
        ctx.fillStyle = gradient;
        ctx.fillRect(left, top, diameter, diameter);
        const initials = cleanText(playerName, 48).split(/\s+/).map(part => part[0] || '').join('').slice(0, 2).toUpperCase();
        setFont(ctx, 48, 'Oswald');
        ctx.fillStyle = VISUAL_HIERARCHY.playerName.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials || '?', cx, cy);
    }
    ctx.restore();
}

function drawStats(ctx, stats) {
    const count = stats.length;
    if (!count) return;

    // Center the actual group for each count; two stats use the requested x=470/785 pair.
    const centersByCount = {
        1: [627],
        2: [470, 785],
        3: [420, 627, 834]
    };
    const centers = centersByCount[count] || [627];
    const maxTextWidth = count === 1 ? 640 : count === 2 ? 260 : 180;
    const valueShadow = { color: VISUAL_HIERARCHY.textShadow, offsetX: 0, offsetY: 2, blur: 0, opacity: 0.7 };
    const labelShadow = { color: VISUAL_HIERARCHY.textShadow, offsetX: 0, offsetY: 1, blur: 0, opacity: 0.55 };

    stats.forEach((stat, index) => {
        const centerX = centers[index];
        drawFittedText(ctx, stat.value, {
            x: centerX,
            y: 918,
            width: maxTextWidth,
            size: VISUAL_HIERARCHY.statValue.size,
            minSize: 24,
            family: 'Oswald',
            color: VISUAL_HIERARCHY.statValue.color,
            align: 'center',
            letterSpacing: 0.2,
            shadow: valueShadow
        });
        if (stat.label) {
            drawFittedText(ctx, stat.label, {
                x: centerX,
                y: 947,
                width: maxTextWidth,
                size: VISUAL_HIERARCHY.statLabel.size,
                minSize: 14,
                family: 'Inter SemiBold',
                color: VISUAL_HIERARCHY.statLabel.color,
                align: 'center',
                letterSpacing: 0.2,
                shadow: labelShadow
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
        baseline: 677,
        width: 203,
        size: VISUAL_HIERARCHY.playerName.size,
        minSize: VISUAL_HIERARCHY.playerName.minSize,
        wrapStartSize: VISUAL_HIERARCHY.playerName.wrapSize,
        fallbackMinSize: 24,
        lineHeight: 29,
        family: 'Oswald',
        color: VISUAL_HIERARCHY.playerName.color,
        letterSpacing: 0,
        shadow: { color: VISUAL_HIERARCHY.textShadow, offsetX: 0, offsetY: 2, blur: 0, opacity: 0.72 }
    });
    if (team) {
        drawAdaptiveText(ctx, team, {
            x: 282,
            top: 696,
            bottom: 755,
            baseline: 736,
            width: 203,
            size: VISUAL_HIERARCHY.team.size,
            minSize: VISUAL_HIERARCHY.team.minSize,
            wrapStartSize: VISUAL_HIERARCHY.team.minSize,
            fallbackMinSize: 16,
            lineHeight: 27,
            family: 'Inter SemiBold',
            color: VISUAL_HIERARCHY.team.color,
            letterSpacing: 0.2,
            shadow: { color: VISUAL_HIERARCHY.textShadow, offsetX: 0, offsetY: 1, blur: 0, opacity: 0.58 }
        });
    }

    drawMatchDate(ctx, [match, date]);
    drawStats(ctx, cardStats);
    ctx.restore();

    return canvas.toBuffer('image/png');
}

module.exports = {
    parseStats,
    removeNeutralEdgeBackground,
    resolveTemplatePath,
    renderPotdCard
};