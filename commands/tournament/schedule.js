/**
 * schedule.js
 *
 * Tell the bot WHEN and WHERE a match is played:
 *   • it locks the stadium channel right away
 *   • one minute before kickoff it unlocks the channel and posts the
 *     announcement, pinging both team roles
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
const { parseScheduleTime, discordFull, discordRelative } = require('../../utils/istTime');
const {
    scheduleMatch,
    cancelPlan,
    listPlans,
    DEFAULT_LOCK_BEFORE_MINUTES
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
        .setDescription('Lock a stadium channel and auto-announce a match')
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Schedule a match: locks the channel now, announces 1 min before kickoff')
                .addIntegerOption(opt =>
                    opt.setName('match')
                        .setDescription('Match number (see /nextmatch)')
                        .setRequired(true)
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
                .setDescription('Show scheduled matches')
        )
        .addSubcommand(sub =>
            sub.setName('cancel')
                .setDescription('Cancel a scheduled match and unlock its channel')
                .addIntegerOption(opt =>
                    opt.setName('match')
                        .setDescription('Match number')
                        .setRequired(true)
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
                    'The channel is locked immediately and unlocked + announced **1 minute before kickoff**.'
                );
            }

            if (sub === 'list') {
                return runList({ guild: message.guild, reply: p => message.reply(p) });
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
                return runList({ guild: interaction.guild, reply: p => interaction.editReply(p) });
            }

            if (sub === 'cancel') {
                return runCancel({
                    guild: interaction.guild,
                    matchNumber: interaction.options.getInteger('match'),
                    tournamentKey: interaction.options.getString('tournament'),
                    reply: p => interaction.editReply(p)
                });
            }

            const channel = interaction.options.getChannel('channel');
            const time = interaction.options.getString('time');
            const venue = interaction.options.getString('venue');
            const match = interaction.options.getInteger('match');

            return runSet({
                client: interaction.client,
                guild: interaction.guild,
                matchNumber: match,
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

    if (!matchNumber) {
        return reply({ content: '❓ Usage: `.schedule <match number> at <time> in <#channel>`' });
    }

    if (!channelId) {
        return reply({ content: '❓ Which channel? Add the stadium channel — e.g. `.schedule 12 at 21:30 in #stadium-1`.' });
    }

    const fixture = await Fixture.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        matchNumber
    });

    if (!fixture) {
        return reply({ content: `❌ Match **#${matchNumber}** not found in **${tournament.name}**.` });
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

    const announceAt = new Date(kickoff.getTime() - DEFAULT_LOCK_BEFORE_MINUTES * 60_000);

    if (preview) {
        return reply({
            content:
                `🔎 **Preview — nothing changed**\n` +
                `Match: **#${matchNumber}** · ${fixture.homeTeam} vs ${fixture.awayTeam}\n` +
                `Tournament: ${tournament.name}\n` +
                `Channel: <#${channelId}>\n` +
                `Kickoff: ${discordFull(kickoff)} (${discordRelative(kickoff)}) — IST\n` +
                `Lock: now → Unlock + announce: ${discordFull(announceAt)}\n` +
                `Pings: ${fixture.homeTeam} + ${fixture.awayTeam}${pingCaps ? ' + captains' : ''}`
        });
    }

    /* Save the kickoff on the fixture */
    fixture.scheduledAt = kickoff;
    if (venue != null) fixture.venueName = venue;
    await fixture.save();

    const result = await scheduleMatch({
        client,
        guild,
        fixture,
        channelId,
        lockBeforeMinutes: DEFAULT_LOCK_BEFORE_MINUTES,
        pingCaptains: pingCaps,
        actorId
    });

    if (!result.ok) {
        return reply({ content: `❌ ${result.error}` });
    }

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🔒 MATCH SCHEDULED — CHANNEL LOCKED')
        .setDescription(
            `**#${matchNumber}** · ${fixture.homeTeam} vs ${fixture.awayTeam}\n` +
            `${tournament.emoji || '🏆'} ${tournament.name}` +
            (venue ? `\n📍 ${venue}` : '')
        )
        .addFields(
            { name: '🔒 Locked now', value: `<#${channelId}>`, inline: true },
            { name: '🔓 Unlock + announce', value: `${discordFull(announceAt)}\n(${discordRelative(announceAt)})`, inline: true },
            { name: '⏰ Kickoff (IST)', value: `${discordFull(kickoff)}\n(${discordRelative(kickoff)})`, inline: true }
        )
        .setFooter({ text: 'The bot keeps talking in the locked channel so it can post the announcement.' })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

async function runList({ guild, reply }) {
    const plans = await listPlans(guild.id);

    if (!plans.length) {
        return reply({ content: '📭 No matches are currently scheduled (no locked stadium channels).' });
    }

    const tournaments = await TournamentSettings.find({
        guildId: guild.id,
        _id: { $in: plans.map(p => p.tournamentId).filter(Boolean) }
    }).lean();

    const names = new Map(tournaments.map(t => [String(t._id), `${t.emoji || '🏆'} ${t.name}`]));

    const lines = plans.slice(0, 15).map(p => {
        const kickoff = p.scheduledAt ? `${discordFull(p.scheduledAt)} (${discordRelative(p.scheduledAt)})` : 'no time';
        const state = p.channelPlan?.state === 'locked' ? '🔒 locked' : `✅ ${p.channelPlan?.state}`;

        return (
            `**#${p.matchNumber}** ${p.homeTeam} vs ${p.awayTeam} — ${state}\n` +
            `   ${names.get(String(p.tournamentId)) || ''} · <#${p.channelPlan?.channelId}> · ${kickoff}`
        );
    });

    return reply({
        embeds: [
            new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle('🗓️ SCHEDULED MATCHES')
                .setDescription(lines.join('\n').slice(0, 4000))
                .setFooter({ text: `${plans.length} scheduled • times shown in your timezone` })
                .setTimestamp()
        ]
    });
}

async function runCancel({ guild, matchNumber, tournamentKey = null, reply }) {
    if (!matchNumber) {
        return reply({ content: '❓ Usage: `.schedule cancel <match number>`' });
    }

    /* Treats the default tournament as the scope; other tournaments need a key. */
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    const base = {
        guildId: guild.id,
        matchNumber,
        'channelPlan.channelId': { $ne: null },
        'channelPlan.state': { $in: ['locked', 'announced', 'pending'] }
    };

    const fixtures = await Fixture.find({ ...base, tournamentId: tournament._id });

    if (!fixtures.length) {
        const elsewhere = await Fixture.find(base).select('tournamentId').lean().catch(() => []);

        if (elsewhere.length) {
            const ids = [...new Set(elsewhere.map(f => String(f.tournamentId)))];
            const others = await TournamentSettings.find({ _id: { $in: ids } }).lean();
            const names = others
                .map(t => `${t.emoji || '🏆'} **${t.name}** (\`tournament=${t.tournamentKey}\`)`)
                .join(', ');

            return reply({
                content: `📭 Match **#${matchNumber}** has no active schedule in **${tournament.name}** — but it is scheduled in ${names}.`
            });
        }

        return reply({ content: `📭 Match **#${matchNumber}** has no active schedule to cancel.` });
    }

    for (const fixture of fixtures) {
        await cancelPlan({ guild, fixture });
    }

    return reply({
        content: `✅ Cancelled the schedule for match **#${matchNumber}** in **${tournament.name}** and unlocked its channel.`
    });
}
