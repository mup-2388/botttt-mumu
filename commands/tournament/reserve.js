/**
 * reserve.js
 *
 * A match that could not be played on its matchday is "reserved": organizers
 * hold it for another day instead of voiding it.
 *
 *   .reserve 12                          → reserve match 12 (no new date yet)
 *   .reserve 12 at tomorrow 9pm          → reserve it and move it to that day
 *   .reserve 12 at 25/10 21:00 reason:"rain"
 *   .reserve list                        → everything currently reserved
 *   .reserve clear 12                    → undo the reservation
 *
 * Reserving releases the stadium channel lock immediately (the match is not
 * happening as planned) and shows a 🛡️ badge in every fixture list. The match
 * stays reportable — play it and report the score whenever it happens.
 *
 * Slash: /reserve set|list|clear
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const { Fixture } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { parseScheduleTime, discordFull, discordRelative } = require('../../utils/istTime');
const { markReserved, clearReserved, isReserved } = require('../../utils/reservedMatches');
const { slotEmoji, vsLine } = require('../../utils/ai/emojiSlots');

const REASON_RE = /reason\s*[=:]\s*("[^"]+"|'[^']+'|[^\s]+)/i;

function stripQuotes(s) {
    return String(s || '').replace(/^["']|["']$/g, '');
}

module.exports = {
    name: 'reserve',
    description: 'Mark a match as reserved (postponed) and optionally pick a new day.',
    usage: '.reserve <match no> [at <time>] [reason:"rain"] | .reserve list | .reserve clear <match no>',
    aliases: ['reserved', 'postpone'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('reserve')
        .setDescription('Mark a match as reserved / postponed')
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Reserve a fixture and optionally move it to a new day')
                .addIntegerOption(opt =>
                    opt.setName('match')
                        .setDescription('Match number')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('time')
                        .setDescription('New day/time in IST — e.g. "sunday 9pm" (optional)')
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt.setName('reason')
                        .setDescription('Why it could not be played (optional)')
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt.setName('tournament')
                        .setDescription('Tournament key (default: the default tournament)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Show reserved matches in the default tournament')
                .addStringOption(opt =>
                    opt.setName('tournament')
                        .setDescription('Tournament key (default: the default tournament)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('Undo a reservation')
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
                return message.reply('🚫 Only organizers can reserve matches.');
            }

            const sub = String(args[0] || '').toLowerCase();

            if (!sub || sub === 'help') {
                return message.reply(
                    '🛡️ **Reserved matches** — for a match that could not be played on its day\n' +
                    '`.reserve <match> [at <time>] [reason:"..."]` — e.g. `.reserve 12 at sunday 9pm reason:"rain"`\n' +
                    '`.reserve list` · `.reserve clear <match>`\n' +
                    'Reserving unlocks the stadium channel and keeps the match playable whenever you get to it.'
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

            if (['clear', 'cancel', 'remove', 'unreserve'].includes(sub)) {
                const parsed = await extractTournamentFromArgs(message.guild.id, args.slice(1), {});

                return runClear({
                    guild: message.guild,
                    matchNumber: Number(String(parsed.rest[0] || '').replace(/^#/, '')) || null,
                    tournamentKey: parsed.tournament ? parsed.tournament.tournamentKey : null,
                    reply: p => message.reply(p)
                });
            }

            const setArgs = sub === 'set' ? args.slice(1) : args;

            return runSet({
                client: message.client,
                guild: message.guild,
                raw: setArgs.join(' '),
                matchNumber: Number(String(setArgs[0] || '').replace(/^#/, '')) || null,
                actorId: message.author.id,
                reply: p => message.reply(p)
            });
        } catch (error) {
            console.error('[reserve] prefix error:', error);
            return message.reply(`❌ Failed to reserve the match.\n\`${String(error?.message || error).slice(0, 200)}\``);
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Only organizers can reserve matches.', ephemeral: true });
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

            if (sub === 'clear') {
                return runClear({
                    guild: interaction.guild,
                    matchNumber: interaction.options.getInteger('match'),
                    tournamentKey: interaction.options.getString('tournament'),
                    reply: p => interaction.editReply(p)
                });
            }

            return runSet({
                client: interaction.client,
                guild: interaction.guild,
                matchNumber: interaction.options.getInteger('match'),
                timeText: interaction.options.getString('time'),
                reason: interaction.options.getString('reason'),
                tournamentKey: interaction.options.getString('tournament'),
                actorId: interaction.user.id,
                reply: p => interaction.editReply(p)
            });
        } catch (error) {
            console.error('[reserve] slash error:', error);

            const payload = { content: `❌ Failed to reserve the match.\n\`${String(error?.message || error).slice(0, 200)}\`` };

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
    reason = null,
    tournamentKey = null,
    actorId = null,
    reply
}) {
    let text = String(raw || '');

    /* match number from the raw text when not supplied */
    if (matchNumber == null) {
        const m = text.match(/\b(?:match|m|#)?\s*(\d{1,4})\b/);
        if (m) matchNumber = Number(m[1]);
    }

    /* tournament=<key> escape hatch */
    const parsedKey = await extractTournamentFromArgs(guild.id, text.split(/\s+/).filter(Boolean), { tokenOnly: true });
    const resolved = await resolveTournament(
        guild.id,
        tournamentKey || (parsedKey.explicit ? parsedKey.tournament.tournamentKey : null)
    );

    if (!resolved.tournament) return reply({ content: resolved.error });

    const tournament = resolved.tournament;

    if (!matchNumber) {
        return reply({ content: '❓ Usage: `.reserve <match number> [at <time>] [reason:"..."]`' });
    }

    /* reason:"..." */
    if (!reason) {
        const found = text.match(REASON_RE);
        if (found) {
            reason = stripQuotes(found[1]);
            text = text.replace(found[0], ' ');
        }
    }

    const matches = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        matchNumber
    }).limit(2);

    if (!matches.length) {
        return reply({ content: `❌ Match **#${matchNumber}** not found in **${tournament.name}**.` });
    }

    if (matches.length > 1) {
        return reply({ content: `❌ Match number **#${matchNumber}** is duplicated in **${tournament.name}**; fix the fixture numbering before reserving it.` });
    }

    const fixture = matches[0];

    if (!['Pending', 'Live', 'Cancelled'].includes(fixture.status)) {
        return reply({ content: `❌ Match **#${matchNumber}** is ${String(fixture.status || 'not pending').toLowerCase()} — only unplayed matches can be reserved.` });
    }

    /* New day/time (optional). Falls back to the time text given without "at". */
    let until = null;
    const timeSource = (timeText || text.replace(/\bat\b/i, ' ')).trim();

    if (timeSource && !/^[\d\s#]*$/.test(timeSource)) {
        const parsed = parseScheduleTime(timeSource);

        if (!parsed.ok) {
            return reply({ content: `❌ ${parsed.error}\nTry \`sunday 9pm\` or \`25/10 21:00\`.` });
        }

        until = parsed.date;
    }

    const result = await markReserved({ client, guild, fixture, until, note: reason, actorId });

    if (!result.ok) return reply({ content: `❌ ${result.error}` });

    const icon = slotEmoji('reserve', guild.id);
    const lines = [
        `${icon} **MATCH #${matchNumber} RESERVED**`,
        vsLine(fixture.homeTeam, fixture.awayTeam, guild.id),
        `Tournament: **${tournament.name}**`
    ];

    if (result.previousKickoff) {
        lines.push(`Was due: ${discordFull(result.previousKickoff)} (${discordRelative(result.previousKickoff)})`);
    }

    if (result.until) {
        lines.push(`${slotEmoji('calendar', guild.id)} New day: ${discordFull(result.until)} (${discordRelative(result.until)})`);
        lines.push(`To lock the stadium and schedule the announcement, use \`.schedule ${matchNumber} at <time> in <#channel>\`.`);
    } else {
        lines.push('New day: not decided yet — play it whenever, then `.report` it.');
    }

    if (reason) lines.push(`Reason: ${reason}`);
    if (result.alreadyReserved) lines.push('_Reservation details updated._');

    if (result.releasedChannel) {
        lines.push('🔓 The previously locked stadium channel is unlocked.');
    } else if (result.unlockError) {
        lines.push(`⚠️ The reservation was saved, but the old channel lock could not be released yet: ${result.unlockError}. I will retry.`);
    }

    lines.push('The match stays **Pending** and can still be reported whenever it is played.');

    return reply({ content: lines.join('\n').slice(0, 1900) });
}

