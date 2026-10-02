/**
 * utils/matchScheduler.js
 *
 * Match-day flow, entirely backed by the database so a restart does not lose it:
 *
 *   .schedule 12 at 21:30 in #stadium-1
 *        → LOCK #stadium-1 now, then announce/ping both teams immediately
 *        → at 21:29: post the one-minute reminder (channel stays locked)
 *        → at 21:30: UNLOCK (restore the snapshot) and ping both teams again.
 *
 * Safety notes:
 *   • the pings come from code, never from the AI text (allowedMentions is an
 *     explicit allowlist of the two team roles)
 *   • every state change is an atomic findOneAndUpdate, so a slow tick can
 *     never double-lock or double-announce
 *   • if the bot was offline, the boot pass catches up sensibly
 */

const { PermissionsBitField, EmbedBuilder } = require('discord.js');
const { Fixture, Team, TournamentSettings, TournamentPlayer, Player } = require('../models/Tournament');
const { buildMatchAnnouncement } = require('./ai/announcements');
const { formatIst, discordFull, discordRelative } = require('./istTime');
const { sanitizeAIText } = require('./aiGuard');
const { slotEmoji, vsLine } = require('./ai/emojiSlots');

const TICK_MS = 20_000;
const DEFAULT_REMINDER_BEFORE_MINUTES = 1;
const ANNOUNCEMENT_RETRY_MS = 60_000;
const STALE_HOURS = 6;

let timer = null;
let running = false;

/* ── Channel helpers ── */

function snapshotOverwrite(channel, everyoneId) {
    const existing = channel.permissionOverwrites?.cache?.get(everyoneId);

    if (!existing) return null;

    return {
        allow: existing.allow?.bitfield?.toString?.() || '0',
        deny: existing.deny?.bitfield?.toString?.() || '0'
    };
}

async function applyLock({ client, guild, channelId, reason = 'Match day — channel reserved' }) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (!channel) return { ok: false, error: 'channel not found' };
    if (typeof channel.permissionOverwrites?.edit !== 'function') {
        return { ok: false, error: 'not a text channel I can lock' };
    }

    const everyone = guild.roles.everyone;
    const previousOverwrite = snapshotOverwrite(channel, everyone.id);

    await channel.permissionOverwrites.edit(
        everyone,
        { SendMessages: false, AddReactions: false },
        { reason }
    );

    /* The bot must still be able to post the announcement */
    const me = guild.members.me;
    if (me) {
        await channel.permissionOverwrites
            .edit(me, { SendMessages: true, ViewChannel: true }, { reason: 'Announcement permission' })
            .catch(() => null);
    }

    return { ok: true, previousOverwrite, channel };
}

async function applyUnlock({ client, guild, channelId, previousOverwrite = null, reason = 'Match day over — channel released' }) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (!channel) return { ok: false, error: 'channel not found' };

    const everyone = guild.roles.everyone;
    const flags = PermissionsBitField.Flags;

    let payload;

    if (previousOverwrite) {
        const allow = BigInt(previousOverwrite.allow || '0');
        const deny = BigInt(previousOverwrite.deny || '0');

        payload = {
            SendMessages: allow & flags.SendMessages ? true : deny & flags.SendMessages ? false : null,
            AddReactions: allow & flags.AddReactions ? true : deny & flags.AddReactions ? false : null
        };
    } else {
        payload = { SendMessages: null, AddReactions: null };
    }

    await channel.permissionOverwrites.edit(everyone, payload, { reason });

    /* Drop the explicit bot overwrite we added, if any */
    const me = guild.members.me;
    if (me) {
        await channel.permissionOverwrites.delete(me, 'Cleanup').catch(() => null);
    }

    return { ok: true, channel };
}

/* ── Ping building (code only — never the model) ── */

