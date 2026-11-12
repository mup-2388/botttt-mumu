/**
 * bracketimage.js
 *
 * Post one persistent knockout-bracket image per tournament. Re-running this
 * command edits that same message; reports and undo-report refresh it in place.
 * If the saved message was deleted, the image is reposted and relinked.
 *
 * Usage: .bracketimage [tournamentKey]
 * Slash: /bracketimage [key]
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    AttachmentBuilder
} = require('discord.js');
const { isOrganizer } = require('../../utils/isOrganizer');
const {
    getDefaultTournament,
    getTournamentByKey
} = require('../../utils/getTournament');
const {
    getLiveBracketImageKey,
    isLiveBracketImageReference,
    saveLiveBracketImageReference
} = require('../../utils/liveBracketImage');
const { shouldShowKnockoutBracket } = require('../../utils/knockoutBracket');

let generateKnockoutBracketImage = null;
let bracketRendererLoadError = null;
try {
    ({ generateKnockoutBracketImage } = require('../../utils/generateKnockoutBracketImage'));
} catch (error) {
    bracketRendererLoadError = error;
}

// Keep simultaneous first-time invocations from posting duplicate messages.
const bracketImageLocks = new Map();

module.exports = {
    name: 'bracketimage',
    description: 'Post or update the persistent live knockout bracket image.',
    usage: '.bracketimage [tournamentKey]',
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('bracketimage')
        .setDescription('Post or update the persistent live knockout bracket image')
        .addStringOption(option =>
            option.setName('key')
                .setDescription('Optional tournament key')
                .setRequired(false)
        ),

    async execute(message, args = []) {
        try {
            if (!message.guild) return;
            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const key = parseTournamentKey(args);
            const tournament = key
                ? await getTournamentByKey(message.guild.id, key, { includeCompleted: true })
                : await getDefaultTournament(message.guild.id, { includeCompleted: true });
            if (!tournament) {
                return message.reply(key
                    ? `❌ Tournament \`${key}\` not found.`
                    : '❌ Tournament not found.');
            }

            const result = await publishOrUpdateBracketImage({
                client: message.client,
                guildId: message.guild.id,
                tournament,
                channel: message.channel
            });

            return message.reply(buildConfirmation(result, tournament));
        } catch (error) {
            console.error('[bracketimage] prefix error:', error);
            return message.reply(`❌ Could not post or update the live bracket: ${error.message || 'Unknown error'}`);
        }
    },

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });
            const key = interaction.options.getString('key')?.trim().toLowerCase() || null;
            const tournament = key
                ? await getTournamentByKey(interaction.guild.id, key, { includeCompleted: true })
                : await getDefaultTournament(interaction.guild.id, { includeCompleted: true });

            if (!tournament) {
                return interaction.editReply({ content: '❌ Tournament not found.' });
            }

            const result = await publishOrUpdateBracketImage({
                client: interaction.client,
                guildId: interaction.guild.id,
                tournament,
                channel: interaction.channel
            });

            return interaction.editReply({ content: buildConfirmation(result, tournament) });
        } catch (error) {
            console.error('[bracketimage] slash error:', error);
            const payload = { content: `❌ Could not post or update the live bracket: ${error.message || 'Unknown error'}` };
            if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
            return interaction.reply({ ...payload, ephemeral: true });
        }
    }
};

/** Post once, then edit the saved message for every later refresh. */
async function publishOrUpdateBracketImage({ client, guildId, tournament, channel }) {
    if (!shouldShowKnockoutBracket(tournament)) {
        return { ok: false, reason: 'not-knockout-stage' };
    }

    const settings = client?.liveSettings;
    if (typeof settings?.get !== 'function' || typeof settings?.set !== 'function') {
        return { ok: false, reason: 'tracking-unavailable' };
    }

    const key = getLiveBracketImageKey(guildId, tournament.tournamentKey);
    return withBracketImageLock(key, async () => {
        if (!generateKnockoutBracketImage) {
            throw bracketRendererLoadError || new Error('The knockout bracket image renderer is unavailable.');
        }

        const rendered = await generateKnockoutBracketImage({ settings: tournament, guildId });
        if (!rendered) return { ok: false, reason: 'no-fixtures' };

        const payload = {
            content: buildBracketCaption(tournament),
            files: [new AttachmentBuilder(rendered.buffer, {
                name: rendered.fileName || 'knockout-bracket.png'
            })]
        };

        const saved = settings.get(key) || null;
        const hasDedicatedMessage = isLiveBracketImageReference(saved);
        let targetChannel = null;
        let existingMessage = null;

        // Older versions linked a transient standings post. Do not edit that
        // message; the first .bracketimage call creates the dedicated live one.
        if (hasDedicatedMessage && saved.channelId && client.channels?.fetch) {
            targetChannel = await client.channels.fetch(saved.channelId).catch(() => null);
            if (targetChannel && saved.messageId && targetChannel.messages?.fetch) {
                existingMessage = await targetChannel.messages.fetch(saved.messageId).catch(() => null);
            }
        }

        if (existingMessage?.edit) {
            try {
                await existingMessage.edit({ ...payload, attachments: [] });
                return { ok: true, action: 'updated', message: existingMessage };
            } catch (error) {
                if (!isUnknownMessageError(error)) throw error;
            }
        }

        targetChannel = targetChannel || channel;
        if (!targetChannel?.send) {
            return { ok: false, reason: 'channel-unavailable' };
        }

        const sent = await targetChannel.send(payload);
        let tracked = false;
        try {
            tracked = saveLiveBracketImageReference({
                client,
                guildId,
                tournamentKey: tournament.tournamentKey,
                channel: targetChannel,
                message: sent
            });
        } catch (error) {
            await discardMessage(sent);
            throw error;
        }
        if (!tracked) {
            await discardMessage(sent);
            return { ok: false, reason: 'tracking-unavailable' };
        }

        return {
            ok: true,
            action: hasDedicatedMessage ? 'reposted' : 'posted',
            message: sent
        };
    });
}

