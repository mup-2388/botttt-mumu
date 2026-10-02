/**
 * postmatchday.js
 *
 * Publish the earliest matchday that still has unplayed fixtures. This command
 * only reads tournament/team/fixture data; it does not schedule matches, lock
 * channels, or update fixture records.
 *
 * Usage:  .postmatchday <deadline>
 * Slash:  /postmatchday deadline:<text>
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    escapeMarkdown
} = require('discord.js');

const {
    Fixture,
    Team,
    ServerConfig
} = require('../../models/Tournament');
const { getDefaultTournament } = require('../../utils/getTournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const {
    FIXTURES_ROLE_ID,
    UNALDO_USER_ID,
    AASHANK_USER_ID,
    DISCORD_MESSAGE_LIMIT,
    LINE_REPEAT_COUNT,
    selectNextMatchday,
    sanitizeDeadline,
    formatMatchdayAnnouncement
} = require('../../utils/matchdayAnnouncement');

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const MAX_DEADLINE_LENGTH = 100;
const DISCORD_ID_RE = /^\d{15,22}$/;

module.exports = {
    name: 'postmatchday',
    description: 'Post the next unplayed matchday fixtures to the default fixtures channel.',
    usage: '.postmatchday <deadline>',
    aliases: [],
    hidden: false,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('postmatchday')
        .setDescription('Post the next unplayed matchday fixtures')
        .addStringOption(option =>
            option.setName('deadline')
                .setDescription('Deadline to show in the announcement')
                .setRequired(true)
                .setMaxLength(MAX_DEADLINE_LENGTH)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const deadline = sanitizeDeadline(args.join(' '));
            if (!deadline) {
                return message.reply('❓ Usage: `.postmatchday <deadline>` (example: `.postmatchday Friday 8 PM`).');
            }

            if (deadline.length > MAX_DEADLINE_LENGTH) {
                return message.reply(`❌ Keep the deadline under ${MAX_DEADLINE_LENGTH} characters.`);
            }

            return await runPostMatchday({
                guild: message.guild,
                deadline,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[postmatchday] prefix error:', error);
            return message.reply('❌ Failed to post the matchday announcement.');
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

            const deadline = sanitizeDeadline(interaction.options.getString('deadline'));
            if (!deadline) {
                return interaction.editReply('❓ Please provide a deadline for the announcement.');
            }

            return await runPostMatchday({
                guild: interaction.guild,
                deadline,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[postmatchday] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to post the matchday announcement.');
            }

            return interaction.reply({
                content: '❌ Failed to post the matchday announcement.',
                ephemeral: true
            });
        }
    }
};

async function runPostMatchday({
    guild,
    deadline,
    reply,
    testMode = false,
    targetChannel = null
}) {
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
        status: { $nin: ['Played', 'Cancelled'] }
    })
        .select('roundLabel status matchNumber homeTeam awayTeam')
        .sort({ matchNumber: 1 })
        .lean();

    const nextMatchday = selectNextMatchday(fixtures);
    if (!nextMatchday) {
        return reply({
            content: `📭 No unplayed Matchday fixtures were found for **${tournament.name}**.`
        });
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

    // Refresh the channel cache so saved stadium names can resolve to real
    // channel IDs even if the channels were not cached when the bot started.
    await guild.channels.fetch().catch(() => null);

    const teams = await Team.find({ guildId: guild.id })
        .select('name stadium captainID')
        .lean();
    const teamByName = new Map(
        teams.map(team => [normalizeName(team.name), team])
    );

    const unresolvedStadiums = [];
    const roleIds = new Set(testMode ? [] : [FIXTURES_ROLE_ID]);
    const userIds = new Set(testMode ? [] : [UNALDO_USER_ID, AASHANK_USER_ID]);
    const formattedFixtures = [];
    const teamRoles = testMode ? [] : Array.from(guild.roles.cache.values());

    for (const fixture of nextMatchday.fixtures) {
        const homeTeam = teamByName.get(normalizeName(fixture.homeTeam));
        const stadium = await resolveStadiumChannel(guild, homeTeam?.stadium);

        if (!stadium.channel) {
            unresolvedStadiums.push(
                `• **${safeDisplayText(fixture.homeTeam || 'Unknown home team')}** — ${safeDisplayText(stadium.error)}`
            );
            continue;
        }

        const awayTeam = teamByName.get(normalizeName(fixture.awayTeam));
        const homeMention = testMode
            ? fixture.homeTeam
            : resolveTeamMention({
                teamName: fixture.homeTeam,
                team: homeTeam,
                teamRoles,
                roleIds,
                userIds,
                botCanMentionRoles
            });
        const awayMention = testMode
            ? fixture.awayTeam
            : resolveTeamMention({
                teamName: fixture.awayTeam,
                team: awayTeam,
                teamRoles,
                roleIds,
                userIds,
                botCanMentionRoles
            });

        formattedFixtures.push({
            ...fixture,
            homeMention,
            awayMention,
            stadiumChannelId: stadium.channel.id
        });
    }

    if (unresolvedStadiums.length) {
        return reply({
            content: '❌ I could not resolve every home team’s saved stadium to one text channel. No announcement was sent.\n' +
                unresolvedStadiums.join('\n') +
                '\nUpdate the team stadium to a channel mention/ID or an exact channel name, then retry.'
        });
    }

    let lineRepeatCount = LINE_REPEAT_COUNT;
    let content = formatMatchdayAnnouncement({
        matchdayNumber: nextMatchday.matchdayNumber,
        fixtures: formattedFixtures,
        deadline,
        guildId: guild.id,
        lineRepeatCount,
        includePings: !testMode
    });

    // Keep the requested long divider for ordinary matchdays, reducing only
    // its repetitions if needed to stay within Discord's 2,000-character cap.
    while (content.length > DISCORD_MESSAGE_LIMIT && lineRepeatCount > 1) {
        lineRepeatCount -= 1;
        content = formatMatchdayAnnouncement({
            matchdayNumber: nextMatchday.matchdayNumber,
            fixtures: formattedFixtures,
            deadline,
            guildId: guild.id,
            lineRepeatCount,
            includePings: !testMode
        });
    }

    if (content.length > DISCORD_MESSAGE_LIMIT) {
        return reply({
            content: `❌ This matchday announcement is ${content.length} characters, over Discord’s ${DISCORD_MESSAGE_LIMIT}-character message limit. No announcement was sent.`
        });
    }

    if (channelPermissions && !channelPermissions.has(PermissionFlagsBits.SendMessages)) {
        return reply({ content: '❌ I cannot send messages in the saved fixtures channel. No announcement was sent.' });
    }

    try {
        await destination.send({
            content,
            allowedMentions: {
                parse: [],
                roles: [...roleIds],
                users: [...userIds],
                repliedUser: false
            }
        });
    } catch (error) {
        console.error('[postmatchday] destination send failed:', error);
        return reply({ content: '❌ I could not post in the saved fixtures channel. Check my channel and role-mention permissions.' });
    }

    return reply({
        content: testMode
            ? `🧪 Test announcement for **Matchday ${nextMatchday.matchdayNumber}** posted in <#${destination.id}>. No user or role pings were sent.`
            : `✅ Posted **Matchday ${nextMatchday.matchdayNumber}** for **${tournament.name}** in <#${destination.id}>.`
    });
}

function isTestDestinationChannel(channel, guildId) {
    const belongsToGuild = String(channel?.guildId || channel?.guild?.id || '') === String(guildId);
    const isThread = typeof channel?.isThread === 'function' && channel.isThread();
    const canSendText = TEXT_CHANNEL_TYPES.includes(channel?.type) || isThread;

    return belongsToGuild && canSendText && typeof channel.send === 'function';
}

function isSupportedTextChannel(channel, guildId) {
    return !!channel &&
        String(channel.guildId || channel.guild?.id || '') === String(guildId) &&
        TEXT_CHANNEL_TYPES.includes(channel.type);
}

async function resolveStadiumChannel(guild, savedValue) {
    const value = String(savedValue || '').trim();
    if (!value) return { channel: null, error: 'no stadium is set' };

    const mention = value.match(/<#(\d{15,22})>/);
    const rawId = mention?.[1] || (DISCORD_ID_RE.test(value) ? value : null);

    if (rawId) {
        const channel = guild.channels.cache.get(rawId) ||
            await guild.channels.fetch(rawId).catch(() => null);

        if (!isSupportedTextChannel(channel, guild.id)) {
            return { channel: null, error: 'the saved channel mention/ID is missing or not a text channel' };
        }

        return { channel };
    }

    const channelName = normalizeName(value.replace(/^#/, ''));
    const matches = Array.from(guild.channels.cache.values()).filter(channel =>
        isSupportedTextChannel(channel, guild.id) &&
        normalizeName(channel.name) === channelName
    );

    if (matches.length === 1) return { channel: matches[0] };
    if (matches.length > 1) {
        return { channel: null, error: 'the saved channel name is ambiguous; save its channel mention instead' };
    }

    return { channel: null, error: `channel “${safeDisplayText(value)}” was not found` };
}

function resolveTeamMention({
    teamName,
    team,
    teamRoles,
    roleIds,
    userIds,
    botCanMentionRoles
}) {
    const role = teamRoles.find(candidate =>
        normalizeName(candidate.name) === normalizeName(teamName)
    );

    if (role && (role.mentionable || botCanMentionRoles)) {
        roleIds.add(String(role.id));
        return `<@&${role.id}>`;
    }

    const captainId = String(team?.captainID || '');
    if (DISCORD_ID_RE.test(captainId)) {
        userIds.add(captainId);
        return `<@${captainId}>`;
    }

    return `**${escapeMarkdown(String(teamName || 'Unknown team'))}**`;
}

function normalizeName(value) {
    return String(value || '').trim().normalize('NFKC').toLocaleLowerCase();
}

function safeDisplayText(value) {
    const neutralized = String(value || '')
        .replace(/@/g, '@\u200b')
        .replace(/</g, '‹')
        .replace(/>/g, '›');
    return escapeMarkdown(neutralized);
}

module.exports.runPostMatchday = runPostMatchday;
module.exports.isSupportedTextChannel = isSupportedTextChannel;
module.exports.resolveStadiumChannel = resolveStadiumChannel;
module.exports.resolveTeamMention = resolveTeamMention;
module.exports.normalizeName = normalizeName;
