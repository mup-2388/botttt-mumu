/**
 * utils/ai/announcements.js
 *
 * Writes stage-specific match announcements. The AI writes ONLY the prose — the role
 * pings are prepended by the scheduler from code, so a bad generation can
 * never ping the wrong thing.
 *
 * Fresh every time: the prompt gets a random angle, a random tone and the
 * opening lines of the last 10 announcements as a "do not repeat" list.
 */

const fs = require('fs');
const path = require('path');

const { callAI } = require('../aiProviders');
const { runTool } = require('./tournamentTools');
const { formatIst, discordFull, discordRelative } = require('../istTime');
const { emojiHint } = require('./emojiCatalog');
const { slotHint, slotEmoji, vsLine } = require('./emojiSlots');

const HISTORY_FILE = path.join(__dirname, '..', '..', 'data', 'announcement-history.json');
const MAX_HISTORY = 12;

const ANGLES = [
    'the home side defending their ground',
    'the away side travelling with hope (and probably nothing else)',
    'one team needing a response after a bad result',
    'a straight shootout for the table',
    'a rivalry angle — they have history',
    'a "player to watch" angle using the top scorer of each side',
    'a bold prediction you instantly half-take-back',
    'the venue/stadium getting a mention',
    'the captains being the adults in the room (barely)',
    'one team being favourites and how that usually ends'
];

const TONES = [
    'hype commentator',
    'deadpan and sarcastic',
    'overly dramatic like a Champions League night',
    'friendly banter',
    'a slightly disappointed pundit who has seen too much',
    'confident prophecy'
];

const TEMPLATES = [
    '{match} — {time}. Two teams, one ball, a lot of shouting. Let’s see who embarrasses themselves less. 🏟️',
    'It’s happening: {match} at {time}. {venue}Better clear your schedule, this one matters. {goal}',
    'Kickoff: {match}, {time}. Bring your best excuse-making game. 🧠',
    'Matchday. {match} at {time}. Someone is leaving with three points, someone with regrets. {fire}',
    '{match} — {time}. The table is watching, the group chat is awake. Let’s play. {fire}',
    'Ladies and gentlemen (and referees): {match}, {time}, live from {venue}not your couch. 📺'
];

const SCHEDULE_TEMPLATES = [
    '{match} is locked in for {time}. Start sharpening the banter — the football can wait until kickoff. {fire}',
    'On the calendar: {match} at {time}. Both teams now have time to prepare their excuses properly. {goal}',
    '{match}, {time}. The fixture is set; no backing out when the group chat gets confident. 🏟️'
];

const REMINDER_TEMPLATES = [
    'One minute until {match} at {time}. Find your boots and save the excuses for full-time. {fire}',
    'Final minute, teams: {match} kicks off at {time}. Warm up quickly — the whistle is nearly here. {goal}',
    '{match}, one minute to go. Get ready to play; even your excuses need to be quick today. 🏟️'
];

function readHistory() {
    try {
        const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function pushHistory(entry) {
    try {
        const history = readHistory();
        history.unshift(String(entry).slice(0, 160));
        fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, MAX_HISTORY), null, 2));
    } catch {
        /* history is a nice-to-have; never break an announcement over it */
    }
}

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

/* ── Fact packing ──
 * The model must never receive a JSON blob chopped in half: a truncated object
 * confuses it and can make it invent the missing tail. Instead we shrink the
 * facts in stages (drop noise, then shorten arrays) until the WHOLE thing fits.
 */

const NOISE_KEYS = new Set(['discordId', 'discordID', 'date', 'phase', 'group', 'createdAt', 'updatedAt']);

function deNoise(value, depth = 0) {
    if (depth > 6) return null;

    if (Array.isArray(value)) {
        return value.map(v => deNoise(v, depth + 1)).filter(v => v !== null && v !== undefined);
    }

    if (value && typeof value === 'object') {
        const out = {};

        for (const [k, v] of Object.entries(value)) {
            if (NOISE_KEYS.has(k)) continue;

            const clean = deNoise(v, depth + 1);

            if (clean === null || clean === undefined) continue;
            if (typeof clean === 'string' && !clean.trim()) continue;
            if (Array.isArray(clean) && !clean.length) continue;
            if (typeof clean === 'object' && !Array.isArray(clean) && !Object.keys(clean).length) continue;

            out[k] = clean;
        }

        return out;
    }

    if (value === null || value === undefined) return null;
    return value;
}

