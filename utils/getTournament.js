const {
    TournamentSettings,
    ServerConfig
} = require('../models/Tournament');

/**
 * getTournament.js
 *
 * Single source of truth for "which tournament is this command about?".
 *
 * RULES
 *  1. An explicit key always wins  (`.cmd <key>` / `tournament:<key>`).
 *  2. Otherwise the server's DEFAULT tournament (ServerConfig.defaultTournamentKey)
 *     is used — even if that tournament is completed. A configured default is
 *     never silently swapped for some other tournament.
 *  3. Only when no default is configured (or the configured one no longer
 *     exists, e.g. it was deleted) do we fall back to the newest tournament
 *     and re-point the server default at it so everything stays consistent.
 */

async function getTournamentByKey(guildId, key, options = {}) {
    if (!guildId || !key) return null;

    const query = {
        guildId,
        tournamentKey: String(key).toLowerCase()
    };

    if (!options.includeCompleted) {
        query.currentPhase = { $ne: 'completed' };
    }

    return TournamentSettings.findOne(query);
}

/** The configured default key for a guild ('' when none). */
async function getDefaultTournamentKey(guildId) {
    if (!guildId) return '';
    const config = await ServerConfig.findOne({ guildId }).lean().catch(() => null);
    return String(config?.defaultTournamentKey || '').toLowerCase();
}

async function setDefaultTournamentKey(guildId, key) {
    if (!guildId) return;
    await ServerConfig.findOneAndUpdate(
        { guildId },
        { $set: { guildId, defaultTournamentKey: String(key || '').toLowerCase() } },
        { upsert: true }
    );
}

async function getDefaultTournament(guildId, options = {}) {
    if (!guildId) return null;

    const configuredKey = await getDefaultTournamentKey(guildId);

    // 1. The configured default ALWAYS wins (completed or not).
    if (configuredKey) {
        const configured = await TournamentSettings.findOne({
            guildId,
            tournamentKey: configuredKey
        });

        if (configured) return configured;
    }

    // 2. No (valid) default configured → newest tournament.
    const query = { guildId };

    if (!options.includeCompleted) {
        query.currentPhase = { $ne: 'completed' };
    }

    const fallback = await TournamentSettings.findOne(query).sort({ createdAt: -1 });

    // Only completed tournaments exist and the caller wanted active ones:
    // nothing sensible to return.
    if (!fallback) return null;

    // Heal a missing/dangling default (tournament was deleted / never set) so
    // every command keeps agreeing on the same tournament from now on.
    await setDefaultTournamentKey(guildId, fallback.tournamentKey).catch(() => null);

    return fallback;
}

async function getSelectableTournaments(guildId, options = {}) {
    if (!guildId) return [];

    const query = { guildId };

    if (!options.includeCompleted) {
        // Completed tournaments are hidden from dropdowns EXCEPT the default
        // one, which must always be selectable.
        const defaultKey = await getDefaultTournamentKey(guildId);
        query.$or = [
            { currentPhase: { $ne: 'completed' } },
            ...(defaultKey ? [{ tournamentKey: defaultKey }] : [])
        ];
    }

    const list = await TournamentSettings.find(query)
        .sort({
            currentPhase: 1,
            createdAt: -1
        })
        .lean();

    // Default tournament first so dropdowns open on it.
    const defaultKey = await getDefaultTournamentKey(guildId);
    if (defaultKey) {
        list.sort((a, b) =>
            (b.tournamentKey === defaultKey ? 1 : 0) - (a.tournamentKey === defaultKey ? 1 : 0)
        );
    }

    return list;
}

async function getActiveTournaments(guildId) {
    return getSelectableTournaments(guildId, {
        includeCompleted: false
    });
}

async function getAllTournaments(guildId) {
    return getSelectableTournaments(guildId, {
        includeCompleted: true
    });
}

/**
 * Resolve the tournament a command should run against.
 *   explicit key  → that tournament
 *   no key        → the server default
 *
 * Returns { tournament, explicit, error }.
 * `error` is a ready-to-send user message when nothing could be resolved.
 */
async function resolveTournament(guildId, key = null, options = {}) {
    const includeCompleted = options.includeCompleted !== false;

    if (key) {
        const tournament = await getTournamentByKey(guildId, key, { includeCompleted });

        if (!tournament) {
            return {
                tournament: null,
                explicit: true,
                error: `❌ Tournament \`${String(key).toLowerCase()}\` not found.`
            };
        }

        return { tournament, explicit: true, error: null };
    }

    const tournament = await getDefaultTournament(guildId, { includeCompleted });

    if (!tournament) {
        return {
            tournament: null,
            explicit: false,
            error:
                '❌ No default tournament is set for this server.\n' +
                'Set one with `.setdefaulttournament <key>` (see `.listtournaments`).'
        };
    }

    return { tournament, explicit: false, error: null };
}

/**
 * Prefix helper: pull an optional tournament key out of the args.
 *
 * Accepted forms (first match wins):
 *   tournament=<key> | key=<key> | t=<key>   (anywhere in args)
 *   <key> as the FIRST arg, if it is an existing tournament key
 *     (skipped when options.tokenOnly = true)
 *
 * Anything else → default tournament, args untouched.
 *
 * Returns { tournament, explicit, rest, error }.
 */
async function extractTournamentFromArgs(guildId, args = [], options = {}) {
    const rest = [...args];

    const tokenIdx = rest.findIndex(a =>
        typeof a === 'string' && /^(tournament|key|t)=/i.test(a)
    );

    if (tokenIdx !== -1) {
        const raw = rest[tokenIdx].split('=').slice(1).join('=').trim().toLowerCase();
        rest.splice(tokenIdx, 1);
        const resolved = await resolveTournament(guildId, raw, options);
        return { ...resolved, rest };
    }

    const first = rest[0]?.toLowerCase();

    // tokenOnly: free-text commands (nick, messages…) where a loose first word
    // must never be mistaken for a tournament key.
    if (first && !options.tokenOnly) {
        const byKey = await getTournamentByKey(guildId, first, {
            includeCompleted: options.includeCompleted !== false
        });

        if (byKey) {
            rest.shift();
            return { tournament: byKey, explicit: true, rest, error: null };
        }
    }

    const resolved = await resolveTournament(guildId, null, options);
    return { ...resolved, rest };
}

module.exports = {
    getTournamentByKey,
    getDefaultTournament,
    getDefaultTournamentKey,
    setDefaultTournamentKey,
    getSelectableTournaments,
    getActiveTournaments,
    getAllTournaments,
    resolveTournament,
    extractTournamentFromArgs
};
