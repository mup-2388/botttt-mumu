/**
 * report.js
 *
 * Interactive match result reporter.
 * Select tournament → select group → select fixture → enter scores via modal.
 * Processes the result: updates fixture, team stats, live standings, top stats,
 * master schedules, and bracket.
 *
 * Usage: .report
 * Slash: /report
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const { Fixture, TournamentTeam } = require('../../models/Tournament');
const {
    getDefaultTournament,
    getSelectableTournaments,
    getTournamentByKey
} = require('../../utils/getTournament');
const { updateAllLiveStandings } = require('../../utils/updateStandings');
const { updateLiveTopStats } = require('../../utils/updateTopStats');
const { isOrganizer } = require('../../utils/isOrganizer');
const { prettyPhase } = require('../../utils/displayHelpers');
const { refreshLiveMasterSchedules } = require('./master-schedule');
const { refreshLiveBracket } = require('./sendbracket');
const { slotEmoji, vsLine } = require('../../utils/ai/emojiSlots');
const { markReserved, reservedBadge, isReserved } = require('../../utils/reservedMatches');
const { parseScheduleTime, discordFull, discordRelative } = require('../../utils/istTime');

/** Max fixtures shown in the menu */
const FIXTURE_LIMIT = 15;
const GROUP_FIXTURE_LIMIT = 25;

