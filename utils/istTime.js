/**
 * utils/istTime.js
 *
 * Parses the way people actually type match times in this server:
 *   "9:30pm", "21:30", "today 9:30pm", "tomorrow 9 pm", "day after tomorrow 9",
 *   "25/10 21:00", "25-10-2026 21:00", "25 Oct 9:30pm", "in 2h", "in 90m", "now"
 *
 * Times are IST (UTC+05:30, no DST) unless the text says utc/gmt.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
    september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

/** The calendar parts of an instant, as seen in IST. */
function istParts(date = new Date()) {
    const shifted = new Date(date.getTime() + IST_OFFSET_MS);

    return {
        y: shifted.getUTCFullYear(),
        mo: shifted.getUTCMonth() + 1,
        d: shifted.getUTCDate(),
        h: shifted.getUTCHours(),
        mi: shifted.getUTCMinutes(),
        weekday: shifted.getUTCDay()
    };
}

/** IST wall-clock → real UTC Date. */
function istToUtc(y, mo, d, h = 0, mi = 0) {
    return new Date(Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS);
}

function addDays(parts, days) {
    const base = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d));
    base.setUTCDate(base.getUTCDate() + days);

    return {
        y: base.getUTCFullYear(),
        mo: base.getUTCMonth() + 1,
        d: base.getUTCDate()
    };
}

function parseTimeOfDay(text) {
    /* 9:30pm / 9.30 pm / 21:30 / 9 pm / 9pm / 2100? (no) */
    let m = text.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/i);
    if (m) {
        let h = Number(m[1]);
        const mi = Number(m[2]);
        const mer = (m[3] || '').toLowerCase();

        if (mer === 'pm' && h < 12) h += 12;
        if (mer === 'am' && h === 12) h = 0;
        if (h > 23 || mi > 59) return null;

        return { h, mi };
    }

    m = text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
    if (m) {
        let h = Number(m[1]);
        const mer = m[2].toLowerCase();

        if (mer === 'pm' && h < 12) h += 12;
        if (mer === 'am' && h === 12) h = 0;
        if (h > 23) return null;

        return { h, mi: 0 };
    }

    return null;
}

/**
 * Parse a human time string.
 * Returns { ok, date, label, ist, error }.
 */
function parseScheduleTime(input, { now = new Date() } = {}) {
    const text = String(input || '').toLowerCase().replace(/[’‘]/g, "'").trim();

    if (!text) return { ok: false, error: 'no time given' };

    const parts = istParts(now);

    /* explicit past days */
    if (/\b(yesterday|last night|last evening|yday)\b/.test(text)) {
        return { ok: false, error: 'that time is in the past' };
    }

    /* now / asap */
    if (/^(now|asap|right now)$/.test(text)) {
        return { ok: true, date: now, label: 'now', ist: formatIst(now) };
    }

    /* in 2h / in 90m / in 1 hour 30 minutes */
    const rel = text.match(/\bin\s+(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?/);
    if (rel && (rel[1] || rel[2])) {
        const hours = Number(rel[1] || 0);
        const mins = Number(rel[2] || 0);
        const date = new Date(now.getTime() + (hours * 60 + mins) * 60_000);

        return { ok: true, date, label: `in ${hours ? `${hours}h ` : ''}${mins ? `${mins}m` : ''}`.trim(), ist: formatIst(date) };
    }

    /* explicit utc/gmt escape hatch */
    const isUtc = /\b(utc|gmt|z)\b/.test(text);

    /* date part */
    let base = null;
    let dayOffsetWord = null;

    if (/\bday after tomorrow\b/.test(text)) { dayOffsetWord = 2; base = addDays(parts, 2); }
    else if (/\btomorrow\b|\btmr\b|\btmrw\b/.test(text)) { dayOffsetWord = 1; base = addDays(parts, 1); }
    else if (/\btoday\b|\btonight\b|\btonite\b/.test(text)) { dayOffsetWord = 0; base = addDays(parts, 0); }

    if (!base) {
        /* 25/10 , 25-10, 25.10 (optionally with a year) */
        let m = text.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/);
        if (m) {
            const d = Number(m[1]);
            const mo = Number(m[2]);
            let y = m[3] ? Number(m[3]) : parts.y;

            if (y < 100) y += 2000;
            if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) base = { y, mo, d };
        }

        /* 25 oct / oct 25 (optionally with a year) */
        if (!base) {
            m = text.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/);
            if (m && MONTHS[m[2]]) base = { y: parts.y, mo: MONTHS[m[2]], d: Number(m[1]) };

            if (!base) {
                m = text.match(/\b([a-z]{3,9})\s+(\d{1,2})\s*(?:st|nd|rd|th)?\b/);
                if (m && MONTHS[m[1]]) base = { y: parts.y, mo: MONTHS[m[1]], d: Number(m[2]) };
            }
        }
    }

    const tod = parseTimeOfDay(text);

    if (!base && !tod) {
        return { ok: false, error: 'could not understand that time — try "tomorrow 9:30pm" or "25/10 21:00"' };
    }

    if (!base) base = { y: parts.y, mo: parts.mo, d: parts.d };

    let date = isUtc && tod
        ? new Date(Date.UTC(base.y, base.mo - 1, base.d, tod.h, tod.mi))
        : istToUtc(base.y, base.mo, base.d, tod ? tod.h : 21, tod ? tod.mi : 0);

    /* "8pm" said at 9pm → they mean tomorrow (only when no explicit date) */
    if (!dayOffsetWord && !/\b(today|tonight)\b/.test(text) && date.getTime() < now.getTime() - 60_000) {
        if (!tod) return { ok: false, error: 'that time already passed today — did you mean tomorrow?' };

        const next = istToUtc(base.y, base.mo, base.d + 1, tod.h, tod.mi);
        date = next;
    }

    if (date.getTime() < now.getTime() - 5 * 60_000) {
        return { ok: false, error: 'that time is in the past' };
    }

    return {
        ok: true,
        date,
        label: formatIst(date),
        ist: formatIst(date),
        isUtc
    };
}

/** "Tue 25 Oct, 9:30 PM IST" */
function formatIst(date) {
    const p = istParts(date);
    const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    const mer = p.h >= 12 ? 'PM' : 'AM';
    const mm = String(p.mi).padStart(2, '0');
    const monthName = Object.keys(MONTHS).find(k => MONTHS[k] === p.mo && k.length > 3) || p.mo;

    return `${p.d} ${monthName}, ${h12}:${mm} ${mer} IST`;
}

/** Discord timestamp helpers */
function discordFull(date) {
    return `<t:${Math.floor(new Date(date).getTime() / 1000)}:F>`;
}

function discordRelative(date) {
    return `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;
}

module.exports = {
    parseScheduleTime,
    formatIst,
    istParts,
    istToUtc,
    discordFull,
    discordRelative,
    IST_OFFSET_MS
};
