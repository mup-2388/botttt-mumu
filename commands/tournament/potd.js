'use strict';

const {
    SlashCommandBuilder,
    ChannelType
} = require('discord.js');

const {
    ServerConfig,
    Player,
    TournamentPlayer,
    Team
} = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament } = require('../../utils/getTournament');
const { parseStats, renderPotdCard } = require('../../utils/potdCard');

const USAGE = [
    '**POTD commands**',
    '`.potd channel #potd` — choose the channel for cards',
    '`.potd post @player 2 Goals, 1 Assist, 4 Shots | Match 02` — post a card',
    'Slash: `/potd channel` and `/potd post`'
].join('\n');

function isGuildTextChannel(channel) {
    return Boolean(
        channel &&
        channel.guild &&
        typeof channel.send === 'function' &&
        typeof channel.isTextBased === 'function' &&
        channel.isTextBased()
    );
}

function formatIstDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.day} ${String(values.month || '').toUpperCase()} ${values.year}`.trim();
}

function parsePrefixPostArgs(message, args) {
    const user = message.mentions?.users?.first?.();
    if (!user) return { error: 'Mention the player whose POTD card you want to post.' };

    let remainder = args.slice(1).join(' ');
    const mentionPattern = new RegExp(`<@!?${String(user.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'g');
    remainder = remainder.replace(mentionPattern, '').trim();

    let statsText = remainder;
    let matchLabel = '';
    if (remainder.includes('|')) {
        const divider = remainder.indexOf('|');
        statsText = remainder.slice(0, divider).trim();
        matchLabel = remainder.slice(divider + 1).trim();
    }
    statsText = statsText.replace(/^(?:stats?\s*[=:]\s*)/i, '').replace(/^["']|["']$/g, '').trim();
    matchLabel = matchLabel.replace(/^(?:match\s*[=:]\s*)/i, '').replace(/^["']|["']$/g, '').trim();

    return { user, statsText, matchLabel };
}

async function safeReply(reply, payload) {
    try {
        return await reply(payload);
    } catch (error) {
        console.warn('[potd] Could not send command confirmation:', error?.message || error);
        return null;
    }
}

module.exports = {
    name: 'potd',
    description: 'Set the POTD channel and post an original-template Player of the Day card.',
    usage: USAGE,
    aliases: [],
    hidden: false,
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('potd')
        .setDescription('Set the POTD channel and post a Player of the Day card')
        .addSubcommand(sub =>
            sub.setName('channel')
                .setDescription('Set the channel where POTD cards are posted')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Text channel for POTD cards')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('post')
                .setDescription('Post a player card with organizer-provided match stats')
                .addUserOption(option =>
                    option.setName('player')
                        .setDescription('Player of the Day')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('stats')
                        .setDescription('One to three stats, e.g. 2 Goals, 1 Assist, 4 Shots')
                        .setMaxLength(120)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('match')
                        .setDescription('Optional match label, e.g. Match 02')
                        .setMaxLength(32)
                        .setRequired(false)
                )
        ),

    async execute(message, args = []) {
        if (!message.guild) return;

        try {
            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Only organizers can manage POTD cards.');
            }

            const subcommand = String(args[0] || '').toLowerCase();
            if (!subcommand || subcommand === 'help') return message.reply(USAGE);

            if (subcommand === 'channel') {
                const channel = message.mentions?.channels?.first?.()
                    || (args[1] ? message.guild.channels.cache?.get?.(args[1].replace(/[<#>]/g, '')) : null);
                if (!channel) return message.reply('Choose a text channel, e.g. `.potd channel #potd`.');
                return await runSetChannel({
                    guild: message.guild,
                    channel,
                    reply: payload => message.reply(payload)
                });
            }

            if (subcommand === 'post') {
                const parsed = parsePrefixPostArgs(message, args);
                if (parsed.error) return message.reply(parsed.error);
                return await runPost({
                    guild: message.guild,
                    user: parsed.user,
                    statsText: parsed.statsText,
                    matchLabel: parsed.matchLabel,
                    reply: payload => message.reply(payload)
                });
            }

            return message.reply(USAGE);
        } catch (error) {
            console.error('[potd] prefix error:', error);
            return safeReply(message.reply.bind(message), '❌ Could not prepare the POTD command. No card was posted.');
        }
    },

    async slashExecute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'POTD commands are only available in a server.', ephemeral: true });
        }

        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Only organizers can manage POTD cards.', ephemeral: true });
            }

            const subcommand = interaction.options.getSubcommand();
            await interaction.deferReply({ ephemeral: true });

            if (subcommand === 'channel') {
                const channel = interaction.options.getChannel('channel');
                return await runSetChannel({
                    guild: interaction.guild,
                    channel,
                    reply: payload => interaction.editReply(payload)
                });
            }

            if (subcommand === 'post') {
                return await runPost({
                    guild: interaction.guild,
                    user: interaction.options.getUser('player'),
                    statsText: interaction.options.getString('stats'),
                    matchLabel: interaction.options.getString('match') || '',
                    reply: payload => interaction.editReply(payload)
                });
            }

            return safeReply(payload => interaction.editReply(payload), USAGE);
        } catch (error) {
            console.error('[potd] slash error:', error);
            const reply = payload => interaction.editReply(payload);
            if (interaction.deferred || interaction.replied) {
                return safeReply(reply, '❌ Could not prepare the POTD command. No card was posted.');
            }
            return safeReply(payload => interaction.reply({ ...payload, ephemeral: true }), {
                content: '❌ Could not prepare the POTD command. No card was posted.'
            });
        }
    }
};

async function runSetChannel({ guild, channel, reply }) {
    if (!isGuildTextChannel(channel) || channel.guild.id !== guild.id) {
        return safeReply(reply, '❌ Choose a text channel in this server.');
    }

    await ServerConfig.findOneAndUpdate(
        { guildId: guild.id },
        { $set: { potdChannelId: channel.id } },
        { upsert: true, new: true }
    );

    return safeReply(reply, {
        content: `✅ POTD cards will be posted in <#${channel.id}>.`,
        allowedMentions: { parse: [] }
    });
}

async function runPost({ guild, user, statsText, matchLabel, reply }) {
    if (!user) return safeReply(reply, '❌ Select or mention a player.');

    let stats;
    try {
        stats = parseStats(statsText);
    } catch (error) {
        return safeReply(reply, `❌ ${error.message}`);
    }

    const config = await ServerConfig.findOne({ guildId: guild.id }).lean();
    if (!config?.potdChannelId) {
        return safeReply(reply, '❌ POTD channel is not set. Run `/potd channel` or `.potd channel #channel` first.');
    }

    const selectedTournament = await resolveTournament(guild.id);
    if (!selectedTournament?.tournament) {
        return safeReply(reply, selectedTournament?.error || '❌ No default tournament is available.');
    }

    const player = await Player.findOne({ guildId: guild.id, discordID: String(user.id) }).lean();
    if (!player) {
        return safeReply(reply, '❌ That Discord user is not linked to a player in this server.');
    }

    const roster = await TournamentPlayer.findOne({
        guildId: guild.id,
        tournamentId: selectedTournament.tournament._id,
        playerId: player._id,
        isActive: true
    }).lean();
    if (!roster) {
        return safeReply(reply, `❌ That player is not on an active roster in the default tournament, **${selectedTournament.tournament.name}**.`);
    }

    let teamName = String(roster.teamNameSnapshot || player.teamNameSnapshot || '').trim();
    if (!teamName && roster.teamId) {
        const team = await Team.findOne({ guildId: guild.id, _id: roster.teamId }).lean();
        teamName = String(team?.name || '').trim();
    }
    if (!teamName) {
        return safeReply(reply, '❌ The player has no team name in the default tournament roster.');
    }

    let channel;
    try {
        channel = await guild.channels.fetch(config.potdChannelId);
    } catch (error) {
        channel = null;
    }
    if (!isGuildTextChannel(channel) || channel.guild.id !== guild.id) {
        return safeReply(reply, '❌ The saved POTD channel is unavailable or is not a text channel. Set it again with `/potd channel`.');
    }

    let member = null;
    try {
        member = await guild.members.fetch(user.id);
    } catch (error) {
        // The linked player record is authoritative; use the Discord user's avatar as a fallback.
    }

    const playerName = String(roster.playerNameSnapshot || player.name || member?.displayName || user.username || 'PLAYER').trim();
    const avatarUrl = member?.displayAvatarURL?.({ extension: 'png', size: 512 })
        || user.displayAvatarURL?.({ extension: 'png', size: 512 })
        || '';
    const safeMatchLabel = String(matchLabel || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 32);
    const dateText = formatIstDate(new Date());

    let image;
    try {
        image = await renderPotdCard({
            playerName,
            teamName,
            avatarUrl,
            stats,
            matchLabel: safeMatchLabel,
            dateText
        });
    } catch (error) {
        console.error('[potd] card rendering failed:', error);
        return safeReply(reply, `❌ ${error.message || 'The POTD card could not be rendered.'}`);
    }

    const filename = `potd-${playerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'player'}.png`;
    const caption = `🏅 **PLAYER OF THE DAY** — **${playerName}** · **${teamName}**`;
    try {
        await channel.send({
            content: caption,
            files: [{ attachment: image, name: filename }],
            allowedMentions: { parse: [] }
        });
    } catch (error) {
        console.error('[potd] card send failed:', error);
        return safeReply(reply, '⚠️ Discord did not confirm the POTD post. Check the channel before retrying.');
    }

    return safeReply(reply, {
        content: `✅ Posted the POTD card for **${playerName}** in <#${channel.id}>.`,
        allowedMentions: { parse: [] }
    });
}

module.exports.parsePrefixPostArgs = parsePrefixPostArgs;
module.exports.formatIstDate = formatIstDate;
module.exports.runSetChannel = runSetChannel;
module.exports.runPost = runPost;