module.exports = {
    name: 'report',
    description: 'Report a score or mark an unplayed fixture as reserved.',
    usage: '.report | .report <match> reserved [at <IST time>]',
    cooldown: 5,
    hidden: true,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('report')
        .setDescription('Report a match result or reserve an unplayed fixture'),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 You are not authorized to use this command.');
            }

            /*
             * Quick path — a match that could not be played today:
             *   .report 12 reserved [at sunday 9pm] [reason:"rain"]
             */
            const wantsReserved = (args || []).some(a => /^(reserved|reserve|postponed?)$/i.test(String(a)));
            const matchArg = (args || []).map(a => String(a)).find(a => /^\d{1,4}$/.test(a));

            if (wantsReserved) {
                return reserveFromReport({
                    client: message.client,
                    guild: message.guild,
                    args: (args || []).filter(a => !/^(reserved|reserve|postponed?)$/i.test(String(a))),
                    actorId: message.author.id,
                    reply: payload => message.reply(payload)
                });
            }

            if (matchArg && !wantsReserved && (args || []).length === 1) {
                return message.reply(
                    `ℹ️ To mark match #${matchArg} as reserved, use \`.report ${matchArg} reserved\` ` +
                    '(optionally add `at sunday 9pm`). To report a score, run `.report` and select the fixture.'
                );
            }

            return await startReportMenu({
                client: message.client,
                guild: message.guild,
                userId: message.author.id,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[report] prefix error:', error);
            return message.reply('❌ Failed to start report menu.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 You are not authorized to use this command.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            return await startReportMenu({
                client: interaction.client,
                guild: interaction.guild,
                userId: interaction.user.id,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[report] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to start report menu.');
            }

            return interaction.reply({
                content: '❌ Failed to start report menu.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   REPORT MENU — Interactive tournament/group/fixture selector
==================================================== */

/**
 * Build and send the report menu with tournament, group, and fixture selectors.
 * Handles all interactions through a component collector.
 */
async function startReportMenu({ client, guild, userId, reply }) {
    const tournaments = await getSelectableTournaments(guild.id);

    if (!tournaments.length) {
        return reply({ content: '📭 No active tournaments found.' });
    }

    const tournament = await getDefaultTournament(guild.id);

    if (!tournament) {
        return reply({ content: '⚠️ No default tournament is set. Set a default tournament, then run `.report` again.' });
    }

    let selectedGroup = 'all';
    let pendingFixtures = await getPendingFixtures(guild.id, tournament._id, selectedGroup);

    // ── Send initial menu ──
    const msg = await reply({
        embeds: [buildMenuEmbed(tournament, pendingFixtures, selectedGroup, guild.id)],
        components: await buildMenuComponents(tournaments, tournament, pendingFixtures, guild.id, selectedGroup)
    });

    if (!msg?.createMessageComponentCollector) return;

    // ── Collector for all menu interactions ──
    const collector = msg.createMessageComponentCollector({
        time: 10 * 60 * 1000
    });

    collector.on('collect', async (interaction) => {
        try {
            // Only the original user can interact
            if (interaction.user.id !== userId) {
                return interaction.reply({
                    content: 'Not your report menu.',
                    ephemeral: true
                });
            }

            // ── Reserve button → modal for match number / new day / reason ──
            if (interaction.isButton() && interaction.customId === 'report_reserve') {
                return handleReserveButton({
                    interaction,
                    client,
                    guild,
                    tournament,
                    msg,
                    selectedGroup,
                    tournaments,
                    onFixtureUpdated: (updated) => {
                        pendingFixtures = updated;
                    }
                });
            }

            if (!interaction.isStringSelectMenu()) return;

            // ── Tournament changed ──
            if (interaction.customId === 'report_tournament') {
                const selected = await getTournamentByKey(guild.id, interaction.values[0]);

                if (!selected) {
                    return interaction.update({
                        content: '❌ Tournament not found.',
                        embeds: [],
                        components: []
                    });
                }

                tournament = selected;
                selectedGroup = 'all';
                pendingFixtures = await getPendingFixtures(guild.id, tournament._id, selectedGroup);

                return interaction.update({
                    embeds: [buildMenuEmbed(tournament, pendingFixtures, selectedGroup, guild.id)],
                    components: await buildMenuComponents(tournaments, tournament, pendingFixtures, guild.id, selectedGroup)
                });
            }

            // ── Group filter changed ──
            if (interaction.customId === 'report_group') {
                selectedGroup = interaction.values[0];
                pendingFixtures = await getPendingFixtures(guild.id, tournament._id, selectedGroup);

                return interaction.update({
                    embeds: [buildMenuEmbed(tournament, pendingFixtures, selectedGroup, guild.id)],
                    components: await buildMenuComponents(tournaments, tournament, pendingFixtures, guild.id, selectedGroup)
                });
            }

            // ── Fixture selected → open score modal ──
            if (interaction.customId === 'report_fixture') {
                await handleFixtureSelection({
                    interaction,
                    client,
                    guild,
                    tournament,
                    fixtureId: interaction.values[0],
                    userId,
                    msg,
                    onFixtureUpdated: (updated) => {
                        pendingFixtures = updated;
                    },
                    selectedGroup,
                    tournaments
                });
            }
        } catch (error) {
            console.error('[report] collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Failed to process report action.',
                    ephemeral: true
                }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        await msg.edit({ components: [] }).catch(() => null);
    });
}

/* ====================================================
   FIXTURE SELECTION → MODAL → PROCESS
==================================================== */

/**
 * Show the score input modal, wait for submission, and process the result.
 */
async function handleFixtureSelection({ interaction, client, guild, tournament, fixtureId, userId, msg, onFixtureUpdated, selectedGroup, tournaments }) {
    const fixture = await Fixture.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        _id: fixtureId,
        ...reportableFixtureStatusFilter()
    });

    if (!fixture) {
        return interaction.reply({
            content: '❌ This fixture is no longer available to report.',
            ephemeral: true
        });
    }

    // ── Build modal ──
    const modalId = `report_score_${fixture._id}_${Date.now()}`;

    const homeInput = new TextInputBuilder()
        .setCustomId('home_score')
        .setLabel(`${truncate(fixture.homeTeam, 35)} goals`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Example: 3');

    const awayInput = new TextInputBuilder()
        .setCustomId('away_score')
        .setLabel(`${truncate(fixture.awayTeam, 35)} goals`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Example: 1');

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`Report #${fixture.matchNumber}`)
        .addComponents(
            new ActionRowBuilder().addComponents(homeInput),
            new ActionRowBuilder().addComponents(awayInput)
        );

    await interaction.showModal(modal);

    // ── Wait for modal submission ──
    const submitted = await interaction.awaitModalSubmit({
        time: 5 * 60 * 1000,
        filter: (modalInteraction) =>
            modalInteraction.customId === modalId &&
            modalInteraction.user.id === userId
    }).catch(() => null);

    if (!submitted) return;

    // ── Validate scores ──
    const homeScore = parseScore(submitted.fields.getTextInputValue('home_score'));
    const awayScore = parseScore(submitted.fields.getTextInputValue('away_score'));

    if (homeScore === null || awayScore === null) {
        return submitted.reply({
            content: '❌ Scores must be valid non-negative numbers.',
            ephemeral: true
        });
    }

    // ── Defer immediately before heavy processing ──
    await submitted.deferReply({ ephemeral: true });

    try {
        const result = await processFixtureReport({
            client,
            guild,
            tournament,
            fixtureId,
            homeScore,
            awayScore
        });

        // ── Confirm to user ──
        await submitted.editReply({ embeds: [result.embed] });

        // ── Refresh the report menu ──
        const updatedFixtures = await getPendingFixtures(guild.id, tournament._id, selectedGroup);

        await msg.edit({
            embeds: [buildMenuEmbed(tournament, updatedFixtures, selectedGroup, guild.id)],
            components: await buildMenuComponents(tournaments, tournament, updatedFixtures, guild.id, selectedGroup)
        }).catch(() => null);
    } catch (error) {
        console.error('[report] processing error:', error);

        await submitted.editReply({
            content: `❌ Failed to process report: ${error.message || 'Unknown error'}`,
            ephemeral: true
        }).catch(() => null);
    }
}

/* ====================================================
   RESERVE A FIXTURE — REPORT MENU BUTTON + PREFIX SHORTCUT
==================================================== */

/**
 * Prefix shortcut, in the same `.report` command:
 *   .report 12 reserved [at sunday 9pm] [reason:"rain"]
 */
async function reserveFromReport({ client, guild, args = [], actorId, reply }) {
    const parsed = await extractTournamentFromArgs(guild.id, args);

    if (parsed.explicit && parsed.error) return reply({ content: parsed.error });
    if (!parsed.tournament) return reply({ content: parsed.error || '📭 No default tournament is set.' });

    const rest = [...(parsed.rest || [])];
    const numberIndex = rest.findIndex(token => /^#?\d{1,4}$/.test(String(token)));

    if (numberIndex < 0) {
        return reply({ content: '❓ Use `.report <match number> reserved` — e.g. `.report 12 reserved`.' });
    }

    const matchNumber = Number(String(rest.splice(numberIndex, 1)[0]).replace(/^#/, ''));
    let details = rest.join(' ').trim();
    let reason = null;
    const reasonMatch = details.match(/\breason\s*[=:]\s*("[^"]*"|'[^']*'|[^\s]+)/i);

    if (reasonMatch) {
        reason = reasonMatch[1].replace(/^["']|["']$/g, '').trim();
        details = details.replace(reasonMatch[0], ' ').trim();
    }

    const timeText = details.replace(/^\s*(?:at|on)\s+/i, '').trim();

    let result;

    try {
        result = await setFixtureReserved({
            client,
            guild,
            tournament: parsed.tournament,
            matchNumber,
            timeText,
            reason,
            actorId
        });
    } catch (error) {
        console.error('[report] prefix reserve error:', error?.message || error);
        return reply({ content: '❌ Could not save the reservation. No changes were confirmed.' });
    }

    if (!result.ok) return reply({ content: `❌ ${result.error}` });

    return reply({ content: buildReservationConfirmation(result, guild.id) });
}

/** Button opens a modal so organizers can reserve any pending/live fixture. */
async function handleReserveButton({
    interaction,
    client,
    guild,
    tournament,
    msg,
    selectedGroup,
    tournaments,
    onFixtureUpdated
}) {
    const modalId = `report_reserve_${String(tournament._id).slice(-20)}_${Date.now()}`;

    const matchInput = new TextInputBuilder()
        .setCustomId('match_number')
        .setLabel('Match number')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(5)
        .setPlaceholder('Example: 12');

    const timeInput = new TextInputBuilder()
        .setCustomId('new_day')
        .setLabel('New day/time in IST (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100)
        .setPlaceholder('sunday 9pm, tomorrow 21:00, or leave blank');

    const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200)
        .setPlaceholder('Rain, no-show, venue issue…');

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle('Mark a match as reserved')
        .addComponents(
            new ActionRowBuilder().addComponents(matchInput),
            new ActionRowBuilder().addComponents(timeInput),
            new ActionRowBuilder().addComponents(reasonInput)
        );

    await interaction.showModal(modal);

    const submitted = await interaction.awaitModalSubmit({
        time: 5 * 60 * 1000,
        filter: modalInteraction =>
            modalInteraction.customId === modalId &&
            modalInteraction.user.id === interaction.user.id
    }).catch(() => null);

    if (!submitted) return;

    const rawMatchNumber = submitted.fields.getTextInputValue('match_number').trim().replace(/^#/, '');
    const matchNumber = /^\d{1,4}$/.test(rawMatchNumber) ? Number(rawMatchNumber) : null;
    const timeText = submitted.fields.getTextInputValue('new_day').trim() || null;
    const reason = submitted.fields.getTextInputValue('reason').trim() || null;

    await submitted.deferReply({ ephemeral: true });

    if (!matchNumber) {
        return submitted.editReply({ content: '❌ Enter a valid match number, such as `12`.' });
    }

    let result;

    try {
        result = await setFixtureReserved({
            client,
            guild,
            tournament,
            matchNumber,
            timeText,
            reason,
            actorId: submitted.user.id
        });
    } catch (error) {
        console.error('[report] reserve failed:', error?.message || error);
        return submitted.editReply({ content: '❌ Could not save that reservation. No changes were confirmed.' });
    }

    if (!result.ok) {
        return submitted.editReply({ content: `❌ ${result.error}` });
    }

    await submitted.editReply({ content: buildReservationConfirmation(result, guild.id) });

    try {
        const updatedFixtures = await getPendingFixtures(guild.id, tournament._id, selectedGroup);
        onFixtureUpdated?.(updatedFixtures);

        await msg.edit({
            embeds: [buildMenuEmbed(tournament, updatedFixtures, selectedGroup, guild.id)],
            components: await buildMenuComponents(tournaments, tournament, updatedFixtures, guild.id, selectedGroup)
        });
    } catch (error) {
        console.error('[report] reserve menu refresh failed:', error?.message || error);
    }
}

/** Shared by the prefix and menu flows. All facts come from the selected fixture. */
async function setFixtureReserved({ client, guild, tournament, matchNumber, timeText = null, reason = null, actorId }) {
    const matches = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        matchNumber
    }).limit(2);

    if (!matches.length) {
        return { ok: false, error: `Match #${matchNumber} was not found in ${tournament.name}.` };
    }

    if (matches.length > 1) {
        return { ok: false, error: `Match number #${matchNumber} is duplicated in ${tournament.name}; fix the fixture numbering before reserving it.` };
    }

    const fixture = matches[0];

    if (fixture.status === 'Played') {
        return { ok: false, error: `Match #${matchNumber} has already been played; it cannot be reserved.` };
    }

    const isScheduledUnplayed = !!fixture.scheduledAt && !['Played', 'Cancelled'].includes(fixture.status);
    if (!['Pending', 'Live', 'Cancelled'].includes(fixture.status) && !isScheduledUnplayed) {
        return { ok: false, error: `Match #${matchNumber} is ${String(fixture.status || 'not pending').toLowerCase()}, so it cannot be reserved.` };
    }

    let until = null;

    if (timeText) {
        const parsedTime = parseScheduleTime(timeText);

        if (!parsedTime.ok) {
            return { ok: false, error: `${parsedTime.error}. Try \`sunday 9pm\` or \`25/10 21:00\` (IST).` };
        }

        until = parsedTime.date;
    }

    const saved = await markReserved({
        client,
        guild,
        fixture,
        until,
        note: reason,
        actorId
    });

    if (!saved.ok) return saved;

    return {
        ok: true,
        fixture: saved.fixture || fixture,
        tournament,
        previousKickoff: saved.previousKickoff,
        until: saved.until,
        reason: saved.fixture?.reserved?.note || reason || null,
        releasedChannel: saved.releasedChannel,
        unlockError: saved.unlockError,
        alreadyReserved: saved.alreadyReserved
    };
}

function buildReservationConfirmation(result, guildId) {
    const fixture = result.fixture;
    const matchNumber = fixture.matchNumber;
    const lines = [
        `${slotEmoji('reserve', guildId)} **MATCH #${matchNumber} RESERVED**`,
        `**${vsLine(fixture.homeTeam, fixture.awayTeam, guildId)}**`,
        `Tournament: **${result.tournament.name}**`
    ];

    if (result.previousKickoff) {
        lines.push(`Was due: ${discordFull(result.previousKickoff)} (${discordRelative(result.previousKickoff)})`);
    }

    if (result.until) {
        lines.push(`${slotEmoji('calendar', guildId)} New day: ${discordFull(result.until)} (${discordRelative(result.until)})`);
        lines.push(`To lock a channel and set the announcement, use \`.schedule ${matchNumber} at <time> in <#channel>\`.`);
    } else {
        lines.push('New day: not decided — play it whenever you arrange it, then select it in `.report` to enter the score.');
    }

    if (result.reason) lines.push(`Reason: ${result.reason}`);
    if (result.alreadyReserved) lines.push('_Reservation details updated._');

    if (result.releasedChannel) {
        lines.push('🔓 The previously locked stadium channel is unlocked.');
    } else if (result.unlockError) {
        lines.push(`⚠️ The reservation was saved, but the old channel lock could not be released yet: ${result.unlockError}. I will retry.`);
    }

    return lines.join('\n').slice(0, 1900);
}

/* ====================================================
   PENDING FIXTURES
==================================================== */

function reportableFixtureStatusFilter() {
    return {
        $or: [
            { status: { $in: ['Pending', 'Live'] } },
            {
                scheduledAt: { $ne: null },
                status: { $nin: ['Played', 'Cancelled'] }
            }
        ]
    };
}

/**
 * Fetch unplayed fixtures, including scheduled ones, optionally filtered by group.
 */
async function getPendingFixtures(guildId, tournamentId, groupKey = null) {
    const query = {
        guildId,
        tournamentId,
        ...reportableFixtureStatusFilter()
    };

    if (groupKey && groupKey !== 'all') {
        query.groupKey = groupKey;
    }

    return Fixture.find(query)
        // Keep the report choices in match-number order, regardless of kickoff date.
        .sort({ matchNumber: 1 })
        .limit(groupKey ? GROUP_FIXTURE_LIMIT : FIXTURE_LIMIT)
        .lean();
}

/* ====================================================
   MENU UI BUILDERS
==================================================== */

/**
 * Build the report menu embed showing the tournament info and fixture list.
 */
function buildMenuEmbed(tournament, fixtures, selectedGroup = 'all', guildId = tournament.guildId || null) {
    const fixtureList = fixtures.length
        ? fixtures.map(f => {
            const badge = isReserved(f) ? ` · ${reservedBadge(f, { guildId })}` : '';

            return `#${f.matchNumber} — **${vsLine(f.homeTeam, f.awayTeam, guildId)}** (${f.roundLabel || prettyPhase(f.phase)})${badge}`;
        }).join('\n')
        : 'No unplayed reportable fixtures found.';

    return new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle('📝 REPORT MATCH')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n` +
            `Group Filter: **${selectedGroup === 'all' ? 'All Groups' : selectedGroup}**\n\n` +
            fixtureList
        )
        .setFooter({ text: `Showing ${fixtures.length} fixtures • use “Mark match reserved” if it could not be played` })
        .setTimestamp();
}

/**
 * Build the report menu components: tournament selector, group filter, fixture selector.
 * Runs a DB query for available groups.
 */
async function buildMenuComponents(tournaments, selectedTournament, fixtures, guildId, selectedGroup = 'all') {
    const rows = [];

    // ── Tournament selector ──
    rows.push(
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('report_tournament')
                .setPlaceholder('Select tournament')
                .addOptions(
                    tournaments.slice(0, 25).map(t => ({
                        label: truncate(t.name || t.tournamentKey, 80),
                        description: `Key: ${t.tournamentKey}`,
                        value: t.tournamentKey,
                        default: t.tournamentKey === selectedTournament.tournamentKey
                    }))
                )
        )
    );

    // ── Group filter (only if groups exist) ──
    const groups = (
        await Fixture.distinct('groupKey', {
            guildId,
            tournamentId: selectedTournament._id,
            groupKey: { $exists: true, $ne: null }
        })
    ).sort();

    if (groups.length) {
        rows.push(
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('report_group')
                    .setPlaceholder('Select group')
                    .addOptions([
                        {
                            label: 'All Groups',
                            value: 'all',
                            default: selectedGroup === 'all'
                        },
                        ...groups.map(group => ({
                            label: group,
                            value: group,
                            default: group === selectedGroup
                        }))
                    ])
            )
        );
    }

    // ── Reserve button (for a match that could not be played) ──
    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('report_reserve')
                .setLabel('Mark match reserved')
                .setEmoji(toDiscordEmoji(slotEmoji('reserve', guildId)) || '🛡️')
                .setStyle(ButtonStyle.Secondary)
        )
    );

    // ── Fixture selector ──
    if (fixtures.length) {
        rows.push(
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('report_fixture')
                    .setPlaceholder('Select an unplayed fixture')
                    .addOptions(
                        fixtures.slice(0, 25).map(fixture => ({
                            label: truncate(`${isReserved(fixture) ? 'RESERVED · ' : ''}#${fixture.matchNumber} ${fixture.homeTeam} vs ${fixture.awayTeam}`, 100),
                            description: truncate(fixture.roundLabel || prettyPhase(fixture.phase) || 'Unplayed fixture', 100),
                            emoji: toDiscordEmoji(slotEmoji('vs', guildId)) || undefined,
                            value: String(fixture._id)
                        }))
                    )
            )
        );
    }

    return rows;
}

/* ====================================================
   RESULT PROCESSING
==================================================== */

/**
 * Process a reported fixture result:
 * 1. Save fixture result
 * 2. Update TournamentTeam stats (if league/group stage)
 * 3. Refresh live standings, top stats, schedules, bracket
 * 4. Emit socket update
 */
async function processFixtureReport({ client, guild, tournament, fixtureId, homeScore, awayScore }) {
    const fixture = await Fixture.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        _id: fixtureId,
        ...reportableFixtureStatusFilter()
    });

    if (!fixture) {
        throw new Error('Fixture not found or already played.');
    }

    const affectsStandings = ['league', 'group'].includes(fixture.phase);

    // ── Determine winner ──
    const winner =
        homeScore > awayScore ? fixture.homeTeam
            : awayScore > homeScore ? fixture.awayTeam
                : '';

    // ── Save fixture result ──
    fixture.status = 'Played';
    fixture.result = {
        home: homeScore,
        away: awayScore,
        extraTimeHome: null,
        extraTimeAway: null,
        penaltiesHome: null,
        penaltiesAway: null,
        winner
    };
    if (fixture.reserved?.isReserved) {
        fixture.reserved.isReserved = false;
        fixture.reserved.until = null;
    }
    fixture.reportedAt = new Date();

    await fixture.save();

    // ── Update team stats ──
    if (affectsStandings) {
        await applyTournamentTeamResult({ fixture, tournament, homeScore, awayScore });
    }

    // ── Refresh live views ──
    await updateAllLiveStandings(client, guild.id).catch(console.error);
    await updateLiveTopStats(client, guild.id).catch(console.error);
    await refreshLiveMasterSchedules(client, guild.id, tournament.tournamentKey).catch(console.error);
    await refreshLiveBracket(client, guild.id, tournament.tournamentKey).catch(console.error);

    if (global.io) {
        global.io.emit('update');
    }

    // ── Build result embed ──
    const embed = new EmbedBuilder()
        .setColor(affectsStandings ? 0x2ECC71 : 0xFEBE10)
        .setTitle(affectsStandings ? '🏟️ MATCH REPORTED' : '🏆 RESULT SAVED')
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            `**${fixture.homeTeam} ${slotEmoji('goals', guild.id)} ${homeScore} - ${awayScore} ${slotEmoji('goals', guild.id)} ${fixture.awayTeam}**\n\n` +
            `🆔 Match: **#${fixture.matchNumber}**\n` +
            `🏷️ Round: **${fixture.roundLabel || prettyPhase(fixture.phase)}**\n` +
            `${fixture.groupKey ? `📦 Group: **${fixture.groupKey}**\n` : ''}` +
            `${winner ? `🥇 Winner: **${winner}**\n` : ''}` +
            `\n${affectsStandings ? '✅ Standings updated.' : 'ℹ️ Knockout result saved.'}`
        )
        .setTimestamp();

    return { fixture, embed };
}

