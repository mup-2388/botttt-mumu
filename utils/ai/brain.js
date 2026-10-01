/**
 * utils/ai/brain.js
 *
 * "Knows everything about the tournaments."
 *
 * An LLM cannot read the database, so the brain does it for it:
 *   1. ROUTER  — plain keywords resolve most questions to tools instantly.
 *   2. PLANNER — anything else gets one cheap LLM call that returns JSON
 *                { calls: [{ tool, args }] }, executed server-side.
 *   3. FACTS   — tool results are packed into a FACT BLOCK which is injected
 *                into the prompt; the model may only use numbers from there.
 *
 * Entry point:
 *   gatherFacts({ question, guildId, userId, tournamentKey }) → { factBlock, tools } | null
 */

const { runTool, TOOL_LIST, findTeam, findPlayer } = require('./tournamentTools');
const { callAI } = require('../aiProviders');

/* ── Small caches (protect the DB and the providers) ── */

const CACHE_TTL = 30_000;
const cache = new Map();          // key -> { at, value }
const teamCache = new Map();      // guildId -> { at, teams }

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL) { cache.delete(key); return null; }
    return hit.value;
}

function cacheSet(key, value) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
}

async function guildTeams(guildId) {
    const hit = teamCache.get(guildId);
    if (hit && Date.now() - hit.at < 60_000) return hit.teams;

    const { Team } = require('../../models/Tournament');
    const teams = await Team.find({ guildId }).select('name').lean().catch(() => []);
    teamCache.set(guildId, { at: Date.now(), teams });
    return teams;
}

/** Find a team name mentioned anywhere in the question (longest match wins). */
function extractTeamName(question, teams) {
    const q = ` ${String(question).toLowerCase()} `;
    let best = null;

    for (const t of teams) {
        const name = String(t.name || '').toLowerCase();
        if (name.length < 2) continue;
        if (q.includes(name) && (!best || name.length > best.length)) best = t.name;
    }

    return best;
}

/* ── Router ── */

const METRIC_WORDS = [
    ['goals', /golden boot|top ?scorer|most goals|goal ?scorer|scorer race|leading scorer|score the most/i],
    ['assists', /assist/i],
    ['saves', /\bsaves?\b|best keeper|goalkeeper|clean sheet/i],
    ['tackles', /tackle/i],
    ['interceptions', /interception|intercept/i],
    ['mvps', /\bmvp|man of the match|motm/i]
];

function metricFromQuestion(question) {
    for (const [metric, re] of METRIC_WORDS) {
        if (re.test(question)) return metric;
    }
    return null;
}

/**
 * Keyword router. Returns a list of tool calls, possibly empty.
 */