function capArrays(value, max, skipKeys = new Set(), depth = 0) {
    if (depth > 6) return value;

    if (Array.isArray(value)) return value.slice(0, max).map(v => capArrays(v, max, skipKeys, depth + 1));

    if (value && typeof value === 'object') {
        const out = {};

        for (const [k, v] of Object.entries(value)) {
            if (skipKeys.has(k)) continue;
            out[k] = capArrays(v, max, skipKeys, depth + 1);
        }

        return out;
    }

    return value;
}

/** The league's VS emoji, as text the model can copy into its sentence. */
function slotEmojiText(guildId) {
    return slotEmoji('vs', guildId);
}

/** One natural sentence about emoji use — reads properly when the list is empty. */
function emojiRule(list, guildId) {
    const slotList = slotHint(guildId, ['goals', 'assists', 'saves', 'calendar', 'vs', 'fire']);
    const refs = [...new Set(`${list || ''} ${slotList}`.match(/<a?:[A-Za-z0-9_]+:\d+>/g) || [])];

    return refs.length
        ? `You may use custom emojis only from this list: ${refs.join(' ')}`
        : 'No custom emojis are available — use plain text and standard unicode emoji.';
}

/** Compact, always-valid JSON for a prompt, within `limit` characters. */
function compactFacts(facts, limit = 2000) {
    const base = deNoise(facts);

    const attempts = [
        base,
        capArrays(base, 5),
        capArrays(base, 2),
        capArrays(base, 1, new Set(['results', 'recentResults', 'upcoming', 'missed']))
    ];

    for (const attempt of attempts) {
        const json = JSON.stringify(attempt);
        if (json.length <= limit) return json;
    }

    return JSON.stringify(attempts[attempts.length - 1]).slice(0, limit);
}

function templateAnnouncement({ homeTeam, awayTeam, scheduledAt, venueName, guildId = null, announcementType = 'kickoff' }) {
    const templates = announcementType === 'scheduled'
        ? SCHEDULE_TEMPLATES
        : announcementType === 'reminder'
            ? REMINDER_TEMPLATES
            : TEMPLATES;

    return pick(templates)
        .replace(/{match}/g, vsLine(homeTeam, awayTeam, guildId))
        .replace(/{time}/g, `${formatIst(scheduledAt)} (${discordFull(scheduledAt)}, ${discordRelative(scheduledAt)})`)
        .replace(/{venue}/g, venueName ? `${venueName}. ` : '')
        .replace(/{goal}/g, slotEmoji('goals', guildId))
        .replace(/{fire}/g, slotEmoji('fire', guildId));
}

/**
 * Build the announcement body (no pings).
 * Always resolves — falls back to a rotating template if every provider fails.
 */