/**
 * Apply the result to both teams' TournamentTeam stats.
 * Increments played, wins, draws, losses, GF, GA, and points.
 */
async function applyTournamentTeamResult({ fixture, tournament, homeScore, awayScore }) {
    const homeEntry = await findTournamentTeamEntry({ fixture, tournament, side: 'home' });
    const awayEntry = await findTournamentTeamEntry({ fixture, tournament, side: 'away' });

    if (!homeEntry || !awayEntry) {
        throw new Error('Tournament team entries missing for fixture.');
    }

    const homeInc = buildTeamStatIncrement({ goalsFor: homeScore, goalsAgainst: awayScore, tournament });
    const awayInc = buildTeamStatIncrement({ goalsFor: awayScore, goalsAgainst: homeScore, tournament });

    await TournamentTeam.updateOne({ _id: homeEntry._id }, { $inc: flattenTeamStatsIncrement(homeInc) });
    await TournamentTeam.updateOne({ _id: awayEntry._id }, { $inc: flattenTeamStatsIncrement(awayInc) });
}

/**
 * Find a TournamentTeam entry for a fixture side.
 * Tries tournamentTeamId → teamId → teamNameSnapshot (in order).
 */
async function findTournamentTeamEntry({ fixture, tournament, side }) {
    const tournamentTeamId = side === 'home' ? fixture.homeTournamentTeamId : fixture.awayTournamentTeamId;
    const teamId = side === 'home' ? fixture.homeTeamId : fixture.awayTeamId;
    const teamName = side === 'home' ? fixture.homeTeam : fixture.awayTeam;

    if (tournamentTeamId) {
        const byTTId = await TournamentTeam.findOne({
            _id: tournamentTeamId,
            guildId: fixture.guildId,
            tournamentId: tournament._id
        });
        if (byTTId) return byTTId;
    }

    if (teamId) {
        const byTeamId = await TournamentTeam.findOne({
            guildId: fixture.guildId,
            tournamentId: tournament._id,
            teamId
        });
        if (byTeamId) return byTeamId;
    }

    return TournamentTeam.findOne({
        guildId: fixture.guildId,
        tournamentId: tournament._id,
        teamNameSnapshot: teamName
    });
}

