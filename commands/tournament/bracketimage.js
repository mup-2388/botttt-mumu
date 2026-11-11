/**
 * bracketimage.js
 *
 * Refresh the knockout-bracket image linked from the standings command.
 * The first image is posted by standings after the knockout stage is shown;
 * this command edits that message or reposts if its saved reference is stale.
 * Report and undo commands also refresh the linked message automatically.
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
    getTournamentByKey,
    extractTournamentFromArgs
} = require('../../utils/getTournament');
const {
    getLiveBracketImageKey,
    syncLiveBracketImageReference
} = require('../../utils/liveBracketImage');
const { shouldShowKnockoutBracket } = require('../../utils/knockoutBracket');

let generateKnockoutBracketImage = null;
let bracketRendererLoadError = null;
try {
    ({ generateKnockoutBracketImage } = require('../../utils/generateKnockoutBracketImage'));
} catch (error) {
    bracketRendererLoadError = error;
}

module.exports = {
    name: 'bracketimage',
    description: 'Update the live knockout bracket image linked from standings.',
    usage: '.bracketimage [tournamentKey]',
    aliases: ['updatebracketimage', 'refreshbracketimage'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('bracketimage')
        .setDescription('Update the live knockout bracket image linked from standings')
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

            const parsed = await extractTournamentFromArgs(message.guild.id, args);
            if (parsed.explicit && parsed.error) return message.reply(parsed.error);
            if (!parsed.tournament) return message.reply('❌ Tournament not found.');

            const result = await publishOrUpdateBracketImage({
                client: message.client,
                guildId: message.guild.id,
                tournament: parsed.tournament,
                channel: message.channel
            });

            return message.reply(buildConfirmation(result, parsed.tournament));
        } catch (error) {
            console.error('[bracketimage] prefix error:', error);
            return message.reply(`❌ Could not update the bracket image: ${error.message || 'Unknown error'}`);
        }
    },

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({ content: '🚫 Unauthorized.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });
            const key = interaction.options.getString('key')?.toLowerCase() || null;
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
            const payload = { content: `❌ Could not update the bracket image: ${error.message || 'Unknown error'}` };
            if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
            return interaction.reply({ ...payload, ephemeral: true });
        }
    }
};

/** Update the standings-linked image, reposting into its channel if stale. */
async function publishOrUpdateBracketImage({ client, guildId, tournament, channel }) {
    if (!shouldShowKnockoutBracket(tournament)) {
        return { ok: false, reason: 'not-knockout-stage' };
    }

    const key = getLiveBracketImageKey(guildId, tournament.tournamentKey);
    const saved = client?.liveSettings?.get?.(key) || null;
    if (!saved) return { ok: false, reason: 'not-linked' };

    if (!generateKnockoutBracketImage) {
        throw bracketRendererLoadError || new Error('The knockout bracket image renderer is unavailable.');
    }

    const rendered = await generateKnockoutBracketImage({ settings: tournament, guildId });
    if (!rendered) {
        return { ok: false, reason: 'no-fixtures' };
    }

    const payload = {
        content: buildBracketCaption(tournament),
        files: [new AttachmentBuilder(rendered.buffer, {
            name: rendered.fileName || 'knockout-bracket.png'
        })]
    };

    let targetChannel = null;
    let existingMessage = null;
    if (saved?.channelId && client?.channels?.fetch) {
        targetChannel = await client.channels.fetch(saved.channelId).catch(() => null);
        if (targetChannel && saved.messageId && targetChannel.messages?.fetch) {
            existingMessage = await targetChannel.messages.fetch(saved.messageId).catch(() => null);
        }
    }

    if (existingMessage?.edit) {
        try {
            // Replacing the attachment prevents Discord from keeping old PNGs on edits.
            await existingMessage.edit({ ...payload, attachments: [] });
            syncLiveBracketImageReference({
                client,
                guildId,
                tournamentKey: tournament.tournamentKey,
                message: existingMessage,
                isBracketImage: true
            });
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
    syncLiveBracketImageReference({
        client,
        guildId,
        tournamentKey: tournament.tournamentKey,
        message: sent,
        isBracketImage: true
    });
    return {
        ok: true,
        action: 'reposted',
        message: sent
    };
}

/** Refresh only an image already linked by the standings command. */
async function refreshLiveBracketImage(client, guildId, tournamentKey, tournament = null) {
    const key = getLiveBracketImageKey(guildId, tournamentKey);
    if (!client?.liveSettings?.get?.(key)) {
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

function isUnknownMessageError(error) {
    return Number(error?.code) === 10008 || Number(error?.status) === 404;
}

function buildBracketCaption(tournament) {
    return `${tournament.emoji || '🏆'} **${String(tournament.name || 'Tournament').toUpperCase()} KNOCKOUT BRACKET**\n` +
        `Key: \`${tournament.tournamentKey}\``;
}

function buildConfirmation(result, tournament) {
    if (!result?.ok) {
        if (result?.reason === 'not-knockout-stage') {
            return 'ℹ️ The knockout bracket image is available after the knockout stage is active. Open standings during the knockout stage to post it first.';
        }
        if (result?.reason === 'no-fixtures') {
            return '📭 No knockout fixtures are available yet. Generate the opening knockout round first.';
        }
        if (result?.reason === 'not-linked') {
            return 'ℹ️ No live bracket image is linked yet. Use the standings command to post the bracket first; this command only updates an existing image.';
        }
        return '❌ Could not find a channel to update the bracket image.';
    }

    const channelId = result.message?.channel?.id;
    const location = channelId ? ` in <#${channelId}>` : '';
    if (result.action === 'updated') {
        return `✅ Updated the live bracket image for **${tournament.name}**${location}.`;
    }
    return `✅ The previous bracket message was unavailable; reposted and re-linked the image for **${tournament.name}**${location}.`;
}

module.exports.publishOrUpdateBracketImage = publishOrUpdateBracketImage;
module.exports.refreshLiveBracketImage = refreshLiveBracketImage;
module.exports.getLiveBracketImageKey = getLiveBracketImageKey;
module.exports.buildBracketCaption = buildBracketCaption;
