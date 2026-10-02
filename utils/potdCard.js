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
    ctx.shadowColor = 'rgba(0, 7, 28, 0.85)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
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

function drawRoundedPanel(ctx, { x, y, width, height, radius = 12, fill, stroke = null, strokeWidth = 1 }) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
    }
    ctx.restore();
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
    const columnWidth = (right - left) / count;

    stats.forEach((stat, index) => {
        const centerX = left + columnWidth * (index + 0.5);
        drawFittedText(ctx, stat.value, {
            x: centerX,
            y: 0.752 * BASE_HEIGHT,
            width: columnWidth * 0.82,
            size: 46,
            minSize: 26,
            family: 'Oswald',
            color: '#F4FBFF',
            align: 'center',
            stroke: '#061B43',
            strokeWidth: 2
        });
        if (stat.label) {
            drawFittedText(ctx, stat.label, {
                x: centerX,
                y: 0.777 * BASE_HEIGHT,
                width: columnWidth * 0.92,
                size: 15,
                minSize: 10,
                family: 'Inter SemiBold',
                color: '#72E8FF',
                align: 'center'
            });
        }
    });

    if (count > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(93, 223, 255, 0.7)';
        ctx.lineWidth = 1.25;
        for (let index = 1; index < count; index += 1) {
            const x = left + columnWidth * index;
            ctx.beginPath();
            ctx.moveTo(x, 0.735 * BASE_HEIGHT);
            ctx.lineTo(x, 0.78 * BASE_HEIGHT);
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

    // Keep the supplied card art untouched; overlays follow its portrait, info and stat zones.
    drawPortrait(ctx, await fetchAvatar(avatarUrl), name);

    const leftX = 0.225 * BASE_WIDTH;
    const leftWidth = 0.17 * BASE_WIDTH;
    drawFittedText(ctx, 'PLAYER OF THE DAY', {
        x: leftX,
        y: 0.484 * BASE_HEIGHT,
        width: leftWidth,
        size: 16,
        minSize: 11,
        family: 'Inter SemiBold',
        color: '#8AF2FF',
        align: 'left'
    });

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(leftX, 0.502 * BASE_HEIGHT);
    ctx.lineTo(leftX + leftWidth * 0.9, 0.502 * BASE_HEIGHT);
    ctx.strokeStyle = 'rgba(36, 220, 255, 0.9)';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#00CFFF';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.restore();

    drawFittedText(ctx, name.toUpperCase(), {
        x: leftX,
        y: 0.542 * BASE_HEIGHT,
        width: leftWidth,
        size: 36,
        minSize: 20,
        family: 'Oswald',
        color: '#F4FBFF',
        align: 'left',
        stroke: '#06245D',
        strokeWidth: 2
    });
    if (team) {
        setFont(ctx, 15, 'Inter SemiBold');
        const teamPillWidth = Math.min(leftWidth, Math.max(74, ctx.measureText(team).width + 20));
        drawRoundedPanel(ctx, {
            x: leftX - 5,
            y: 0.563 * BASE_HEIGHT,
            width: teamPillWidth,
            height: 0.036 * BASE_HEIGHT,
            radius: 12,
            fill: 'rgba(3, 20, 55, 0.62)',
            stroke: 'rgba(92, 229, 255, 0.48)',
            strokeWidth: 1
        });
        drawFittedText(ctx, team, {
            x: leftX + 5,
            y: 0.589 * BASE_HEIGHT,
            width: leftWidth - 10,
            size: 15,
            minSize: 10,
            family: 'Inter SemiBold',
            color: '#8AF2FF',
            align: 'left'
        });
    }

    const matchDate = [match || 'MATCH DAY', date].filter(Boolean);
    if (matchDate.length) {
        const centerX = 0.61 * BASE_WIDTH;
        const boxWidth = 0.31 * BASE_WIDTH;
        const boxHeight = 0.043 * BASE_HEIGHT;
        const boxX = centerX - boxWidth / 2;
        const boxY = 0.55 * BASE_HEIGHT;
        drawRoundedPanel(ctx, {
            x: boxX,
            y: boxY,
            width: boxWidth,
            height: boxHeight,
            radius: 18,
            fill: 'rgba(3, 18, 50, 0.52)',
            stroke: 'rgba(92, 229, 255, 0.52)',
            strokeWidth: 1
        });

        if (match && date) {
            drawFittedText(ctx, match, {
                x: boxX + boxWidth * 0.25,
                y: boxY + boxHeight * 0.67,
                width: boxWidth * 0.43,
                size: 15,
                minSize: 10,
                family: 'Inter SemiBold',
                color: '#F4FBFF',
                align: 'center'
            });
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(centerX, boxY + 10);
            ctx.lineTo(centerX, boxY + boxHeight - 10);
            ctx.strokeStyle = 'rgba(92, 229, 255, 0.8)';
            ctx.lineWidth = 1.25;
            ctx.stroke();
            ctx.restore();
            drawFittedText(ctx, date, {
                x: boxX + boxWidth * 0.75,
                y: boxY + boxHeight * 0.67,
                width: boxWidth * 0.43,
                size: 15,
                minSize: 10,
                family: 'Inter SemiBold',
                color: '#8AF2FF',
                align: 'center'
            });
        } else {
            drawFittedText(ctx, matchDate[0], {
                x: centerX,
                y: boxY + boxHeight * 0.67,
                width: boxWidth * 0.9,
                size: 15,
                minSize: 10,
                family: 'Inter SemiBold',
                color: '#F4FBFF',
                align: 'center'
            });
        }
    }

    drawRoundedPanel(ctx, {
        x: 0.205 * BASE_WIDTH,
        y: 0.684 * BASE_HEIGHT,
        width: 0.59 * BASE_WIDTH,
        height: 0.104 * BASE_HEIGHT,
        radius: 18,
        fill: 'rgba(3, 16, 48, 0.5)',
        stroke: 'rgba(92, 229, 255, 0.62)',
        strokeWidth: 1.25
    });
    drawFittedText(ctx, 'MATCH-DAY PERFORMANCE', {
        x: BASE_WIDTH / 2,
        y: 0.714 * BASE_HEIGHT,
        width: 0.52 * BASE_WIDTH,
        size: 15,
        minSize: 10,
        family: 'Inter SemiBold',
        color: '#8AF2FF',
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