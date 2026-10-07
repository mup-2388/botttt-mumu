/**
 * removemvp.js
 *
 * Remove exactly one MVP from every distinct player ID/user mention supplied
 * directly or found in the message being replied to.
 *
 * Usage:  .removemvp [tournamentKey/eventKey] [@user or ID ...]
 *         Reply to a message containing user mentions/IDs with .removemvp [key]
 * Slash:  /removemvp [key] players:<mentions or IDs>
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    escapeMarkdown
} = require('discord.js');

const {
    Player,
    TournamentPlayer,
    EventPlayer,
    UserProfile
} = require('../../models/Tournament');
const {
    getDefaultTournament,
    getTournamentByKey
} = require('../../utils/getTournament');
const { getEventByKey, getEventByChannel } = require('../../utils/getEvent');
const { updateLiveTopStats } = require('../../utils/updateTopStats');
const { isOrganizer } = require('../../utils/isOrganizer');

const DISCORD_ID_RE = /^\d{17,20}$/;
const DETAIL_LIMIT = 20;

module.exports = {
    name: 'removemvp',
    description: 'Remove one MVP from each mentioned or listed player.',
    usage: '.removemvp [key] [@user or ID ...] (or reply to a message containing IDs/tags)',
    aliases: ['rmvp'],
    hidden: false,
    cooldown: 3,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('removemvp')
        .setDescription('Remove one MVP from each listed player')
        .addStringOption(option =>
            option.setName('key')
                .setDescription('Optional tournament or event key')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('players')
                .setDescription('User mentions or Discord IDs')
                .setRequired(false)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const firstArgContainsUserId = extractUserIds(args[0] || '').length > 0;
            const possibleKey = firstArgContainsUserId ? null : (args[0]?.toLowerCase() || null);
            const target = await resolveTarget({
                guild: message.guild,
                channelId: message.channel.id,
                key: possibleKey
            });

            if (!target) {
                return message.reply(
                    '❌ No tournament or event found. Set a default tournament, bind an event with `.setevent <key>`, or provide a valid key.'
                );
            }

            const userIds = await getUserIdsFromPrefix(
                message,
                args,
                target.explicitKey
            );

            if (!userIds.length) {
                return message.reply(
                    '❓ Provide user mentions/IDs or reply to a message containing them. Example: `.removemvp @user1 @user2`.'
                );
            }

            return await runRemoveMvp({
                client: message.client,
                guild: message.guild,
                target,
                userIds,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[removemvp] prefix error:', error);
            return message.reply('❌ Failed to remove MVP(s).');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({
                    content: '❌ This command can only be used in a server.',
                    ephemeral: true
                });
            }

            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const key = interaction.options.getString('key')?.toLowerCase() || null;
            const userIds = extractUserIds(interaction.options.getString('players') || '');
            if (!userIds.length) {
                return interaction.editReply('❓ Provide at least one user mention or Discord ID.');
            }

            const target = await resolveTarget({
                guild: interaction.guild,
                channelId: interaction.channel.id,
                key
            });

            if (!target) {
                return interaction.editReply('❌ No tournament or event found for that key/default.');
            }

            return await runRemoveMvp({
                client: interaction.client,
                guild: interaction.guild,
                target,
                userIds,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[removemvp] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to remove MVP(s).');
            }

            return interaction.reply({
                content: '❌ Failed to remove MVP(s).',
                ephemeral: true
            });
        }
    }
};

async function resolveTarget({ guild, channelId, key }) {
    if (key) {
        const [tournament, event] = await Promise.all([
            getTournamentByKey(guild.id, key, { includeCompleted: true }),
            getEventByKey(guild.id, key)
        ]);

        if (tournament?.tournamentKey === key) {
            return { type: 'tournament', doc: tournament, explicitKey: true };
        }
        if (event?.eventKey === key) {
            return { type: 'event', doc: event, explicitKey: true };
        }

        return null;
    }

    const boundEvent = await getEventByChannel(guild.id, channelId);
    if (boundEvent) {
        return { type: 'event', doc: boundEvent, explicitKey: false };
    }

    const tournament = await getDefaultTournament(guild.id, { includeCompleted: true });
    if (tournament) {
        return { type: 'tournament', doc: tournament, explicitKey: false };
    }

    return null;
}

async function getUserIdsFromPrefix(message, args = [], explicitKey = false) {
    const directText = explicitKey ? args.slice(1).join(' ') : args.join(' ');
    const directIds = extractUserIds(directText);
    if (directIds.length) return directIds;

    const replied = message.reference?.messageId
        ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null)
        : null;
    if (!replied) return [];

    const mentionedIds = replied.mentions?.users
        ? Array.from(replied.mentions.users.keys())
        : [];

    return [...new Set([
        ...mentionedIds.filter(id => DISCORD_ID_RE.test(String(id))),
        ...extractUserIds(replied.content || '')
    ])];
}

function extractUserIds(text) {
    return [...new Set(
        (String(text || '').match(/\d{17,20}/g) || [])
            .filter(id => DISCORD_ID_RE.test(id))
    )];
}

async function runRemoveMvp({ client, guild, target, userIds, reply }) {
    const removed = [];
    const skipped = [];
    const uniqueUserIds = [...new Set(userIds.map(String).filter(id => DISCORD_ID_RE.test(id)))];

    for (const userId of uniqueUserIds) {
        const player = await Player.findOne({ guildId: guild.id, discordID: userId });
        if (!player) {
            skipped.push({ userId, reason: 'no player record' });
            continue;
        }

        const update = target.type === 'event'
            ? await removeEventMvp({ guild, event: target.doc, player, userId })
            : await removeTournamentMvp({ guild, tournament: target.doc, player, userId });

        if (!update) {
            skipped.push({ userId, name: player.name, reason: 'no MVP to remove in this tournament/event' });
            continue;
        }

        removed.push({
            userId,
            name: player.name || userId,
            remaining: Number(update.stats?.mvps) || 0
        });
    }

    if (removed.length && target.type === 'tournament') {
        await updateLiveTopStats(client, guild.id, target.doc.tournamentKey).catch(console.error);
    }
    if (removed.length && global.io) global.io.emit('update');

    const targetLabel = target.type === 'event'
        ? `event **${safeLabel(target.doc.name || target.doc.eventKey)}**`
        : `tournament **${safeLabel(target.doc.name || target.doc.tournamentKey)}**`;
    const lines = [
        `👑 Removed one MVP from **${removed.length}** of **${uniqueUserIds.length}** requested player(s) in ${targetLabel}.`
    ];

    for (const entry of removed.slice(0, DETAIL_LIMIT)) {
        lines.push(`✅ ${safeLabel(entry.name)} — ${entry.remaining} MVP(s) remaining`);
    }
    for (const entry of skipped.slice(0, Math.max(0, DETAIL_LIMIT - removed.length))) {
        lines.push(`⚠️ ${safeLabel(entry.name || entry.userId)} — ${entry.reason}`);
    }

    const omitted = removed.length + skipped.length - (lines.length - 1);
    if (omitted > 0) lines.push(`…and ${omitted} more result(s).`);

    return reply({
        content: lines.join('\n'),
        allowedMentions: { parse: [], users: [], roles: [] }
    });
}

async function removeTournamentMvp({ guild, tournament, player, userId }) {
    const updated = await TournamentPlayer.findOneAndUpdate(
        {
            guildId: guild.id,
            tournamentId: tournament._id,
            playerId: player._id,
            'stats.mvps': { $gt: 0 }
        },
        { $inc: { 'stats.mvps': -1 } },
        { returnDocument: 'after' }
    );

    if (!updated) return null;

    await decrementAllTimeMvp(guild.id, userId).catch(console.error);
    return updated;
}

async function removeEventMvp({ guild, event, player, userId }) {
    const updated = await EventPlayer.findOneAndUpdate(
        {
            guildId: guild.id,
            eventId: event._id,
            playerId: player._id,
            'stats.mvps': { $gt: 0 }
        },
        { $inc: { 'stats.mvps': -1 } },
        { returnDocument: 'after' }
    );

    if (!updated) return null;

    await decrementAllTimeMvp(guild.id, userId).catch(console.error);
    return updated;
}

async function decrementAllTimeMvp(guildId, userId) {
    await UserProfile.findOneAndUpdate(
        {
            guildId,
            discordID: userId,
            'allTimeStats.mvps': { $gt: 0 }
        },
        { $inc: { 'allTimeStats.mvps': -1 } },
        { returnDocument: 'after' }
    );
}

function safeLabel(value) {
    return escapeMarkdown(String(value || 'Unknown'))
        .replace(/@/g, '@\u200b')
        .replace(/</g, '‹')
        .replace(/>/g, '›');
}

module.exports.extractUserIds = extractUserIds;
module.exports.getUserIdsFromPrefix = getUserIdsFromPrefix;
module.exports.resolveTarget = resolveTarget;
module.exports.runRemoveMvp = runRemoveMvp;
module.exports.removeTournamentMvp = removeTournamentMvp;
module.exports.removeEventMvp = removeEventMvp;
