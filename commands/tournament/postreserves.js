/**
 * postreserves.js
 *
 * Publish every currently reserved fixture for the default tournament to the
 * configured fixtures channel. Reserved matches are announced separately from
 * normal matchdays and are paginated to fit Discord's message limit.
 *
 * Usage: .postreserves
 * Slash: /postreserves
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    escapeMarkdown
} = require('discord.js');

const { Fixture, Team, ServerConfig } = require('../../models/Tournament');
const { getDefaultTournament } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { vsLine } = require('../../utils/ai/emojiSlots');
const {
    FIXTURES_ROLE_ID,
    UNALDO_USER_ID,
    AASHANK_USER_ID,
    DISCORD_MESSAGE_LIMIT
} = require('../../utils/matchdayAnnouncement');
const {
    isSupportedTextChannel,
    resolveStadiumChannel,
    resolveTeamMention,
    normalizeName
} = require('./postmatchday');

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

module.exports = {
    name: 'postreserves',
    description: 'Announce all reserved fixtures in the default fixtures channel.',
    usage: '.postreserves',
    aliases: ['postreserved', 'postreserve'],
    hidden: false,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('postreserves')
        .setDescription('Announce reserved fixtures in the default fixtures channel'),

    async execute(message) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            return await runPostReserves({
                guild: message.guild,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[postreserves] prefix error:', error);
            return message.reply('❌ Failed to post the reserved-fixture announcement.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
            }

            if (!(await isOrganizer(interaction.guild, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runPostReserves({
                guild: interaction.guild,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[postreserves] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to post the reserved-fixture announcement.');
            }

            return interaction.reply({
                content: '❌ Failed to post the reserved-fixture announcement.',
                ephemeral: true
            });
        }
    }
};

async function runPostReserves({ guild, reply, testMode = false, targetChannel = null }) {
    let destination = targetChannel;

    if (testMode) {
        if (!isTestDestinationChannel(destination, guild.id)) {
            return reply({ content: '❌ The test command must be used in a server text channel.' });
        }
    } else {
        const config = await ServerConfig.findOne({ guildId: guild.id }).lean();
        if (!config?.defaultFixturesChannelId) {
            return reply({
                content: '❌ No default fixtures channel is set. Run `.setfixtureschannel` in the announcement channel first.'
            });
        }

        destination = await guild.channels.fetch(String(config.defaultFixturesChannelId)).catch(() => null);
        if (!isSupportedTextChannel(destination, guild.id)) {
            return reply({
                content: '❌ The saved fixtures channel is missing or is not a regular text channel. Run `.setfixtureschannel` again.'
            });
        }
    }

    const tournament = await getDefaultTournament(guild.id);
    if (!tournament) {
        return reply({
            content: '❌ No default tournament is available. Set the server’s default tournament, then try again.'
        });
    }

    const fixtures = await Fixture.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        'reserved.isReserved': true,
        status: { $in: ['Pending', 'Live'] }
    })
        .select('matchNumber roundLabel homeTeam awayTeam status venueName reserved.isReserved reserved.note')
        .sort({ matchNumber: 1 })
        .lean();

    if (!fixtures.length) {
        return reply({ content: `📭 No reserved matches were found for **${tournament.name}**.` });
    }

    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const channelPermissions = botMember
        ? (botMember.permissionsIn?.(destination) || destination.permissionsFor?.(botMember) || null)
        : null;
    const botCanMentionRoles = Boolean(channelPermissions?.has(PermissionFlagsBits.MentionEveryone));

    if (!testMode) {
        await guild.roles.fetch().catch(() => null);
        const fixturesRole = guild.roles.cache.get(FIXTURES_ROLE_ID) ||
            await guild.roles.fetch(FIXTURES_ROLE_ID).catch(() => null);

        if (!fixturesRole) {
            return reply({
                content: `❌ The HFSL fixtures role (ID ${FIXTURES_ROLE_ID}) could not be found in this server. No announcement was sent.`
            });
        }

        if (!fixturesRole.mentionable && !botCanMentionRoles) {
            return reply({
                content: '❌ The bot cannot ping the HFSL fixtures role. Make the role mentionable or grant the bot the “Mention @everyone, @here, and All Roles” permission. No announcement was sent.'
            });
        }
    }

    const destinationIsThread = typeof destination.isThread === 'function' && destination.isThread();
    const sendPermission = destinationIsThread
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
    if (channelPermissions && !channelPermissions.has(sendPermission)) {
        return reply({ content: '❌ I cannot send messages in the fixtures channel. No announcement was sent.' });
    }

    // Refresh channels so team stadiums resolve even if they were not cached at startup.
    await guild.channels.fetch().catch(() => null);

    const teams = await Team.find({ guildId: guild.id })
        .select('name stadium captainID')
        .lean();
    const teamByName = new Map(teams.map(team => [normalizeName(team.name), team]));
    const teamRoles = testMode ? [] : Array.from(guild.roles.cache.values());
    const preparedFixtures = [];

    for (const fixture of fixtures) {
        const homeTeam = teamByName.get(normalizeName(fixture.homeTeam));
        const awayTeam = teamByName.get(normalizeName(fixture.awayTeam));
        const roleIds = new Set();
        const userIds = new Set();
        const homeMention = testMode
            ? safeDisplayText(fixture.homeTeam)
            : resolveTeamMention({
                teamName: fixture.homeTeam,
                team: homeTeam,
                teamRoles,
                roleIds,
                userIds,
                botCanMentionRoles
            });
        const awayMention = testMode
            ? safeDisplayText(fixture.awayTeam)
            : resolveTeamMention({
                teamName: fixture.awayTeam,
                team: awayTeam,
                teamRoles,
                roleIds,
                userIds,
                botCanMentionRoles
            });

        const stadium = homeTeam?.stadium
            ? await resolveStadiumChannel(guild, homeTeam.stadium)
            : { channel: null };
        const venue = stadium?.channel?.id
            ? `<#${stadium.channel.id}>`
            : safeDisplayText(fixture.venueName || homeTeam?.stadium || 'Stadium not set');

        preparedFixtures.push({
            fixture,
            roleIds: [...roleIds],
            userIds: [...userIds],
            block: formatReservedFixture({
                fixture,
                homeMention,
                awayMention,
                venue,
                guildId: guild.id
            })
        });
    }

    const pages = paginateReservedFixtures({
        preparedFixtures,
        tournament,
        includePings: !testMode
    });

    if (pages.error) {
        return reply({ content: `❌ ${pages.error} No announcement was sent.` });
    }

    let sentCount = 0;
    for (const [index, page] of pages.entries()) {
        const roleIds = new Set(index === 0 && !testMode ? [FIXTURES_ROLE_ID] : []);
        const userIds = new Set(index === 0 && !testMode ? [UNALDO_USER_ID, AASHANK_USER_ID] : []);

        for (const item of page.items) {
            for (const id of item.roleIds) roleIds.add(id);
            for (const id of item.userIds) userIds.add(id);
        }

        const payload = {
            content: page.content,
            allowedMentions: {
                parse: [],
                roles: [...roleIds],
                users: [...userIds],
                repliedUser: false
            }
        };

        try {
            await destination.send(payload);
            sentCount++;
        } catch (error) {
            console.error('[postreserves] destination send failed:', error);
            return reply({
                content: sentCount
                    ? `⚠️ Posted ${sentCount} of ${pages.length} reserved-fixture announcement messages before a send failed. Check permissions and rerun if needed.`
                    : '❌ I could not post in the saved fixtures channel. Check my channel and role-mention permissions.'
            });
        }
    }

    const fixtureCount = `${fixtures.length} reserved match${fixtures.length === 1 ? '' : 'es'}`;

    return reply({
        content: testMode
            ? `🧪 Test announcement for **${fixtureCount}** posted in <#${destination.id}> (${pages.length} message${pages.length === 1 ? '' : 's'}). No user or role pings were sent.`
            : `✅ Posted **${fixtureCount}** for **${tournament.name}** in <#${destination.id}> (${pages.length} message${pages.length === 1 ? '' : 's'}).`
    });
}

function formatReservedFixture({ fixture, homeMention, awayMention, venue, guildId }) {
    const reasonLine = fixture.reserved?.note
        ? `Reason: ${safeDisplayText(fixture.reserved.note).slice(0, 180)}`
        : null;

    const matchTitle = `__Match #${fixture.matchNumber}__${fixture.roundLabel ? ` · ${safeDisplayText(fixture.roundLabel)}` : ''}`;

    return [
        matchTitle,
        vsLine(homeMention, awayMention, guildId),
        `🏟️ ${venue}`,
        reasonLine
    ].filter(Boolean).join('\n');
}

function paginateReservedFixtures({ preparedFixtures, tournament, includePings }) {
    const globalMentions = includePings
        ? `<@&${FIXTURES_ROLE_ID}>\n\nQuestions? <@${UNALDO_USER_ID}> <@${AASHANK_USER_ID}>\n\n`
        : '';
    const placeholderHeader = buildReservedHeader(tournament, '999/999', preparedFixtures.length);
    const bodyLimit = DISCORD_MESSAGE_LIMIT - globalMentions.length - placeholderHeader.length - 2;

    if (bodyLimit < 1) return { error: 'The reserved announcement header is too long.' };

    const groups = [];
    let current = [];
    let currentLength = 0;

    for (const item of preparedFixtures) {
        const nextLength = currentLength + (current.length ? 2 : 0) + item.block.length;
        if (current.length && nextLength > bodyLimit) {
            groups.push(current);
            current = [];
            currentLength = 0;
        }

        if (item.block.length > bodyLimit) {
            return { error: `Match #${item.fixture.matchNumber} has too much announcement text to fit in one Discord message.` };
        }

        current.push(item);
        currentLength += (current.length > 1 ? 2 : 0) + item.block.length;
    }

    if (current.length) groups.push(current);

    const pages = groups.map((items, index) => {
        const header = buildReservedHeader(tournament, `${index + 1}/${groups.length}`, preparedFixtures.length);
        const prefix = includePings && index === 0 ? globalMentions : '';
        const content = `${prefix}${header}\n\n${items.map(item => item.block).join('\n\n')}`;

        return { items, content };
    });

    if (pages.some(page => page.content.length > DISCORD_MESSAGE_LIMIT)) {
        return { error: 'The reserved announcement could not be split under Discord’s message limit.' };
    }

    return pages;
}

function buildReservedHeader(tournament, page, count) {
    return [
        `# 🛡️ RESERVED MATCHES — ${safeDisplayText(tournament.name)}`,
        `Page ${page} · ${count} reserved fixture${count === 1 ? '' : 's'}`
    ].join('\n');
}

function isTestDestinationChannel(channel, guildId) {
    const belongsToGuild = String(channel?.guildId || channel?.guild?.id || '') === String(guildId);
    const isThread = typeof channel?.isThread === 'function' && channel.isThread();
    const canSendText = TEXT_CHANNEL_TYPES.includes(channel?.type) || isThread;

    return belongsToGuild && canSendText && typeof channel.send === 'function';
}

function safeDisplayText(value) {
    const neutralized = String(value || 'Unknown')
        .replace(/[\r\n]+/g, ' ')
        .replace(/@/g, '@\u200b')
        .replace(/</g, '‹')
        .replace(/>/g, '›');
    return escapeMarkdown(neutralized);
}

module.exports.runPostReserves = runPostReserves;
module.exports.formatReservedFixture = formatReservedFixture;
module.exports.paginateReservedFixtures = paginateReservedFixtures;
module.exports.isTestDestinationChannel = isTestDestinationChannel;
