/**
 * utils/reservedMatches.js
 *
 * A match the organizers could not play on its matchday is held as RESERVED.
 * It remains a Pending fixture, is marked in fixture lists, and can be played
 * and reported whenever the organizers get to it. An optional new kickoff is
 * stored; with no date, the old missed kickoff is cleared (but retained in
 * `reserved.from` for reference).
 */

const { Fixture } = require('../models/Tournament');
const { cancelPlan } = require('./matchScheduler');
const { sanitizeAIText } = require('./aiGuard');

function isReserved(fixture) {
    return !!fixture?.reserved?.isReserved;
}

/** Short marker for fixture lists. */
function reservedBadge(fixture, { withTime = true, guildId = null } = {}) {
    if (!isReserved(fixture)) return '';

    const { slotEmoji } = require('./ai/emojiSlots');
    const icon = slotEmoji('reserve', guildId);
    const until = fixture.reserved?.until;
    const when = until && withTime
        ? ` — for ${require('./istTime').discordFull(until)}`
        : '';

    return `${icon} Reserved${when}`;
}

/**
 * Mark an unplayed fixture reserved (pending/live/cancelled).
 *
 * `until` is optional. Repeating the command without a new time preserves an
 * already-selected reserved date; on the first reservation it clears the old
 * (missed) scheduledAt. A live fixture returns to Pending.
 */
async function markReserved({ client = null, guild = null, fixture, until = null, note = null, actorId = null }) {
    if (!fixture?._id) return { ok: false, error: 'fixture not found' };

    const alreadyReserved = isReserved(fixture);
    const previousKickoff = alreadyReserved
        ? (fixture.reserved?.from || null)
        : (fixture.scheduledAt || null);
    const effectiveUntil = until || (alreadyReserved ? fixture.reserved?.until || null : null);
    const effectiveNote = note
        ? sanitizeAIText(String(note).trim(), { maxUserPings: 0 }).text.slice(0, 200)
        : (alreadyReserved ? fixture.reserved?.note || null : null);
    const now = new Date();

    const updated = await Fixture.findOneAndUpdate(
        {
            _id: fixture._id,
            status: { $in: ['Pending', 'Live', 'Cancelled'] }
        },
        {
            $set: {
                status: 'Pending',
                scheduledAt: effectiveUntil,
                reserved: {
                    isReserved: true,
                    at: now,
                    by: actorId || fixture.reserved?.by || null,
                    from: previousKickoff,
                    until: effectiveUntil,
                    note: effectiveNote
                }
            }
        },
        { new: true }
    ).catch(error => {
        console.error('[reservedMatches] reservation save failed:', error?.message || error);
        return null;
    });

    if (!updated) {
        return { ok: false, error: 'This fixture is no longer pending/live; refresh the report menu and try again.' };
    }

    const plan = updated.channelPlan || {};
    const hadActivePlan = !!plan.channelId && ['pending', 'locked', 'announced', 'cancelled'].includes(plan.state);
    let unlocked = false;
    let unlockError = null;

    if (hadActivePlan && guild) {
        const result = await cancelPlan({ guild, fixture: updated }).catch(error => ({
            ok: false,
            error: error?.message || 'Could not unlock the scheduled channel.'
        }));

        unlocked = !!result?.ok;
        unlockError = result?.ok ? null : (result?.error || 'Could not unlock the scheduled channel yet.');
    }

    return {
        ok: true,
        fixture: updated,
        previousKickoff,
        until: effectiveUntil,
        releasedChannel: unlocked,
        unlockError,
        alreadyReserved
    };
}

/** Undo only the reserved flag; leave the selected kickoff intact. */
async function clearReserved({ fixture }) {
    if (!fixture?._id) return { ok: false, error: 'fixture not found' };

    const wasReserved = isReserved(fixture);
    if (!wasReserved) return { ok: true, wasReserved: false };

    const updated = await Fixture.findOneAndUpdate(
        { _id: fixture._id, 'reserved.isReserved': true },
        {
            $set: {
                'reserved.isReserved': false,
                'reserved.until': null,
                'reserved.note': null
            }
        },
        { new: true }
    ).catch(error => {
        console.error('[reservedMatches] clearing reservation failed:', error?.message || error);
        return null;
    });

    if (!updated) return { ok: false, error: 'The reservation changed before it could be cleared; refresh and try again.' };

    return { ok: true, wasReserved: true, fixture: updated };
}

module.exports = {
    isReserved,
    reservedBadge,
    markReserved,
    clearReserved
};