async function buildPings({ guild, homeTeam, awayTeam, pingCaptains = false }) {
    const roleIds = [];
    const userIds = [];
    const labels = [];

    for (const teamName of [homeTeam, awayTeam].filter(Boolean)) {
        const role = guild.roles.cache.find(
            r => r.name.toLowerCase() === String(teamName).toLowerCase()
        );

        if (role) {
            roleIds.push(role.id);
            labels.push(`<@&${role.id}>`);
            continue;
        }

        /* No team role → fall back to the captain so the ping still lands */
        const team = await Team.findOne({ guildId: guild.id, name: teamName }).lean().catch(() => null);
        const captainId = team?.captainID || null;

        if (captainId) {
            userIds.push(String(captainId));
            labels.push(`<@${captainId}>`);
        } else {
            labels.push(`**${teamName}**`);
        }
    }

    if (pingCaptains) {
        for (const teamName of [homeTeam, awayTeam].filter(Boolean)) {
            const team = await Team.findOne({ guildId: guild.id, name: teamName }).lean().catch(() => null);
            const entry = team
                ? await TournamentPlayer.findOne({ guildId: guild.id, teamId: team._id, isActive: true, isCaptain: true }).lean().catch(() => null)
                : null;
            const id = entry?.playerId
                ? (await Player.findOne({ guildId: guild.id, _id: entry.playerId }).lean().catch(() => null))?.discordID
                : team?.captainID;

            if (id && !userIds.includes(String(id))) userIds.push(String(id));
        }
    }

    return { roleIds: [...new Set(roleIds)], userIds: [...new Set(userIds)], labelLine: labels.join(' ') };
}

/* ── Announce ── */

async function announceMatch({ client, guild, fixture, stage = 'kickoff' }) {
    const plan = fixture.channelPlan || {};
    const channel = await guild.channels.fetch(plan.channelId).catch(() => null);

    if (!channel) return { ok: false, error: 'channel not found' };

    const tournament = fixture.tournamentId
        ? await TournamentSettings.findById(fixture.tournamentId).lean().catch(() => null)
        : null;

    const homeTeam = fixture.homeTeam;
    const awayTeam = fixture.awayTeam;

    const pings = await buildPings({
        guild,
        homeTeam,
        awayTeam,
        pingCaptains: !!plan.pingCaptains
    });

    const body = await buildMatchAnnouncement({
        guildId: guild.id,
        guildName: guild.name,
        tournament,
        fixture,
        homeTeam,
        awayTeam,
        venueName: fixture.venueName || '',
        scheduledAt: fixture.scheduledAt || new Date(),
        announcementType: stage
    });

    const calendar = slotEmoji('calendar', guild.id) || '⏰';
    const stageTitle = stage === 'scheduled'
        ? 'MATCH SCHEDULED'
        : stage === 'reminder'
            ? 'ONE-MINUTE MATCH REMINDER'
            : 'KICKOFF TIME';

    const header =
        `🏟️ **${stageTitle} · MATCH ${fixture.matchNumber || ''} · ${tournament?.name || 'MATCH DAY'}**\n` +
        `**${vsLine(homeTeam, awayTeam, guild.id)}**\n` +
        `${calendar} ${formatIst(fixture.scheduledAt)} · ${discordFull(fixture.scheduledAt)} (${discordRelative(fixture.scheduledAt)})` +
        (fixture.venueName ? `\n📍 ${fixture.venueName}` : '');

    /* Belt and braces: even a hostile body cannot introduce a ping. */
    const { text: safeBody } = sanitizeAIText(body, { maxUserPings: 0 });

    const content = `${pings.labelLine}\n\n${header}\n\n${safeBody}`.trim().slice(0, 1900);

    const allowedMentions = {
        parse: [],
        roles: pings.roleIds,
        users: pings.userIds
    };

    const sent = await channel.send({ content, allowedMentions }).catch(async error => {
        console.error('[matchScheduler] announcement send failed; trying safe fallback:', error?.message || error);

        const embed = new EmbedBuilder()
            .setColor(0xFEBE10)
            .setTitle(`🏟️ Match ${fixture.matchNumber || ''} — ${vsLine(homeTeam, awayTeam, guild.id)}`)
            .setDescription(`${header}\n\n${safeBody}`.slice(0, 4000))
            .setTimestamp();

        /* Keep the code-built team/captain pings in the fallback too. AI text is
           never allowed to create mentions, and allowedMentions is the same
           explicit team/captain allowlist as the primary send. */
        return channel.send({
            content: pings.labelLine || undefined,
            embeds: [embed],
            allowedMentions
        }).catch(fallbackError => {
            console.error('[matchScheduler] announcement fallback failed:', fallbackError?.message || fallbackError);
            return null;
        });
    });

    plan.announcementMessageId = sent?.id || null;

    if (!sent) return { ok: false, error: 'both announcement sends failed' };

    return { ok: true, messageId: sent.id };
}