/**
 * Build stat increment object for a team result.
 * Points come from tournament config (pointsWin, pointsDraw, pointsLoss).
 */
function buildTeamStatIncrement({ goalsFor, goalsAgainst, tournament }) {
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let points = 0;

    if (goalsFor > goalsAgainst) {
        wins = 1;
        points = tournament.pointsWin ?? 3;
    } else if (goalsFor < goalsAgainst) {
        losses = 1;
        points = tournament.pointsLoss ?? 0;
    } else {
        draws = 1;
        points = tournament.pointsDraw ?? 1;
    }

    return { played: 1, wins, draws, losses, gf: goalsFor, ga: goalsAgainst, points };
}

/**
 * Flatten a stat increment object into MongoDB dot-notation for $inc.
 */
function flattenTeamStatsIncrement(stats) {
    return {
        'stats.played': stats.played,
        'stats.wins': stats.wins,
        'stats.draws': stats.draws,
        'stats.losses': stats.losses,
        'stats.gf': stats.gf,
        'stats.ga': stats.ga,
        'stats.points': stats.points
    };
}

/* ====================================================
   UTILITY HELPERS
==================================================== */

/**
 * Parse a score input string. Returns null for invalid values.
 */
function toDiscordEmoji(ref) {
    const match = String(ref || '').match(/^<(a?):([a-zA-Z0-9_]+):(\d+)>$/);

    if (match) return { name: match[2], id: match[3], animated: match[1] === 'a' };
    return ref || null;
}

function parseScore(value) {
    const clean = String(value || '').trim();

    if (!/^\d+$/.test(clean)) return null;

    const number = Number(clean);
    if (!Number.isInteger(number) || number < 0) return null;

    return number;
}

/**
 * Truncate text to max characters with ellipsis.
 */
function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 3) + '...' : value;
}
