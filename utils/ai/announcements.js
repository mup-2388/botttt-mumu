/**
 * utils/ai/announcements.js
 *
 * Writes the kickoff announcement. The AI writes ONLY the prose — the role
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
const { discordFull, discordRelative } = require('../istTime');
const { emojiHint } = require('./emojiCatalog');

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
    '{home} vs {away} — {time}. Two teams, one ball, a lot of shouting. Let’s see who embarrasses themselves less. 🏟️',
    'It’s happening: {home} take on {away} at {time}. {venue}Better clear your schedule, this one matters. ⚽',
    'Kickoff: {home} vs {away}, {time}. Bring your best excuse-making game. 🧠',
    'Matchday. {home} vs {away} at {time}. Someone is leaving with three points, someone with regrets. 💀',
    '{home} 🆚 {away} — {time}. The table is watching, the group chat is awake. Let’s play. 🔥',
    'Ladies and gentlemen (and referees): {home} vs {away}, {time}, live from {venue}not your couch. 📺'
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

function templateAnnouncement({ homeTeam, awayTeam, scheduledAt, venueName }) {
    const text = pick(TEMPLATES)
        .replace(/{home}/g, homeTeam)
        .replace(/{away}/g, awayTeam)
        .replace(/{time}/g, `${discordFull(scheduledAt)} ({discordRelative(scheduledAt)})`.replace('{discordRelative(scheduledAt)}', discordRelative(scheduledAt)))
        .replace(/{venue}/g, venueName ? `${venueName}. ` : '');

    return text;
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

    const systemPrompt =
        `You are MUMU, the host of a Discord football league. You write the kickoff announcement for one match.\n\n` +
        `STYLE: ${tone}. Angle to take: ${angle}. Roast level: light-medium — tease the teams, never the people's real lives.\n` +
        `LENGTH: 2-4 sentences, max 400 characters. Discord markdown allowed (**bold**, *italic*).\n` +
        `You may use 1-3 custom emojis from this list only: ${emojiHint(`${homeTeam} ${awayTeam} match`, guildId, 12) || '(none available)'}\n\n` +
        `HARD RULES:\n` +
        `- NEVER write @everyone, @here, any <@&role> or <@user> mention — the system adds the team pings itself.\n` +
        `- Never invent scores, stats or names: use only the facts provided.\n` +
        `- No hashtags, no "as an AI", no bullet lists, no headings.\n` +
        `- Write like a human running a league, not like a press release.\n` +
        `- The match time and teams are already shown above your text, so do not re-list them robotically.`;

    const userPrompt =
        `Match: ${homeTeam} (home) vs ${awayTeam} (away)\n` +
        `Kickoff: ${discordFull(scheduledAt)} — ${discordRelative(scheduledAt)}\n` +
        `Venue: ${venueName || 'home ground'}\n` +
        `Tournament: ${tournament?.name || 'the league'} (${tournament?.phase || 'league'} phase)\n` +
        `Match number: ${fixture?.matchNumber ?? '?'}\n` +
        (facts ? `FACTS: ${JSON.stringify(facts).slice(0, 1200)}\n` : '') +
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
        body = templateAnnouncement({ homeTeam, awayTeam, scheduledAt, venueName });
        body = body.replace(/<@&\d+>/g, '');
    }

    pushHistory(body.split('\n')[0].slice(0, 120));

    return body;
}

/* ── Other generated content ── */

/** Daily digest prose. */
async function buildDigestProse({ guildId, tournamentName, facts }) {
    const systemPrompt =
        `You are MUMU, writing the daily league digest for a Discord football league.\n` +
        `Tone: funny, a bit roast-y, 3-5 short lines. Discord markdown allowed, 1-3 custom emojis max from: ` +
        `${emojiHint('football league digest goals', guildId, 10) || '(none)'}\n` +
        `Never invent numbers — use only the facts. Never write @everyone/@here or role/user mentions.`;

    const res = await callAI({
        messages: [{ role: 'user', content: `Tournament: ${tournamentName}\nFacts: ${JSON.stringify(facts).slice(0, 2000)}` }],
        systemPrompt,
        temperature: 0.9,
        maxTokens: 400
    });

    return res?.text ? String(res.text).trim().slice(0, 1200) : null;
}

/** Scouting report prose. */
async function buildScoutProse({ guildId, teamName, facts }) {
    const systemPrompt =
        `You are MUMU, writing a scouting report on a team for their next opponent in a Discord league.\n` +
        `Structure: how they play, their danger man, their weakness, one-line plan to beat them. ` +
        `4-6 short lines, markdown allowed, 1-3 custom emojis from: ${emojiHint(`${teamName} football`, guildId, 10) || '(none)'}\n` +
        `Use ONLY the facts provided. Never invent numbers. No mentions of any kind.`;

    const res = await callAI({
        messages: [{ role: 'user', content: `Team: ${teamName}\nFacts: ${JSON.stringify(facts).slice(0, 2000)}` }],
        systemPrompt,
        temperature: 0.8,
        maxTokens: 500
    });

    return res?.text ? String(res.text).trim().slice(0, 1500) : null;
}

module.exports = {
    buildMatchAnnouncement,
    buildDigestProse,
    buildScoutProse,
    templateAnnouncement,
    readHistory
};