/* ── Scheduling API (used by the .schedule command) ── */

async function sendScheduledAnnouncement({ client, guild, fixture }) {
    const now = new Date();
    const retryBefore = new Date(now.getTime() - ANNOUNCEMENT_RETRY_MS);

    const claim = await Fixture.findOneAndUpdate(
        {
            _id: fixture._id,
            'channelPlan.state': 'locked',
            'channelPlan.scheduledAnnouncementMessageId': null,
            'reserved.isReserved': { $ne: true },
            $or: [
                { 'channelPlan.scheduledAnnouncementClaimedAt': null },
                { 'channelPlan.scheduledAnnouncementClaimedAt': { $lte: retryBefore } }
            ]
        },
        { $set: { 'channelPlan.scheduledAnnouncementClaimedAt': now } },
        { new: true }
    ).catch(error => {
        console.error('[matchScheduler] schedule announcement claim failed:', error?.message || error);
        return null;
    });

    if (!claim) return { ok: false, skipped: true };

    const result = await announceMatch({ client, guild, fixture: claim, stage: 'scheduled' }).catch(error => ({
        ok: false,
        error: error?.message || 'schedule announcement failed'
    }));

    if (result.ok) {
        await Fixture.updateOne(
            { _id: fixture._id, 'channelPlan.state': 'locked' },
            {
                $set: {
                    'channelPlan.scheduledAnnouncedAt': new Date(),
                    'channelPlan.scheduledAnnouncementMessageId': result.messageId,
                    'channelPlan.lastError': null
                },
                $unset: { 'channelPlan.scheduledAnnouncementClaimedAt': 1 }
            }
        ).catch(error => console.error('[matchScheduler] could not save schedule announcement:', error?.message || error));
    } else {
        await Fixture.updateOne(
            { _id: fixture._id, 'channelPlan.state': 'locked' },
            { $set: { 'channelPlan.lastError': `schedule announcement: ${String(result.error || 'send failed').slice(0, 160)}` } }
        ).catch(() => null);
    }

    return result;
}

