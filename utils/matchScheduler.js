/**
 * utils/matchScheduler.js
 *
 * Match-day flow, entirely backed by the database so a restart does not lose it:
 *
 *   .schedule 12 at 21:30 in #stadium-1
 *        → LOCK #stadium-1 now, then announce/ping both teams immediately
 *        → at 21:29 (kickoff − 1 min): UNLOCK (restore the snapshot) and ping both teams again.
 *
 * Safety notes:
 *   • only the code-generated ping line can ping roles; AI and fixture text
 *     is sanitized before Discord's role parser is enabled for that message
 *   • every state change is an atomic findOneAndUpdate, so a slow tick can
 *     never double-lock or double-announce
 *   • if the bot was offline, the boot pass catches up sensibly
 */

const { PermissionsBitField, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { Fixture, Team, TournamentSettings, TournamentPlayer, Player } = require('../models/Tournament');
const { buildMatchAnnouncement } = require('./ai/announcements');
const { formatIst, discordFull, discordRelative } = require('./istTime');
const { sanitizeAIText } = require('./aiGuard');
const { slotEmoji, vsLine } = require('./ai/emojiSlots');

const TICK_MS = 10_000;
const DEFAULT_UNLOCK_BEFORE_MINUTES = 1;
const ANNOUNCEMENT_RETRY_MS = 60_000;
const STALE_HOURS = 6;

let timer = null;
let running = false;

function neutralizeUnapprovedMentions(text) {
    return String(text ?? '')
        .replace(/<@&\d+>/g, '@\u200Brole')
        .replace(/<@!?(\d+)>/g, '@\u200B$1')
        .replace(/@\s?(everyone|here)\b/gi, (_, target) => `@\u200B${target}`);
}

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

/* ── Announcement text + delivery ── */

async function buildAnnouncementMessage({
    guild,
    fixture,
    stage = 'kickoff',
    includePings = true,
    recordHistory = true
}) {
    const plan = fixture.channelPlan || {};
    const tournament = fixture.tournamentId
        ? await TournamentSettings.findById(fixture.tournamentId).lean().catch(() => null)
        : null;

    const homeTeam = fixture.homeTeam;
    const awayTeam = fixture.awayTeam;
    const pings = includePings
        ? await buildPings({ guild, homeTeam, awayTeam, pingCaptains: !!plan.pingCaptains })
        : { roleIds: [], userIds: [], labelLine: '' };

    const body = await buildMatchAnnouncement({
        guildId: guild.id,
        guildName: guild.name,
        tournament,
        fixture,
        homeTeam,
        awayTeam,
        venueName: fixture.venueName || '',
        scheduledAt: fixture.scheduledAt || new Date(),
        announcementType: stage,
        recordHistory
    });

    const calendar = slotEmoji('calendar', guild.id) || '⏰';
    const stageTitle = stage === 'scheduled'
        ? 'MATCH SCHEDULED'
        : stage === 'unlock'
            ? 'KICKOFF IN ONE MINUTE · CHANNEL UNLOCKED'
            : stage === 'reminder'
                ? 'ONE-MINUTE MATCH REMINDER'
                : 'KICKOFF TIME';

    const header =
        `🏟️ **${stageTitle} · MATCH ${fixture.matchNumber || ''} · ${tournament?.name || 'MATCH DAY'}**\n` +
        `**${vsLine(homeTeam, awayTeam, guild.id)}**\n` +
        `${calendar} ${formatIst(fixture.scheduledAt)} · ${discordFull(fixture.scheduledAt)} (${discordRelative(fixture.scheduledAt)})` +
        (fixture.venueName ? `\n📍 ${fixture.venueName}` : '');

    /*
     * Only the code-generated pingPrefix may contain role/user mentions.
     * Discord's role parser is enabled for that line; sanitize all prose and
     * metadata first so no model or fixture text can add another ping.
     */
    const { text: generatedBody } = sanitizeAIText(body, { maxUserPings: 0 });
    const safeHeader = neutralizeUnapprovedMentions(header);
    const safeBody = neutralizeUnapprovedMentions(generatedBody);
    const pingPrefix = includePings && pings.labelLine ? `${pings.labelLine}\n\n` : '';
    const content = `${pingPrefix}${safeHeader}\n\n${safeBody}`.trim().slice(0, 1900);

    return {
        content,
        header: safeHeader,
        safeBody,
        stageTitle,
        labelLine: pings.labelLine,
        pingRoleIds: includePings ? pings.roleIds : [],
        allowedMentions: {
            parse: includePings && pings.roleIds.length ? ['roles'] : [],
            users: includePings ? pings.userIds : []
        }
    };
}

async function announceMatch({ client, guild, fixture, stage = 'kickoff' }) {
    const plan = fixture.channelPlan || {};
    const channel = await guild.channels.fetch(plan.channelId).catch(() => null);

    if (!channel) return { ok: false, error: 'channel not found' };

    const message = await buildAnnouncementMessage({ guild, fixture, stage });
    const sent = await channel.send({
        content: message.content,
        allowedMentions: message.allowedMentions
    }).catch(async error => {
        console.error('[matchScheduler] announcement send failed; trying safe fallback:', error?.message || error);

        const embed = new EmbedBuilder()
            .setColor(0xFEBE10)
            .setTitle(`${message.stageTitle} — Match ${fixture.matchNumber || ''}: ${vsLine(fixture.homeTeam, fixture.awayTeam, guild.id)}`)
            .setDescription(`${message.header}\n\n${message.safeBody}`.slice(0, 4000))
            .setTimestamp();

        /* The fallback contains only the sanitized announcement plus the code-generated ping line. */
        return channel.send({
            content: message.labelLine || undefined,
            embeds: [embed],
            allowedMentions: message.allowedMentions
        }).catch(fallbackError => {
            console.error('[matchScheduler] announcement fallback failed:', fallbackError?.message || fallbackError);
            return null;
        });
    });

    plan.announcementMessageId = sent?.id || null;

    if (!sent) return { ok: false, error: 'both announcement sends failed' };

    const parsedRoles = sent.mentions?.roles;
    if (message.pingRoleIds.length && parsedRoles?.map) {
        const parsedRoleIds = new Set(parsedRoles.map(role => String(role.id)));
        const missingRoleIds = message.pingRoleIds.filter(id => !parsedRoleIds.has(String(id)));
        if (missingRoleIds.length) {
            console.error('[matchScheduler] Discord did not acknowledge expected role mentions:', missingRoleIds.join(', '));
        }
    }

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

async function sendUnlockAnnouncement({ client, guild, fixture, now = new Date() }) {
    const retryBefore = new Date(now.getTime() - ANNOUNCEMENT_RETRY_MS);
    const kickoffCutoff = new Date(now.getTime() - STALE_HOURS * 60 * 60 * 1000);

    const claim = await Fixture.findOneAndUpdate(
        {
            _id: fixture._id,
            'channelPlan.state': { $in: ['locked', 'announced'] },
            'channelPlan.announceAt': { $lte: now },
            'channelPlan.unlockAnnouncedAt': null,
            scheduledAt: { $gte: kickoffCutoff },
            'reserved.isReserved': { $ne: true },
            status: { $nin: ['Played', 'Cancelled'] },
            $or: [
                { 'channelPlan.unlockClaimedAt': null },
                { 'channelPlan.unlockClaimedAt': { $lte: retryBefore } }
            ]
        },
        { $set: { 'channelPlan.unlockClaimedAt': now } },
        { new: true }
    ).catch(error => {
        console.error('[matchScheduler] unlock announcement claim failed:', error?.message || error);
        return null;
    });

    if (!claim) return { ok: false, skipped: true };

    const plan = claim.channelPlan || {};
    if (!plan.unlockedAt) {
        const released = await applyUnlock({
            guild,
            channelId: plan.channelId,
            previousOverwrite: plan.previousOverwrite,
            reason: 'One minute before kickoff — release stadium channel'
        }).catch(error => ({ ok: false, error: error?.message || 'channel unlock failed' }));

        if (!released?.ok) {
            await Fixture.updateOne(
                { _id: fixture._id, 'channelPlan.state': { $in: ['locked', 'announced'] } },
                { $set: { 'channelPlan.lastError': `one-minute channel unlock: ${String(released?.error || 'unlock failed').slice(0, 160)}` } }
            ).catch(() => null);
            return { ok: false, error: released?.error || 'channel unlock failed' };
        }

        const unlockedAt = new Date();
        await Fixture.updateOne(
            { _id: fixture._id, 'channelPlan.state': { $in: ['locked', 'announced'] }, 'reserved.isReserved': { $ne: true } },
            { $set: { 'channelPlan.unlockedAt': unlockedAt, 'channelPlan.state': 'announced' } }
        ).catch(error => console.error('[matchScheduler] could not save one-minute unlock:', error?.message || error));
        plan.unlockedAt = unlockedAt;
        plan.state = 'announced';
    }

    const kickoffPassed = new Date(claim.scheduledAt).getTime() <= now.getTime();
    const stage = kickoffPassed ? 'kickoff' : 'unlock';
    const result = await announceMatch({ client, guild, fixture: claim, stage }).catch(error => ({
        ok: false,
        error: error?.message || 'unlock announcement failed'
    }));

    if (result.ok) {
        await Fixture.updateOne(
            { _id: fixture._id, 'channelPlan.state': { $in: ['locked', 'announced'] }, 'reserved.isReserved': { $ne: true } },
            {
                $set: {
                    'channelPlan.state': 'done',
                    'channelPlan.unlockAnnouncedAt': new Date(),
                    'channelPlan.unlockMessageId': result.messageId,
                    'channelPlan.announcedAt': new Date(),
                    'channelPlan.announcementMessageId': result.messageId,
                    'channelPlan.lastError': null
                },
                $unset: { 'channelPlan.unlockClaimedAt': 1 }
            }
        ).catch(error => console.error('[matchScheduler] could not save unlock announcement:', error?.message || error));
    } else {
        await Fixture.updateOne(
            { _id: fixture._id, 'channelPlan.state': { $in: ['locked', 'announced'] } },
            { $set: { 'channelPlan.lastError': `one-minute unlock announcement: ${String(result.error || 'send failed').slice(0, 160)}` } }
        ).catch(() => null);
    }

    return result;
}

async function scheduleMatch({
    client,
    guild,
    fixture,
    channelId,
    unlockBeforeMinutes = DEFAULT_UNLOCK_BEFORE_MINUTES,
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

    const intendedPings = await buildPings({ guild, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam, pingCaptains });
    const unmentionableRoleIds = intendedPings.roleIds.filter(roleId => {
        const role = guild.roles.cache.get?.(roleId);
        return !role || role.mentionable !== true;
    });

    if (unmentionableRoleIds.length) {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        const botMember = guild.members.me;
        const canMentionAllRoles = !!(
            channel && botMember &&
            channel.permissionsFor?.(botMember)?.has?.(PermissionFlagsBits.MentionEveryone)
        );

        if (!canMentionAllRoles) {
            const names = unmentionableRoleIds.map(id => guild.roles.cache.get?.(id)?.name || id).join(', ');
            return {
                ok: false,
                error: `Discord will show but not notify these team roles: ${names}. Enable “Allow anyone to @mention this role” for them or grant me “Mention @everyone, @here, and All Roles” in <#${channelId}>. Nothing was locked or announced.`
            };
        }
    }

    /* 1. Lock now */
    const lock = await applyLock({
        client,
        guild,
        channelId,
        reason: `Match ${fixture.matchNumber || ''} scheduled — reserved until one minute before kickoff`
    });

    if (!lock.ok) return { ok: false, error: lock.error };

    /* 2. Persist the plan */
    const unlockAt = new Date(kickoff.getTime() - unlockBeforeMinutes * 60_000);

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
                        announceAt: unlockAt,
                        lockedAt: now,
                        announcedAt: null,
                        scheduledAnnouncementClaimedAt: null,
                        scheduledAnnouncedAt: null,
                        scheduledAnnouncementMessageId: null,
                        reminderClaimedAt: null,
                        reminderAnnouncedAt: null,
                        reminderMessageId: null,
                        unlockClaimedAt: null,
                        unlockedAt: null,
                        unlockAnnouncedAt: null,
                        unlockMessageId: null,
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
        unlockAt,
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

            /* One minute before kickoff: restore permissions, then send the final role ping. */
            const unlockCutoff = new Date(now.getTime() - STALE_HOURS * 60 * 60 * 1000);
            const dueUnlocks = await Fixture.find({
                guildId: guild.id,
                'reserved.isReserved': { $ne: true },
                'channelPlan.state': { $in: ['locked', 'announced'] },
                'channelPlan.announceAt': { $lte: now },
                'channelPlan.unlockAnnouncedAt': null,
                scheduledAt: { $gte: unlockCutoff },
                status: { $nin: ['Played', 'Cancelled'] }
            }).limit(10).lean().catch(() => []);

            for (const fixture of dueUnlocks) {
                await sendUnlockAnnouncement({ client, guild, fixture, now });
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

/** Catch up after a restart: restore locks and missing schedule-time notices. */
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

    console.log('⏰ Match scheduler started (announce now, unlock + ping at -1 min)');

    return timer;
}

module.exports = {
    startMatchScheduler,
    scheduleMatch,
    cancelPlan,
    listPlans,
    tick,
    announceMatch,
    buildAnnouncementMessage,
    buildPings,
    applyLock,
    applyUnlock,
    DEFAULT_UNLOCK_BEFORE_MINUTES
};