async function runList({ guild, tournamentKey = null, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey);
    if (!resolved.tournament) return reply({ content: resolved.error || '📭 No default tournament is set.' });

    const tournament = resolved.tournament;
    const fixtures = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        'reserved.isReserved': true,
        status: { $in: ['Pending', 'Live'] }
    })
        .sort({ 'reserved.at': -1, matchNumber: 1 })
        .limit(20)
        .lean();

    if (!fixtures.length) {
        return reply({ content: `📭 No matches are reserved in **${tournament.name}** right now.` });
    }

    const lines = fixtures.map(f => {
        const until = f.reserved?.until
            ? ` → ${slotEmoji('calendar', guild.id)} ${discordFull(f.reserved.until)} (${discordRelative(f.reserved.until)})`
            : ' → day not decided';
        const reason = f.reserved?.note ? `\n   _${f.reserved.note}_` : '';

        return (
            `**#${f.matchNumber}** ${vsLine(f.homeTeam, f.awayTeam, guild.id)}${until}\n` +
            `   marked ${discordRelative(f.reserved?.at || new Date())}${reason}`
        );
    });

    return reply({
        embeds: [
            new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle(`${slotEmoji('reserve', guild.id)} RESERVED MATCHES — ${tournament.name}`)
                .setDescription(lines.join('\n').slice(0, 4000))
                .setFooter({ text: `${fixtures.length} reserved • play and report them whenever they happen` })
                .setTimestamp()
        ]
    });
}

async function runClear({ guild, matchNumber, tournamentKey = null, reply }) {
    if (!matchNumber) {
        return reply({ content: '❓ Usage: `.reserve clear <match number>`' });
    }

    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) return reply({ content: resolved.error });

    const tournament = resolved.tournament;

    const matches = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        matchNumber
    }).limit(2);

    if (!matches.length) {
        return reply({ content: `❌ Match **#${matchNumber}** not found in **${tournament.name}**.` });
    }

    if (matches.length > 1) {
        return reply({ content: `❌ Match number **#${matchNumber}** is duplicated in **${tournament.name}**; fix the fixture numbering before clearing it.` });
    }

    const fixture = matches[0];

    if (!isReserved(fixture)) {
        return reply({ content: `ℹ️ Match **#${matchNumber}** is not reserved.` });
    }

    const result = await clearReserved({ fixture });

    if (!result.ok) return reply({ content: `❌ ${result.error}` });

    const lines = [
        `✅ **MATCH #${matchNumber} IS NO LONGER RESERVED**`,
        vsLine(fixture.homeTeam, fixture.awayTeam, guild.id)
    ];

    if (fixture.scheduledAt) {
        lines.push(`Kickoff stays at ${discordFull(fixture.scheduledAt)} (${discordRelative(fixture.scheduledAt)}).`);
    } else {
        lines.push('No kickoff time set — `.schedule` it when you know the day.');
    }

    return reply({ content: lines.join('\n') });
}
