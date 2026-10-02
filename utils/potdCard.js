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

function fitFontSize(ctx, text, maxWidth, startSize, minSize, family) {
    let size = startSize;
    setFont(ctx, size, family);
    while (size > minSize && ctx.measureText(text).width > maxWidth) {
        size -= 1;
        setFont(ctx, size, family);
    }
    return size;
}

function drawFittedText(ctx, text, { x, y, width, size, minSize = 10, family = 'Inter', color = '#F4FBFF', align = 'left', stroke = null, strokeWidth = 0 }) {
    if (!text) return;
    const fitted = fitFontSize(ctx, text, width, size, minSize, family);
    setFont(ctx, fitted, family);
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0, 7, 28, 0.9)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 2;
    if (stroke) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = stroke;
        ctx.strokeText(text, x, y, width);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y, width);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
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
    const cx = 0.57 * BASE_WIDTH;
    const cy = 0.4185 * BASE_HEIGHT;
    const radius = 0.086 * BASE_HEIGHT;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 8, 0, Math.PI * 2);
    ctx.shadowColor = '#00CFFF';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#071944';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    if (avatar) {
        ctx.drawImage(avatar, cx - radius, cy - radius, radius * 2, radius * 2);
    } else {
        const gradient = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
        gradient.addColorStop(0, '#0C83E8');
        gradient.addColorStop(1, '#061943');
        ctx.fillStyle = gradient;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        const initials = cleanText(playerName, 48).split(/\s+/).map(part => part[0] || '').join('').slice(0, 2).toUpperCase();
        setFont(ctx, 48, 'Oswald');
        ctx.fillStyle = '#EAFBFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials || '?', cx, cy);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, radius + 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#F4FBFF';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.strokeStyle = '#00CFFF';
    ctx.lineWidth = 5;
    ctx.shadowColor = '#00CFFF';
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function drawStats(ctx, stats) {
    const left = 0.225 * BASE_WIDTH;
    const right = 0.775 * BASE_WIDTH;
    const count = stats.length;
    const regionWidth = right - left;
    const columnWidth = regionWidth / count;

    stats.forEach((stat, index) => {
        const centerX = left + columnWidth * (index + 0.5);
        drawFittedText(ctx, stat.value, {
            x: centerX,
            y: 0.724 * BASE_HEIGHT,
            width: columnWidth * 0.84,
            size: 50,
            minSize: 26,
            family: 'Oswald',
            color: '#F4FBFF',
            align: 'center',
            stroke: '#08265D',
            strokeWidth: 3
        });
        if (stat.label) {
            drawFittedText(ctx, stat.label, {
                x: centerX,
                y: 0.754 * BASE_HEIGHT,
                width: columnWidth * 0.94,
                size: 17,
                minSize: 10,
                family: 'Inter SemiBold',
                color: '#72E8FF',
                align: 'center'
            });
        }
    });

    if (count > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(93, 223, 255, 0.75)';
        ctx.lineWidth = 1.5;
        for (let index = 1; index < count; index += 1) {
            const x = left + columnWidth * index;
            ctx.beginPath();
            ctx.moveTo(x, 0.696 * BASE_HEIGHT);
            ctx.lineTo(x, 0.758 * BASE_HEIGHT);
            ctx.stroke();
        }
        ctx.restore();
    }
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

    // Coordinates are based on the user's 1254×1254 layout analysis.
    drawPortrait(ctx, await fetchAvatar(avatarUrl), name);

    drawFittedText(ctx, 'PLAYER OF THE DAY', {
        x: 0.225 * BASE_WIDTH,
        y: 0.492 * BASE_HEIGHT,
        width: 0.17 * BASE_WIDTH,
        size: 15,
        minSize: 10,
        family: 'Inter SemiBold',
        color: '#72E8FF',
        align: 'left'
    });
    drawFittedText(ctx, name.toUpperCase(), {
        x: 0.225 * BASE_WIDTH,
        y: 0.542 * BASE_HEIGHT,
        width: 0.17 * BASE_WIDTH,
        size: 35,
        minSize: 19,
        family: 'Oswald',
        color: '#F4FBFF',
        align: 'left',
        stroke: '#06245D',
        strokeWidth: 2
    });
    if (team) {
        drawFittedText(ctx, team, {
            x: 0.225 * BASE_WIDTH,
            y: 0.589 * BASE_HEIGHT,
            width: 0.17 * BASE_WIDTH,
            size: 18,
            minSize: 10,
            family: 'Inter SemiBold',
            color: '#72E8FF',
            align: 'left'
        });
    }

    const matchDate = [match || 'MATCH DAY', date].filter(Boolean).join(' · ');
    if (matchDate) {
        drawFittedText(ctx, matchDate, {
            x: 0.61 * BASE_WIDTH,
            y: 0.582 * BASE_HEIGHT,
            width: 0.31 * BASE_WIDTH,
            size: 17,
            minSize: 10,
            family: 'Inter SemiBold',
            color: '#F4FBFF',
            align: 'center'
        });
    }

    drawFittedText(ctx, 'MATCH-DAY PERFORMANCE', {
        x: BASE_WIDTH / 2,
        y: 0.678 * BASE_HEIGHT,
        width: 0.52 * BASE_WIDTH,
        size: 16,
        minSize: 10,
        family: 'Inter SemiBold',
        color: '#72E8FF',
        align: 'center'
    });
    drawStats(ctx, cardStats);
    ctx.restore();

    return canvas.toBuffer('image/png');
}

module.exports = {
    parseStats,
    resolveTemplatePath,
    renderPotdCard
};