async function sendOneMinuteReminder({ client, guild, fixture, now = new Date() }) {
    const retryBefore = new Date(now.getTime() - ANNOUNCEMENT_RETRY_MS);

    const claim = await Fixture.findOneAndUpdate(
        {
            _id: fixture._id,
            'channelPlan.state': 'locked',
            'channelPlan.announceAt': { $lte: now },
            'channelPlan.reminderAnnouncedAt': null,
            'channelPlan.reminderMessageId': null,
            scheduledAt: { $gt: now },
            'reserved.isReserved': { $ne: true },
            $or: [
                { 'channelPlan.reminderClaimedAt': null },
                { 'channelPlan.reminderClaimedAt': { $lte: retryBefore } }
            ]
        },
        { $set: { 'channelPlan.reminderClaimedAt': now } },
        { new: true }
    ).catch(error => {
        console.error('[matchScheduler] reminder claim failed:', error?.message || error);
        return null;
    });

    if (!claim) return { ok: false, skipped: true };

    const result = await announceMatch({ client, guild, fixture: claim, stage: 'reminder' }).catch(error => ({
        ok: false,
        error: error?.message || 'reminder announcement failed'
    }));

    if (result.ok) {
        await Fixture.updateOne(
            { _id: fixture._id, 'channelPlan.state': 'locked' },
            {
                $set: {
                    'channelPlan.reminderAnnouncedAt': now,
                    'channelPlan.reminderMessageId': result.messageId,
                    'channelPlan.announcedAt': now,
                    'channelPlan.announcementMessageId': result.messageId,
                    'channelPlan.lastError': null
                },
                $unset: { 'channelPlan.reminderClaimedAt': 1 }
            }
        ).catch(error => console.error('[matchScheduler] could not save reminder:', error?.message || error));
    } else {
        await Fixture.updateOne(
            { _id: fixture._id, 'channelPlan.state': 'locked' },
            { $set: { 'channelPlan.lastError': `one-minute reminder: ${String(result.error || 'send failed').slice(0, 160)}` } }
        ).catch(() => null);
    }

    return result;
}

async function scheduleMatch({
    client,
    guild,
    fixture,
    channelId,
    reminderBeforeMinutes = DEFAULT_REMINDER_BEFORE_MINUTES,
    pingCaptains = false,
    actorId = null
}) {
    const now = new Date();
    const kickoff = fixture.scheduledAt ? new Date(fixture.scheduledAt) : null;

    if (fixture.status === 'Played') return { ok: false, error: 'this fixture has already been played' };
    if (!kickoff) return { ok: false, error: 'this fixture has no kickoff time — set one with `.editfixture`' };
    if (kickoff.getTime() - now.getTime() < 60_000) {
        return { ok: false, error: 'kickoff is less than a minute away — pick a later time' };
    }

    /* 1. Lock now */
    const lock = await applyLock({
        client,
        guild,
        channelId,
        reason: `Match ${fixture.matchNumber || ''} scheduled — reserved until kickoff`
    });

    if (!lock.ok) return { ok: false, error: lock.error };

    /* 2. Persist the plan */
    const announceAt = new Date(kickoff.getTime() - reminderBeforeMinutes * 60_000);

    try {
        const saved = await Fixture.updateOne(
            { _id: fixture._id },
            {
                $set: {
                    status: 'Pending',
                    scheduledAt: kickoff,
                    venueName: fixture.venueName || '',
                    venueType: fixture.venueType || 'home',
                    /* A reserved fixture is back on the active schedule now. */
                    'reserved.isReserved': false,
                    'reserved.until': null,
                    channelPlan: {
                        channelId,
                        state: 'locked',
                        lockAt: now,
                        announceAt,
                        lockedAt: now,
                        announcedAt: null,
                        scheduledAnnouncementClaimedAt: null,
                        scheduledAnnouncedAt: null,
                        scheduledAnnouncementMessageId: null,
                        reminderClaimedAt: null,
                        reminderAnnouncedAt: null,
                        reminderMessageId: null,
                        kickoffClaimedAt: null,
                        kickoffUnlockedAt: null,
                        kickoffAnnouncedAt: null,
                        kickoffMessageId: null,
                        lockedBy: actorId,
                        scheduledBy: actorId,
                        previousOverwrite: lock.previousOverwrite,
                        pingCaptains: !!pingCaptains,
                        announcementMessageId: null,
                        lastError: null
                    }
                }
            }
        );

        if (saved?.matchedCount === 0) throw new Error('fixture was removed before the plan could be saved');
    } catch (error) {
        const unlocked = await applyUnlock({
            guild,
            channelId,
            previousOverwrite: lock.previousOverwrite,
            reason: 'Schedule save failed — release channel'
        }).catch(() => ({ ok: false }));

        return {
            ok: false,
            error: unlocked?.ok
                ? `could not save the schedule; the channel was unlocked: ${String(error?.message || error).slice(0, 160)}`
                : `could not save the schedule and the channel could not be unlocked; please unlock it manually: ${String(error?.message || error).slice(0, 140)}`
        };
    }

    const scheduledAnnouncement = await sendScheduledAnnouncement({ client, guild, fixture });

    return {
        ok: true,
        lockAt: now,
        announceAt,
        scheduledAnnouncement,
        channel: lock.channel,
        previousOverwrite: lock.previousOverwrite
    };
}

