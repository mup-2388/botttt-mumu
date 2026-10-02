/**
 * schedule.js
 *
 * Tell the bot WHEN and WHERE a match is played:
 *   • it locks the stadium channel right away and announces/pings both teams
 *   • it sends a one-minute reminder without unlocking
 *   • at kickoff it unlocks the channel and pings both teams again
 *
 * Usage:
 *   .schedule 12 at 21:30 tomorrow in #stadium-1
 *   .schedule 12 at 25/10 21:00 in #stadium-1 venue:"Wankhede" caps
 *   .schedule list
 *   .schedule cancel 12
 *   .schedule preview 12 at 21:30 in #stadium-1
 *
 * Slash: /schedule set|list|cancel
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');

const { Fixture, TournamentSettings } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { parseScheduleTime, formatIst, discordFull, discordRelative } = require('../../utils/istTime');
const { slotEmoji, vsLine } = require('../../utils/ai/emojiSlots');
const {
    scheduleMatch,
    cancelPlan,
    listPlans,
    DEFAULT_REMINDER_BEFORE_MINUTES
} = require('../../utils/matchScheduler');

const VENUE_RE = /venue\s*[=:]\s*("[^"]+"|'[^']+'|\S+)/i;

function stripQuotes(s) {
    return String(s || '').replace(/^["']|["']$/g, '');
}

module.exports = {
    name: 'schedule',
    description: 'Lock a stadium channel and auto-announce a match.',
    usage: '.schedule <match no> at <time> in <#channel> [venue:"..." ] [caps] | .schedule list | .schedule cancel <match no>',
    aliases: ['matchschedule', 'mschedule'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.ManageChannels],

    data: new SlashCommandBuilder()
        .setName('schedule')
        .setDescription('Announce and lock a match channel; unlock and ping again at kickoff')
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Ping teams now, remind them 1 min before, unlock and ping at kickoff')
                .addStringOption(opt =>
                    opt.setName('match')
                        .setDescription('Choose a match or search by team name / match number')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption(opt =>
                    opt.setName('time')
                        .setDescription('Kickoff time in IST — e.g. "tomorrow 9:30pm", "25/10 21:00"')
                        .setRequired(true)
                )
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Stadium channel to lock and announce in')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                )
                .addStringOption(opt =>
                    opt.setName('venue')
                        .setDescription('Venue name shown in the announcement')
                        .setRequired(false)
                )
                .addBooleanOption(opt =>
                    opt.setName('ping_captains')
                        .setDescription('Also ping both captains')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Show scheduled matches in the default tournament')
                .addStringOption(opt =>
                    opt.setName('tournament')
                        .setDescription('Tournament key (default: the default tournament)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('cancel')
                .setDescription('Cancel a scheduled match and unlock its channel')
                .addStringOption(opt =>
                    opt.setName('match')
                        .setDescription('Choose a scheduled match or search by team name / match number')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption(opt =>
                    opt.setName('tournament')
                        .setDescription('Tournament key (default: the default tournament)')
                        .setRequired(false)
                )
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Only organizers can schedule matches.');
            }

            const sub = String(args[0] || '').toLowerCase();

            if (!sub || ['help'].includes(sub)) {
                return message.reply(
                    '🗓️ **Match scheduling**\n' +
                    '`.schedule <match> at <time> in <#channel> [venue:"..."] [caps]`\n' +
                    '`.schedule list` · `.schedule cancel <match>` · `.schedule preview ...`\n' +
                    'Times are **IST** (e.g. `tomorrow 9:30pm`, `25/10 21:00`).\n' +
                    'The channel locks immediately: both teams are pinged when scheduled, reminded **1 minute before kickoff**, then pinged again as it unlocks at kickoff.'
                );
            }

            if (sub === 'list') {
                const parsed = await extractTournamentFromArgs(message.guild.id, args.slice(1));
                if (parsed.explicit && parsed.error) return message.reply(parsed.error);
                return runList({
                    guild: message.guild,
                    tournamentKey: parsed.tournament?.tournamentKey || null,
                    reply: p => message.reply(p)
                });
            }

            if (sub === 'cancel') {
                const parsed = await extractTournamentFromArgs(message.guild.id, args.slice(1), {});

                return runCancel({
                    guild: message.guild,
                    matchNumber: Number(parsed.rest[0]) || null,
                    tournamentKey: parsed.tournament ? parsed.tournament.tournamentKey : null,
                    reply: p => message.reply(p)
                });
            }

            const preview = sub === 'preview';
            const rest = preview ? args.slice(1) : args;

            return runSet({
                client: message.client,
                guild: message.guild,
                raw: rest.join(' '),
                actorId: message.author.id,
                preview,
                reply: p => message.reply(p)
            });
        } catch (error) {
            console.error('[schedule] prefix error:', error);
            return message.reply(`❌ Failed to schedule the match.\n\`${String(error?.message || error).slice(0, 200)}\``);
        }
    },

    /* ================================================
       SLASH AUTOCOMPLETE
    ================================================ */

    async autocomplete(interaction) {
        const respond = choices => interaction.respond(choices).catch(() => null);

        try {
            if (!interaction.guild || !(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return respond([]);
            }

            const sub = interaction.options.getSubcommand(false);
            if (!['set', 'cancel'].includes(sub)) return respond([]);

            const tournamentKey = sub === 'cancel'
                ? interaction.options.getString('tournament')
                : null;
            const resolved = await resolveTournament(interaction.guild.id, tournamentKey);
            if (!resolved.tournament) return respond([]);

            const query = {
                guildId: interaction.guild.id,
                tournamentId: resolved.tournament._id
            };

            if (sub === 'cancel') {
                query['channelPlan.channelId'] = { $ne: null };
                query['channelPlan.state'] = { $in: ['locked', 'announced', 'pending', 'cancelled'] };
            }

            const fixtures = await Fixture.find(query)
                .sort({ matchNumber: 1, scheduledAt: 1 })
                .lean()
                .catch(() => []);
            const focused = String(interaction.options.getFocused() || '').trim().toLowerCase();
            const numericSearch = focused.replace(/^#/, '');
            const matching = fixtures.filter(fixture => {
                if (!focused) return true;
                const matchNumber = String(fixture.matchNumber ?? '');
                const teams = `${fixture.homeTeam || ''} ${fixture.awayTeam || ''}`.toLowerCase();
                return matchNumber.includes(numericSearch) || teams.includes(focused);
            });

            const choices = matching.slice(0, 25).map(fixture => {
                const plan = fixture.channelPlan || {};
                const isActivelyScheduled = !!plan.channelId && ['pending', 'locked', 'announced'].includes(plan.state);
                const state = fixture.reserved?.isReserved
                    ? 'reserved'
                    : isActivelyScheduled
                        ? 'scheduled'
                        : fixture.status || 'pending';
                const time = fixture.scheduledAt ? ` · ${formatIst(fixture.scheduledAt)}` : '';
                const label = `#${fixture.matchNumber} · ${fixture.homeTeam || 'Home'} vs ${fixture.awayTeam || 'Away'} · ${state}${time}`;

                return {
                    name: label.slice(0, 100),
                    value: String(fixture._id)
                };
            });

            return respond(choices);
        } catch (error) {
            console.error('[schedule] autocomplete failed:', error?.message || error);
            return respond([]);
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Only organizers can schedule matches.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const sub = interaction.options.getSubcommand();

            if (sub === 'list') {
                return runList({
                    guild: interaction.guild,
                    tournamentKey: interaction.options.getString('tournament'),
                    reply: p => interaction.editReply(p)
                });
            }

            if (sub === 'cancel') {
                return runCancel({
                    guild: interaction.guild,
                    fixtureId: interaction.options.getString('match'),
                    tournamentKey: interaction.options.getString('tournament'),
                    reply: p => interaction.editReply(p)
                });
            }

            const channel = interaction.options.getChannel('channel');
            const time = interaction.options.getString('time');
            const venue = interaction.options.getString('venue');
            const fixtureId = interaction.options.getString('match');

            return runSet({
                client: interaction.client,
                guild: interaction.guild,
                fixtureId,
                timeText: time,
                channelId: channel.id,
                venue,
                pingCaptains: interaction.options.getBoolean('ping_captains') ?? false,
                actorId: interaction.user.id,
                preview: false,
                reply: p => interaction.editReply(p)
            });
        } catch (error) {
            console.error('[schedule] slash error:', error);

            const payload = { content: `❌ Failed to schedule the match.\n\`${String(error?.message || error).slice(0, 200)}\`` };

            if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
            return interaction.reply({ ...payload, ephemeral: true });
        }
    }
};

/* ====================================================
   CORE
==================================================== */

async function runSet({
    client,
    guild,
    raw = '',
    matchNumber = null,
    fixtureId = null,
    timeText = null,
    channelId = null,
    venue = null,
    pingCaptains = false,
    actorId = null,
    preview = false,
    reply
}) {
    let text = String(raw || '');
    let pingCaps = pingCaptains;

    /* venue:"..." / venue:Name */
    if (venue == null) {
        const venueMatch = text.match(VENUE_RE);
        if (venueMatch) {
            venue = stripQuotes(venueMatch[1]);
            text = text.replace(venueMatch[0], ' ');
        }
    }

    /* caps flag */
    if (/\bcaps\b|\bcaptains?\b/i.test(text)) {
        pingCaps = true;
        text = text.replace(/\bcaps\b|\bcaptains?\b/gi, ' ');
    }

    /* channel mention: <#123…> */
    if (!channelId) {
        const ch = text.match(/<#(\d+)>/);
        if (ch) {
            channelId = ch[1];
            text = text.replace(ch[0], ' ');
        }
    }

    /* raw #channel-name (the user typed it instead of picking the mention) */
    if (!channelId) {
        const named = text.match(/(?:^|\s)#([a-z0-9][a-z0-9-_]{1,90})(?=\s|$)/i);

        if (named) {
            const wanted = named[1].toLowerCase();
            const guildChannels = guild.channels?.cache;

            const found = guildChannels?.find?.(c =>
                typeof c?.name === 'string' && c.name.toLowerCase() === wanted
            );

            if (found) {
                channelId = found.id;
                text = text.replace(named[0], ' ');
            }
        }
    }

    /* match number */
    if (matchNumber == null) {
        const m = text.match(/\b(?:match|m|#)?\s*(\d{1,4})\b/);
        if (m) {
            matchNumber = Number(m[1]);
            text = text.replace(m[0], ' ');
        }
    }

    /* optional tournament=<key> escape hatch */
    const parsedKey = await extractTournamentFromArgs(guild.id, text.split(/\s+/).filter(Boolean), { tokenOnly: true });

    const resolved = await resolveTournament(guild.id, parsedKey.explicit ? parsedKey.tournament.tournamentKey : null);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    if (!matchNumber && !fixtureId) {
        return reply({ content: '❓ Choose a match, then provide its time and channel.' });
    }

    if (!channelId) {
        return reply({ content: '❓ Which channel? Add the stadium channel — e.g. `.schedule 12 at 21:30 in #stadium-1`.' });
    }

    const fixtureQuery = {
        guildId: guild.id,
        tournamentId: tournament._id,
        ...(fixtureId ? { _id: fixtureId } : { matchNumber })
    };
    const fixture = await Fixture.findOne(fixtureQuery);

    if (!fixture) {
        const matchLabel = matchNumber ? `#${matchNumber}` : 'selected match';
        return reply({ content: `❌ ${matchLabel} was not found in **${tournament.name}**. Refresh the match picker and try again.` });
    }

    matchNumber = fixture.matchNumber;

    if (fixture.channelPlan?.state === 'cancelled' && fixture.channelPlan?.channelId) {
        return reply({
            content: `⏳ The old channel lock for match **#${matchNumber}** is still being released. I will retry automatically; schedule it again once the channel is unlocked.`
        });
    }

    if (fixture.channelPlan?.channelId && ['pending', 'locked', 'announced'].includes(fixture.channelPlan.state)) {
        return reply({
            content: `⚠️ Match **#${matchNumber}** is already scheduled in <#${fixture.channelPlan.channelId}>. Cancel that plan first with \`/schedule cancel\` and select this match, then schedule it again; this avoids leaving the old channel locked.`
        });
    }

    /* time: explicit argument, or the fixture's existing kickoff */
    let kickoff = null;

    const timeSource = timeText || parsedKey.rest.join(' ');

    if (timeSource && timeSource.trim()) {
        /* remove the tournament=<key> token from the time text */
        const clean = timeSource.replace(/\b(tournament|key|t)=\S+/gi, ' ').trim();

        if (clean) {
            const parsed = parseScheduleTime(clean);

            if (!parsed.ok) {
                return reply({
                    content:
                        `❌ ${parsed.error}\n` +
                        'Try: `tomorrow 9:30pm`, `25/10 21:00`, `today 9pm`, `in 2h`.'
                });
            }

            kickoff = parsed.date;
        }
    }

    if (!kickoff && fixture.scheduledAt) kickoff = new Date(fixture.scheduledAt);

    if (!kickoff) {
        return reply({
            content:
                `❌ Match **#${matchNumber}** has no kickoff time yet.\n` +
                'Give one: `.schedule ' + matchNumber + ' at tomorrow 9:30pm in <#channel>` ' +
                '(or set it once with `.editfixture`).'
        });
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (!channel) {
        return reply({ content: '❌ I cannot see that channel. Mention it again or check my permissions.' });
    }

    const announceAt = new Date(kickoff.getTime() - DEFAULT_REMINDER_BEFORE_MINUTES * 60_000);

    if (preview) {
        return reply({
            content:
                `🔎 **Preview — nothing changed**\n` +
                `Match: **#${matchNumber}** · ${vsLine(fixture.homeTeam, fixture.awayTeam, guild.id)}\n` +
                `Tournament: ${tournament.name}\n` +
                `Channel: <#${channelId}>\n` +
                `Kickoff: ${formatIst(kickoff)} · ${discordFull(kickoff)} (${discordRelative(kickoff)})\n` +
                `Lock: now · Schedule ping: immediately · Reminder: ${formatIst(announceAt)}\n` +
                `Unlock + kickoff ping: ${formatIst(kickoff)}\n` +
                `Pings: ${fixture.homeTeam} + ${fixture.awayTeam}${pingCaps ? ' + captains' : ''}`
        });
    }

    /* Keep proposed values in memory; scheduleMatch persists them atomically
       with the channel plan only after it has successfully locked the channel. */
    fixture.scheduledAt = kickoff;
    if (venue != null) fixture.venueName = venue;

    const result = await scheduleMatch({
        client,
        guild,
        fixture,
        channelId,
        reminderBeforeMinutes: DEFAULT_REMINDER_BEFORE_MINUTES,
        pingCaptains: pingCaps,
        actorId
    });

    if (!result.ok) {
        return reply({ content: `❌ ${result.error}` });
    }

    const noticeState = result.scheduledAnnouncement?.ok
        ? '✅ Posted in the match channel'
        : result.scheduledAnnouncement?.skipped
            ? '⏳ Delivery is not confirmed; the scheduler will retry if this plan is still active'
            : '⚠️ The schedule is saved; the channel notice will be retried';

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🔒 MATCH SCHEDULED — CHANNEL LOCKED')
        .setDescription(
            `**#${matchNumber}** · ${vsLine(fixture.homeTeam, fixture.awayTeam, guild.id)}\n` +
            `${tournament.emoji || '🏆'} ${tournament.name}` +
            (venue ? `\n📍 ${venue}` : '')
        )
        .addFields(
            { name: '🔒 Locked now', value: `<#${channelId}>`, inline: true },
            { name: '📣 Schedule ping', value: noticeState, inline: true },
            { name: '🔔 One-minute reminder', value: `${formatIst(announceAt)}\n${discordRelative(announceAt)}`, inline: true },
            { name: '🔓 Unlock + kickoff ping (IST)', value: `${formatIst(kickoff)}\n${discordRelative(kickoff)}`, inline: true }
        )
        .setFooter({ text: 'Teams are pinged now, reminded one minute before, then pinged again as the channel unlocks at kickoff.' })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

async function runList({ guild, tournamentKey = null, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error || '📭 No default tournament is set.' });
    }

    const tournament = resolved.tournament;
    const plans = await listPlans(guild.id, tournament._id);

    if (!plans.length) {
        return reply({ content: `📭 No matches are currently scheduled in **${tournament.name}**.` });
    }

    const lines = plans.slice(0, 15).map(p => {
        const kickoff = p.scheduledAt
            ? `${slotEmoji('calendar', guild.id)} ${formatIst(p.scheduledAt)} · ${discordFull(p.scheduledAt)} (${discordRelative(p.scheduledAt)})`
            : 'no time';
        const state = p.channelPlan?.state === 'cancelled'
            ? '⚠️ cancelled — channel unlock retrying'
            : p.channelPlan?.lastError
                ? '⚠️ announcement needs attention'
                : p.channelPlan?.state === 'locked' ? '🔒 locked' : `✅ ${p.channelPlan?.state}`;

        return (
            `**#${p.matchNumber}** ${vsLine(p.homeTeam, p.awayTeam, guild.id)} — ${state}\n` +
            `   <#${p.channelPlan?.channelId}> · ${kickoff}`
        );
    });

    return reply({
        embeds: [
            new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle(`${slotEmoji('calendar', guild.id)} SCHEDULED MATCHES — ${tournament.name}`)
                .setDescription(lines.join('\n').slice(0, 4000))
                .setFooter({ text: `${plans.length} scheduled • IST shown explicitly; Discord timestamps localize too` })
                .setTimestamp()
        ]
    });
}

async function runCancel({ guild, matchNumber = null, fixtureId = null, tournamentKey = null, reply }) {
    if (!matchNumber && !fixtureId) {
        return reply({ content: '❓ Choose a scheduled match to cancel.' });
    }

    /* Treats the default tournament as the scope; other tournaments need a key. */
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    const base = {
        guildId: guild.id,
        ...(fixtureId ? { _id: fixtureId } : { matchNumber }),
        'channelPlan.channelId': { $ne: null },
        'channelPlan.state': { $in: ['locked', 'announced', 'pending', 'cancelled'] }
    };

    const fixtures = await Fixture.find({ ...base, tournamentId: tournament._id });
    const selectedFixture = fixtureId
        ? await Fixture.findOne({ guildId: guild.id, tournamentId: tournament._id, _id: fixtureId }).select('matchNumber').lean().catch(() => null)
        : null;
    const targetMatchNumber = fixtures[0]?.matchNumber || selectedFixture?.matchNumber || matchNumber;

    if (!fixtures.length) {
        const elsewhere = fixtureId
            ? []
            : await Fixture.find(base).select('tournamentId').lean().catch(() => []);

        if (elsewhere.length) {
            const ids = [...new Set(elsewhere.map(f => String(f.tournamentId)))];
            const others = await TournamentSettings.find({ _id: { $in: ids } }).lean();
            const names = others
                .map(t => `${t.emoji || '🏆'} **${t.name}** (\`tournament=${t.tournamentKey}\`)`)
                .join(', ');

            return reply({
                content: `📭 Match **#${targetMatchNumber || 'selected'}** has no active schedule in **${tournament.name}** — but it is scheduled in ${names}.`
            });
        }

        return reply({ content: `📭 Match **#${targetMatchNumber || 'selected'}** has no active schedule to cancel.` });
    }

    const outcomes = [];

    for (const fixture of fixtures) {
        const result = await cancelPlan({ guild, fixture }).catch(error => ({
            ok: false,
            error: error?.message || 'channel unlock failed'
        }));
        outcomes.push(result);
    }

    const cancelled = outcomes.filter(result => result.cancelled).length;
    const unlockFailed = outcomes.filter(result => result.cancelled && !result.unlocked).length;
    const databaseFailed = outcomes.length - cancelled;

    const messages = [];
    if (cancelled) {
        messages.push(`✅ Cancelled ${cancelled}/${outcomes.length} schedule(s) for match **#${targetMatchNumber}** in **${tournament.name}**; those matches will not be announced.`);
    }
    if (unlockFailed) {
        messages.push(`⚠️ ${unlockFailed} channel unlock(s) failed; I will retry automatically.`);
    }
    if (databaseFailed) {
        messages.push(`❌ I could not cancel ${databaseFailed} schedule(s) in the database, so they may still announce. Please run \`.schedule cancel ${targetMatchNumber}\` again.`);
    }

    return reply({ content: messages.join('\n') || 'ℹ️ No schedule was changed.' });
}