/** Refresh only a dedicated bracketimage post; reports never create a first post. */
async function refreshLiveBracketImage(client, guildId, tournamentKey, tournament = null) {
    const key = getLiveBracketImageKey(guildId, tournamentKey);
    const saved = client?.liveSettings?.get?.(key);
    if (!isLiveBracketImageReference(saved)) {
        return { ok: true, updated: false, reason: 'not-linked' };
    }

    let settings = tournament;
    if (!settings) {
        settings = await getTournamentByKey(guildId, tournamentKey, { includeCompleted: true });
    }
    if (!settings) return { ok: false, updated: false, reason: 'tournament-not-found' };

    const result = await publishOrUpdateBracketImage({
        client,
        guildId,
        tournament: settings,
        channel: null
    });
    return { ...result, updated: result.ok && result.action === 'updated' };
}

async function withBracketImageLock(key, callback) {
    const previous = bracketImageLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    bracketImageLocks.set(key, current);

    await previous.catch(() => null);
    try {
        return await callback();
    } finally {
        release();
        if (bracketImageLocks.get(key) === current) bracketImageLocks.delete(key);
    }
}

function isUnknownMessageError(error) {
    return Number(error?.code) === 10008 || Number(error?.status) === 404;
}

async function discardMessage(message) {
    try {
        await message?.delete?.();
    } catch (_) {
        // The reference could not be stored, so deleting the orphan is best-effort.
    }
}

function parseTournamentKey(args = []) {
    const tokens = (Array.isArray(args) ? args : [args]).filter(Boolean).map(String);
    const explicitToken = tokens.find(token => /^(tournament|key|t)=/i.test(token));
    const raw = explicitToken
        ? explicitToken.slice(explicitToken.indexOf('=') + 1)
        : tokens[0];
    return String(raw || '').trim().toLowerCase() || null;
}

function buildBracketCaption(tournament) {
    return `${tournament.emoji || '🏆'} **${String(tournament.name || 'Tournament').toUpperCase()} KNOCKOUT BRACKET**\n` +
        `Key: \`${tournament.tournamentKey}\``;
}

function buildConfirmation(result, tournament) {
    if (!result?.ok) {
        if (result?.reason === 'not-knockout-stage') {
            return 'ℹ️ The live bracket is available after the knockout stage is active.';
        }
        if (result?.reason === 'no-fixtures') {
            return '📭 No knockout fixtures are available yet. Generate the opening knockout round first.';
        }
        if (result?.reason === 'tracking-unavailable') {
            return '❌ Could not save the live bracket reference, so no persistent bracket message was created.';
        }
        return '❌ Could not find a channel to post or update the live bracket.';
    }

    const channelId = result.message?.channel?.id;
    const location = channelId ? ` in <#${channelId}>` : '';
    if (result.action === 'updated') {
        return `✅ Updated the live bracket for **${tournament.name}**${location}. This is the same message and it will keep updating after results are reported.`;
    }
    if (result.action === 'reposted') {
        return `✅ The old live bracket message was unavailable; reposted and relinked the bracket for **${tournament.name}**${location}.`;
    }
    return `✅ Posted the live bracket for **${tournament.name}**${location}. This message will update after results are reported.`;
}

module.exports.publishOrUpdateBracketImage = publishOrUpdateBracketImage;
module.exports.refreshLiveBracketImage = refreshLiveBracketImage;
module.exports.getLiveBracketImageKey = getLiveBracketImageKey;
module.exports.buildBracketCaption = buildBracketCaption;