async function cancelPlan({ guild, fixture, unlock = true }) {
    const plan = fixture.channelPlan || {};
    const channelId = plan.channelId || null;

    /* Cancel the DB plan first so it cannot be claimed and announced while we
       are calling Discord to restore channel permissions. Keep channelId until
       the unlock succeeds; the scheduler retries failed unlocks. */
    let cancelled;

    try {
        cancelled = await Fixture.updateOne(
            { _id: fixture._id },
            { $set: { 'channelPlan.state': 'cancelled', 'channelPlan.lastError': null } }
        );
    } catch (error) {
        return {
            ok: false,
            cancelled: false,
            unlocked: false,
            error: `could not cancel the saved plan: ${error?.message || 'database update failed'}`
        };
    }

    if (cancelled?.matchedCount === 0) {
        return { ok: false, cancelled: false, unlocked: false, error: 'fixture was not found while cancelling its plan' };
    }

    if (unlock && channelId) {
        const result = await applyUnlock({
            guild,
            channelId,
            previousOverwrite: plan.previousOverwrite,
            reason: 'Match plan cancelled'
        }).catch(error => ({ ok: false, error: error?.message || 'channel unlock failed' }));

        if (!result?.ok) {
            const message = String(result?.error || 'channel unlock failed').slice(0, 200);
            await Fixture.updateOne(
                { _id: fixture._id },
                { $set: { 'channelPlan.state': 'cancelled', 'channelPlan.lastError': message } }
            ).catch(() => null);

            return { ok: false, cancelled: true, unlocked: false, error: message };
        }
    }

    await Fixture.updateOne(
        { _id: fixture._id, 'channelPlan.state': 'cancelled' },
        { $set: { 'channelPlan.channelId': null, 'channelPlan.lastError': null } }
    ).catch(error => console.error('[matchScheduler] channel unlock saved; plan cleanup will retry:', error?.message || error));

    return { ok: true, cancelled: true, unlocked: !!(unlock && channelId) };
}

async function retryCancelledUnlocks(guild) {
    const pending = await Fixture.find({
        guildId: guild.id,
        'channelPlan.state': 'cancelled',
        'channelPlan.channelId': { $ne: null }
    }).limit(10).lean().catch(() => []);

    for (const fixture of pending) {
        const plan = fixture.channelPlan || {};
        const released = await applyUnlock({
            guild,
            channelId: plan.channelId,
            previousOverwrite: plan.previousOverwrite,
            reason: 'Retry cancelled match channel unlock'
        }).catch(error => ({ ok: false, error: error?.message || 'channel unlock failed' }));

        if (released?.ok) {
            await Fixture.updateOne(
                { _id: fixture._id, 'channelPlan.state': 'cancelled' },
                { $set: { 'channelPlan.channelId': null, 'channelPlan.lastError': null } }
            ).catch(() => null);
        } else {
            await Fixture.updateOne(
                { _id: fixture._id, 'channelPlan.state': 'cancelled' },
                { $set: { 'channelPlan.lastError': String(released?.error || 'channel unlock failed').slice(0, 200) } }
            ).catch(() => null);
        }
    }
}

async function listPlans(guildId, tournamentId = null) {
    const query = {
        guildId,
        'reserved.isReserved': { $ne: true },
        'channelPlan.channelId': { $ne: null },
        'channelPlan.state': { $in: ['locked', 'announced', 'cancelled'] }
    };

    if (tournamentId) query.tournamentId = tournamentId;

    return Fixture.find(query).sort({ scheduledAt: 1 }).lean();
}