async function route(question, ctx, teams) {
    const q = String(question);
    const lower = q.toLowerCase();
    const calls = [];

    const teamName = extractTeamName(q, teams);
    const metric = metricFromQuestion(q);

    /* Reserved/postponed fixtures are normal pending fixtures with an explicit
       flag; fetch enough facts for the model to distinguish them from scheduled. */
    if (/\b(reserv(ed|ation)|postpon(ed|ponement)|held over)\b/i.test(lower)) {
        const number = lower.match(/\b(?:match\s*)?#?(\d{1,4})\b/);

        if (number) calls.push({ tool: 'fixture_info', args: { matchNumber: Number(number[1]) } });
        else if (teamName) calls.push({ tool: 'team_schedule', args: { team: teamName } });
        else calls.push({ tool: 'upcoming_fixtures', args: { limit: 20 } });
    }

    /* Who am I / my stuff */
    if (/\b(my|me|i|our|we|us)\b/i.test(lower) && /(stat|goals?|assists?|saves?|tackles?|interceptions?|mvps?|points?|record)/i.test(lower)) {
        calls.push({ tool: 'my_stats', args: { metric: metric || 'goals' } });
    }

    if (/next (match|game|fixture)|who do .* play|when do .* play|play( next| next up)?\b.*\bnext\b|next up|upcoming (match|game|fixture)/i.test(lower)) {
        calls.push(teamName ? { tool: 'team_next_match', args: { team: teamName } } : { tool: 'my_next_match', args: {} });
    }

    if (/(our|my|the) (position|place|rank|standing)|where (are|do) (we|i)|league table|the table|standings|points table/i.test(lower)) {
        calls.push(teamName ? { tool: 'team_position', args: { team: teamName } } : { tool: 'my_team', args: {} });
    }

    if (/(qualify|qualification|go through|make it through|knockout (spot|place))/i.test(lower)) {
        calls.push({ tool: 'qualification_gap', args: { team: teamName || null } });
    }

    if (/(golden boot|top ?scorer|scorer race|assist race|most (goals|assists|saves|tackles|interceptions|mvps)|leading (scorer|assister)|who leads|leader(board)?)/i.test(lower)) {
        calls.push({ tool: 'leaders', args: { metric: metric || 'goals', limit: 5 } });
    }

    if (/(how many (more )?(goals|assists|saves|tackles|interceptions|mvps)|gap to (the )?(lead|top)|catch (up|the leader)|behind the leader)/i.test(lower)) {
        calls.push({ tool: 'gap_to_lead', args: { metric: metric || 'goals' } });
    }

    if (/(my|our) rank|where am i|my position/i.test(lower)) {
        calls.push({ tool: 'player_rank', args: { metric: metric || 'goals' } });
    }

    if (teamName && /(best player|top player|best performer|star player|danger ?man|top scorer|key player)/i.test(lower)) {
        calls.push({ tool: 'team_top_performer', args: { team: teamName, metric: metric || 'goals' } });
    }

    if (teamName && /(captain|who leads|skipper)/i.test(lower)) {
        calls.push({ tool: 'captain_of', args: { team: teamName } });
    }

    if (teamName && /(form|last (five|5|few)|recent results?|how (have|has) .* been)/i.test(lower)) {
        calls.push({ tool: 'team_form', args: { team: teamName, lastN: 5 } });
    }

    if (teamName && /(squad|roster|line ?up|players|who plays for|who'?s on)/i.test(lower)) {
        calls.push({ tool: 'squad', args: { team: teamName } });
    }

    if (teamName && /(team ?report|treport|opposition|how (do|can) we beat|weakness|strength|preview|analyse|analyze)/i.test(lower)) {
        calls.push({ tool: 'team_report', args: { team: teamName } });
    }

    if (teamName && /(schedule|fixtures?|when (do|does) .* play|next games?)/i.test(lower)) {
        calls.push({ tool: 'team_schedule', args: { team: teamName } });
    }

    if (/(head ?to ?head|h2h|\bvs\b|against)/i.test(lower) && teamName) {
        calls.push({ tool: 'head_to_head', args: { teamA: teamName, teamB: null } });
    }

    if (/(recent results|latest results|last (night|night'?s|round|matchday)|results)/i.test(lower) && !teamName) {
        calls.push({ tool: 'recent_results', args: { limit: 5 } });
    }

    if (/(upcoming|next fixtures|what'?s next|fixtures left)/i.test(lower) && !teamName) {
        calls.push({ tool: 'upcoming_fixtures', args: { limit: 5 } });
    }

    if (/free agent/i.test(lower)) {
        calls.push({ tool: 'free_agents', args: {} });
    }

    if (/troph(y|ies)|award/i.test(lower)) {
        calls.push({ tool: 'trophies_of', args: {} });
    }

    if (/(fixture|match|game) ?#?(\d+)/i.test(lower)) {
        const m = lower.match(/(?:fixture|match|game) ?#?(\d+)/i);
        if (m) calls.push({ tool: 'fixture_info', args: { matchNumber: Number(m[1]) } });
    }

    if (/(tournament|league|competition)s?\b/i.test(lower) && /(which|list|all|how many|info|about)/i.test(lower)) {
        calls.push({ tool: 'list_tournaments', args: {} });
    }

    return dedupe(calls).slice(0, 3);
}

function dedupe(calls) {
    const seen = new Set();
    return calls.filter(c => {
        const key = `${c.tool}:${JSON.stringify(c.args)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/* ── Planner (LLM decides which tools to call) ── */

async function plan(question, ctx, teams) {
    const tools = TOOL_LIST.map(t => `- ${t.name}(${Object.keys(t.args).join(', ')}): ${t.description}`).join('\n');
    const teamNames = teams.map(t => t.name).slice(0, 40).join(', ');

    const prompt =
        `You pick database queries for a Discord football-bot.\n` +
        `Available tools:\n${tools}\n\n` +
        `Teams in this server: ${teamNames || '(none)'}\n` +
        `The asking user ${ctx.userId ? `(discord id ${ctx.userId})` : ''} may be referred to as "I", "me", "my team", "we", "us".\n\n` +
        `User question: """${String(question).slice(0, 400)}"""\n\n` +
        `Reply with ONLY JSON: {"calls":[{"tool":"name","args":{...}}]} — at most 3 calls.\n` +
        `Use an empty array when no tool is needed.`;

    const raw = await callAI({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: 'You output only valid JSON. No markdown, no comments.',
        jsonMode: true,
        temperature: 0.1,
        maxTokens: 300
    });

    if (!raw?.text) return [];

    try {
        const parsed = JSON.parse(raw.text.replace(/```json|```/g, '').trim());
        const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
        return dedupe(calls.filter(c => c && typeof c.tool === 'string')).slice(0, 3);
    } catch {
        return [];
    }
}

/* ── Fact gathering ── */

const TOURNAMENT_TOPIC = /(goal|assist|save|tackle|interception|mvp|match|fixture|game|team|squad|player|tournament|league|table|standings|points|captain|scorer|keeper|qualif|knockout|group|form|result|fixture|next|opponent|rank|leader|trophy|award|free agent|season|round|bracket)/i;

async function gatherFacts({ question, guildId, userId, tournamentKey = null, force = false }) {
    if (!question || !guildId) return null;

    const ctx = { guildId, userId, tournamentKey };
    const teams = await guildTeams(guildId);

    let calls = await route(question, ctx, teams);

    if (!calls.length) {
        if (!TOURNAMENT_TOPIC.test(question)) return null;

        if (!force) {
            const cached = cacheGet(`plan:${guildId}:${question}`);
            if (cached) return cached;
        }

        calls = await plan(question, ctx, teams);

        if (!calls.length) return null;
    }

    /* Fill in "the team I am on" for team-based calls left blank */
    if (calls.some(c => c.tool === 'qualification_gap' && !c.args.team) || calls.some(c => c.tool === 'head_to_head' && !c.args.teamB)) {
        const mine = await runTool('my_team', {}, ctx);

        if (mine?.team) {
            for (const c of calls) {
                if (c.tool === 'qualification_gap' && !c.args.team) c.args.team = mine.team;
                if (c.tool === 'team_position' && !c.args.team) c.args.team = mine.team;
                if (c.tool === 'head_to_head') {
                    if (!c.args.teamA) c.args.teamA = mine.team;
                    if (!c.args.teamB && c.args.teamA && c.args.teamA.toLowerCase() !== mine.team.toLowerCase()) c.args.teamB = mine.team;
                    else if (!c.args.teamB) c.args.teamB = null;
                }
            }
        }
    }

    const results = [];

    for (const call of calls) {
        const args = { ...(call.args || {}) };

        /* A player-name argument that is actually the asker */
        if (typeof args.player === 'string' && /^(me|myself|i)$/i.test(args.player.trim())) delete args.player;

        const result = await runTool(call.tool, args, ctx);
        results.push({ tool: call.tool, args, result });
    }

    const usable = results.filter(r => r.result && !r.result.error);

    if (!usable.length) {
        const failed = results.map(r => `${r.tool}: ${r.result?.error || 'no data'}`).join('; ');
        return {
            factBlock: `NO DATABASE DATA AVAILABLE for this question (${failed}). Tell the user you don't have that data — do NOT invent numbers.`,
            tools: results.map(r => r.tool)
        };
    }

    const factBlock =
        `LIVE TOURNAMENT FACTS (read from the database, just now — these are the ONLY numbers you may use):\n` +
        usable.map(r => `${r.tool} → ${JSON.stringify(r.result)}`).join('\n');

    const payload = {
        factBlock,
        tools: results.map(r => r.tool),
        hasData: true
    };

    cacheSet(`facts:${guildId}:${tournamentKey || 'default'}:${question}`, payload);

    return payload;
}

module.exports = { gatherFacts, route, plan, extractTeamName, guildTeams };