async function buildMatchAnnouncement({
    guildId,
    guildName = '',
    tournament,
    fixture,
    homeTeam,
    awayTeam,
    venueName = '',
    scheduledAt,
    announcementType = 'kickoff',
    extraFacts = null
}) {
    /* Accept fixture fields directly — no caller should ever print "undefined". */
    homeTeam = homeTeam || fixture?.homeTeam || 'Home';
    awayTeam = awayTeam || fixture?.awayTeam || 'Away';
    scheduledAt = scheduledAt || fixture?.scheduledAt || new Date();
    if (!venueName) venueName = fixture?.venueName || '';

    const ctx = { guildId, userId: null, tournamentKey: tournament?.tournamentKey || null };

    /* Facts (never invent numbers) */
    let facts = extraFacts;

    if (!facts) {
        try {
            const [homePos, awayPos, homeForm, awayForm, homeStar, awayStar, h2h] = await Promise.all([
                runTool('team_position', { team: homeTeam, tournament: tournament?.tournamentKey }, ctx),
                runTool('team_position', { team: awayTeam, tournament: tournament?.tournamentKey }, ctx),
                runTool('team_form', { team: homeTeam, lastN: 5, tournament: tournament?.tournamentKey }, ctx),
                runTool('team_form', { team: awayTeam, lastN: 5, tournament: tournament?.tournamentKey }, ctx),
                runTool('team_top_performer', { team: homeTeam, metric: 'goals', tournament: tournament?.tournamentKey }, ctx),
                runTool('team_top_performer', { team: awayTeam, metric: 'goals', tournament: tournament?.tournamentKey }, ctx),
                runTool('head_to_head', { teamA: homeTeam, teamB: awayTeam, tournament: tournament?.tournamentKey }, ctx)
            ]);

            facts = { homePos, awayPos, homeForm, awayForm, homeStar, awayStar, h2h };
        } catch {
            facts = null;
        }
    }

    const history = readHistory();
    const avoid = history.length
        ? `Do NOT reuse these previous opening words/lines:\n${history.slice(0, 6).map(h => `- "${h}"`).join('\n')}`
        : '';

    const angle = pick(ANGLES);
    const tone = pick(TONES);
    const stageInstruction = announcementType === 'scheduled'
        ? 'The organizer has just scheduled this match. Confirm the fixture and time, build anticipation, and make both teams feel called out in a friendly way.'
        : announcementType === 'reminder'
            ? 'This is the one-minute warning. Tell both teams to get ready now; do not imply the match is already underway.'
            : 'The scheduled kickoff time has arrived. Tell both teams to get started now; do not say kickoff is still in the future.';

    const systemPrompt =
        `You are MUMU, the host of a Discord football league. You write a match announcement for the requested stage.\n\n` +
        `STYLE: ${tone}. Angle to take: ${angle}. Roast level: light-medium — tease the teams, never the people's real lives.\n` +
        `ANNOUNCEMENT MOMENT: ${stageInstruction}\n` +
        `LENGTH: 2-4 sentences, max 400 characters. Discord markdown allowed (**bold**, *italic*).\n` +
        `${emojiRule(emojiHint(`${homeTeam} ${awayTeam} match`, guildId, 12), guildId)}\n` +
        `${slotHint(guildId, ['goals', 'assists', 'saves', 'calendar', 'vs', 'fire'])}\n\n` +
        `HARD RULES:\n` +
        `- NEVER write @everyone, @here, any <@&role> or <@user> mention — the system adds the team pings itself.\n` +
        `- Never invent scores, stats or names: use only the facts provided.\n` +
        `- No hashtags, no "as an AI", no bullet lists, no headings.\n` +
        `- Write like a human running a league, not like a press release.\n` +
        `- The match time and teams are already shown above your text, so do not re-list them robotically.`;

    const userPrompt =
        `Match: ${homeTeam} (home) ${slotEmojiText(guildId)} ${awayTeam} (away)\n` +
        `Kickoff: ${formatIst(scheduledAt)} — ${discordFull(scheduledAt)} (${discordRelative(scheduledAt)})\n` +
        `Venue: ${venueName || 'home ground'}\n` +
        `Tournament: ${tournament?.name || 'the league'} (${tournament?.phase || 'league'} phase)\n` +
        `Match number: ${fixture?.matchNumber ?? '?'}\n` +
        (facts ? `FACTS: ${compactFacts(facts, 1400)}\n` : '') +
        `${avoid}\n\n` +
        `Write the announcement body now.`;

    const res = await callAI({
        messages: [{ role: 'user', content: userPrompt }],
        systemPrompt,
        temperature: 0.95,
        maxTokens: 320
    });

    let body = res?.text ? String(res.text).trim() : '';

    /* Keep it clean: no mentions, no headings, sane length */
    body = body
        .replace(/<@&\d+>/g, '')
        .replace(/<@!?\d+>/g, '')
        .replace(/@(everyone|here)/gi, '@\u200B$1')
        .replace(/^#+\s*/gm, '')
        .replace(/^[-*]\s+/gm, '')
        .replace(/\n{2,}/g, '\n')
        .trim()
        .slice(0, 600);

    if (!body || body.length < 15) {
        body = templateAnnouncement({ homeTeam, awayTeam, scheduledAt, venueName, guildId, announcementType });
        body = body.replace(/<@&\d+>/g, '');
    }

    pushHistory(body.split('\n')[0].slice(0, 120));

    return body;
}

/* ── Other generated content ── */

/** Team report prose. */
async function buildTeamReportProse({ guildId, teamName, facts }) {
    const systemPrompt =
        `You are MUMU, writing a team report for the opponents of this team in a Discord league.\n` +
        `Structure: how they play, their danger man, their weakness, one-line plan to beat them. ` +
        `4-6 short lines, markdown allowed. ${emojiRule(emojiHint(`${teamName} football`, guildId, 10), guildId)}\n` +
        `${slotHint(guildId, ['goals', 'assists', 'saves', 'calendar', 'vs', 'fire'])}\n` +
        `Use ONLY the facts provided. Never invent numbers. No mentions of any kind.`;

    const res = await callAI({
        messages: [{ role: 'user', content: `Team: ${teamName}\nFacts: ${compactFacts(facts, 2600)}` }],
        systemPrompt,
        temperature: 0.8,
        maxTokens: 500
    });

    return res?.text ? String(res.text).trim().slice(0, 1500) : null;
}

module.exports = {
    buildMatchAnnouncement,
    buildTeamReportProse,
    templateAnnouncement,
    readHistory
};