/* ── The tick ── */

async function tick(client) {
    if (running) return;
    running = true;

    try {
        const now = new Date();

        for (const guild of client.guilds.cache.values()) {
            await retryCancelledUnlocks(guild);

            /* A reserved match must never fire its old announcement. If an
               immediate unlock failed, retry it on every tick until successful. */
            const reservedPlans = await Fixture.find({
                guildId: guild.id,
                'reserved.isReserved': true,
                'channelPlan.channelId': { $ne: null },
                'channelPlan.state': { $in: ['pending', 'locked', 'announced'] }
            }).limit(10).lean().catch(() => []);

            for (const fixture of reservedPlans) {
                const plan = fixture.channelPlan || {};
                const released = await applyUnlock({
                    guild,
                    channelId: plan.channelId,
                    previousOverwrite: plan.previousOverwrite,
                    reason: 'Reserved match — release stadium channel'
                }).catch(error => ({ ok: false, error: error?.message || 'channel unlock failed' }));

                if (released?.ok) {
                    await Fixture.updateOne(
                        { _id: fixture._id, 'reserved.isReserved': true },
                        { $set: { 'channelPlan.state': 'cancelled', 'channelPlan.channelId': null, 'channelPlan.lastError': null } }
                    ).catch(() => null);
                } else {
                    await Fixture.updateOne(
                        { _id: fixture._id, 'reserved.isReserved': true },
                        { $set: {
                            'channelPlan.state': 'cancelled',
                            'channelPlan.lastError': String(released?.error || 'channel unlock failed').slice(0, 200)
                        } }
                    ).catch(() => null);
                }
            }

            /* Retry any schedule-time notice that could not be posted immediately. */
            const missingScheduleNotices = await Fixture.find({
                guildId: guild.id,
                'reserved.isReserved': { $ne: true },
                'channelPlan.state': 'locked',
                'channelPlan.scheduledAnnouncementMessageId': null
            }).limit(10).lean().catch(() => []);

            for (const fixture of missingScheduleNotices) {
                await sendScheduledAnnouncement({ client, guild, fixture });
            }

            /* The channel remains locked during this one-minute heads-up. */
            const dueReminders = await Fixture.find({
                guildId: guild.id,
                'reserved.isReserved': { $ne: true },
                'channelPlan.state': 'locked',
                'channelPlan.announceAt': { $lte: now },
                'channelPlan.reminderAnnouncedAt': null,
                scheduledAt: { $gt: now },
                status: { $nin: ['Played', 'Cancelled'] }
            }).limit(10).lean().catch(() => []);

            for (const fixture of dueReminders) {
                await sendOneMinuteReminder({ client, guild, fixture, now });
            }

            /* At kickoff: unlock first, then send the second role ping. */
            const kickoffCutoff = new Date(now.getTime() - STALE_HOURS * 60 * 60 * 1000);
            const dueKickoffs = await Fixture.find({
                guildId: guild.id,
                'reserved.isReserved': { $ne: true },
                'channelPlan.channelId': { $ne: null },
                'channelPlan.state': { $in: ['locked', 'announced', 'done'] },
                'channelPlan.kickoffAnnouncedAt': null,
                scheduledAt: { $lte: now, $gte: kickoffCutoff },
                status: { $nin: ['Played', 'Cancelled'] }
            }).limit(10).lean().catch(() => []);

            for (const fixture of dueKickoffs) {
                const retryBefore = new Date(now.getTime() - ANNOUNCEMENT_RETRY_MS);
                const claim = await Fixture.findOneAndUpdate(
                    {
                        _id: fixture._id,
                        'reserved.isReserved': { $ne: true },
                        'channelPlan.channelId': { $ne: null },
                        'channelPlan.state': { $in: ['locked', 'announced', 'done'] },
                        'channelPlan.kickoffAnnouncedAt': null,
                        scheduledAt: { $lte: now },
                        status: { $nin: ['Played', 'Cancelled'] },
                        $or: [
                            { 'channelPlan.kickoffClaimedAt': null },
                            { 'channelPlan.kickoffClaimedAt': { $lte: retryBefore } }
                        ]
                    },
                    { $set: { 'channelPlan.state': 'announced', 'channelPlan.kickoffClaimedAt': now } },
                    { new: true }
                ).catch(() => null);

                if (!claim) continue;

                const plan = claim.channelPlan || {};

                if (!plan.kickoffUnlockedAt) {
                    const released = await applyUnlock({
                        guild,
                        channelId: plan.channelId,
                        previousOverwrite: plan.previousOverwrite,
                        reason: 'Kickoff time — release stadium channel'
                    }).catch(error => ({ ok: false, error: error?.message || 'channel unlock failed' }));

                    if (!released?.ok) {
                        await Fixture.updateOne(
                            { _id: fixture._id, 'channelPlan.state': 'announced' },
                            { $set: { 'channelPlan.lastError': `kickoff unlock: ${String(released?.error || 'unlock failed').slice(0, 160)}` } }
                        ).catch(() => null);
                        continue;
                    }

                    const unlockedAt = new Date();
                    await Fixture.updateOne(
                        { _id: fixture._id, 'channelPlan.state': 'announced', 'reserved.isReserved': { $ne: true } },
                        { $set: { 'channelPlan.kickoffUnlockedAt': unlockedAt } }
                    ).catch(error => console.error('[matchScheduler] could not save kickoff unlock:', error?.message || error));
                    plan.kickoffUnlockedAt = unlockedAt;
                }

                const result = await announceMatch({ client, guild, fixture: claim, stage: 'kickoff' }).catch(error => ({
                    ok: false,
                    error: error?.message || 'kickoff announcement failed'
                }));

                if (result.ok) {
                    await Fixture.updateOne(
                        { _id: fixture._id, 'channelPlan.state': 'announced' },
                        {
                            $set: {
                                'channelPlan.state': 'done',
                                'channelPlan.kickoffAnnouncedAt': new Date(),
                                'channelPlan.kickoffMessageId': result.messageId,
                                'channelPlan.lastError': null
                            },
                            $unset: { 'channelPlan.kickoffClaimedAt': 1 }
                        }
                    ).catch(error => console.error('[matchScheduler] could not save kickoff announcement:', error?.message || error));
                } else {
                    await Fixture.updateOne(
                        { _id: fixture._id, 'channelPlan.state': 'announced' },
                        { $set: { 'channelPlan.lastError': `kickoff announcement: ${String(result.error || 'send failed').slice(0, 160)}` } }
                    ).catch(() => null);
                }
            }

            /* 2. Housekeeping: played/cancelled fixtures still holding a lock */
            const stale = await Fixture.find({
                guildId: guild.id,
                'channelPlan.channelId': { $ne: null },
                'channelPlan.state': { $in: ['locked', 'announced'] },
                status: { $in: ['Played', 'Cancelled'] }
            }).limit(10).lean().catch(() => []);

            for (const fixture of stale) {
                await applyUnlock({
                    guild,
                    channelId: fixture.channelPlan.channelId,
                    previousOverwrite: fixture.channelPlan.previousOverwrite,
                    reason: 'Match finished — channel released'
                }).catch(() => null);

                await Fixture.updateOne(
                    { _id: fixture._id },
                    { $set: { 'channelPlan.state': 'done' } }
                ).catch(() => null);
            }
        }
    } catch (error) {
        console.error('[matchScheduler] tick error:', error?.message || error);
    } finally {
        running = false;
    }
}

/** Catch up after a restart: restore locks, missing schedule notices, and due kickoff pings. */
async function bootCatchUp(client) {
    const now = Date.now();

    for (const guild of client.guilds.cache.values()) {
        await retryCancelledUnlocks(guild);

        const pending = await Fixture.find({
            guildId: guild.id,
            'channelPlan.channelId': { $ne: null },
            'channelPlan.state': { $in: ['pending', 'locked'] }
        }).limit(20).lean().catch(() => []);

        for (const fixture of pending) {
            const plan = fixture.channelPlan;

            if (fixture.reserved?.isReserved) {
                const released = await applyUnlock({
                    guild,
                    channelId: plan.channelId,
                    previousOverwrite: plan.previousOverwrite,
                    reason: 'Reserved match — release stadium channel after restart'
                }).catch(error => ({ ok: false, error: error?.message || 'channel unlock failed' }));

                if (released?.ok) {
                    await Fixture.updateOne(
                        { _id: fixture._id, 'reserved.isReserved': true },
                        { $set: { 'channelPlan.state': 'cancelled', 'channelPlan.channelId': null, 'channelPlan.lastError': null } }
                    ).catch(() => null);
                } else {
                    await Fixture.updateOne(
                        { _id: fixture._id, 'reserved.isReserved': true },
                        { $set: {
                            'channelPlan.state': 'cancelled',
                            'channelPlan.lastError': String(released?.error || 'channel unlock failed').slice(0, 200)
                        } }
                    ).catch(() => null);
                }

                continue;
            }

            if (['Played', 'Cancelled'].includes(fixture.status)) {
                await applyUnlock({ guild, channelId: plan.channelId, previousOverwrite: plan.previousOverwrite, reason: 'Fixture already finished' }).catch(() => null);
                await Fixture.updateOne({ _id: fixture._id }, { $set: { 'channelPlan.state': 'done' } }).catch(() => null);
                continue;
            }

            const kickoff = fixture.scheduledAt ? new Date(fixture.scheduledAt).getTime() : null;

            if (kickoff && now - kickoff > STALE_HOURS * 3600_000) {
                await applyUnlock({ guild, channelId: plan.channelId, previousOverwrite: plan.previousOverwrite, reason: 'Missed while offline' }).catch(() => null);
                await Fixture.updateOne(
                    { _id: fixture._id },
                    { $set: { 'channelPlan.state': 'done', 'channelPlan.lastError': 'Bot was offline at kickoff — lock released without an announcement' } }
                ).catch(() => null);
                continue;
            }

            if (plan.state === 'pending') {
                const lock = await applyLock({ guild, channelId: plan.channelId, reason: 'Catch-up lock after restart' }).catch(() => ({ ok: false }));

                await Fixture.updateOne(
                    { _id: fixture._id },
                    {
                        $set: {
                            'channelPlan.state': lock.ok ? 'locked' : 'done',
                            'channelPlan.lockedAt': new Date(),
                            'channelPlan.previousOverwrite': lock.previousOverwrite ?? plan.previousOverwrite ?? null
                        }
                    }
                ).catch(() => null);

                if (lock.ok && !plan.scheduledAnnouncementMessageId) {
                    await sendScheduledAnnouncement({ client, guild, fixture });
                }
            } else if (plan.state === 'locked' && !plan.scheduledAnnouncementMessageId) {
                await sendScheduledAnnouncement({ client, guild, fixture });
            }
        }
    }
}

function startMatchScheduler(client) {
    if (timer) clearInterval(timer);

    bootCatchUp(client).catch(error => console.error('[matchScheduler] boot catch-up failed:', error?.message || error));

    timer = setInterval(() => tick(client), TICK_MS);
    timer.unref?.();

    console.log('⏰ Match scheduler started (announce now, remind at -1 min, unlock + ping at kickoff)');

    return timer;
}

module.exports = {
    startMatchScheduler,
    scheduleMatch,
    cancelPlan,
    listPlans,
    tick,
    announceMatch,
    buildPings,
    applyLock,
    applyUnlock,
    DEFAULT_REMINDER_BEFORE_MINUTES
};
