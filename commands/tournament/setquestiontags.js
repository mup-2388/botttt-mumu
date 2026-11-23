/**
 * setquestiontags.js
 *
 * Configure the server-specific users tagged under Questions in matchday and
 * reserved-fixture announcements.
 *
 * Usage:  .setquestiontags @user1 @user2 ...
 *         .setquestiontags clear
 * Slash:  /setquestiontags users:<mentions or IDs | clear>
 */

const { SlashCommandBuilder } = require('discord.js');
const { ServerConfig } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');

const MAX_USERS_INPUT_LENGTH = 6000;

module.exports = {
    name: 'setquestiontags',
    description: 'Set who gets tagged under Questions in fixture announcements.',
    usage: '.setquestiontags <@user ... | clear>',
    aliases: ['setquestioncontacts', 'questiontags'],
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('setquestiontags')
        .setDescription('Set the users tagged under Questions in fixture announcements')
        .addStringOption(option =>
            option.setName('users')
                .setDescription('User mentions or IDs separated by spaces/commas; use clear to remove all')
                .setRequired(true)
                .setMaxLength(MAX_USERS_INPUT_LENGTH)
        ),

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            return await processSetQuestionTags({
                guild: message.guild,
                input: (args || []).join(' '),
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[setquestiontags] prefix error:', error);
            return message.reply('❌ Failed to update the Questions tags.');
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

            return await processSetQuestionTags({
                guild: interaction.guild,
                input: interaction.options.getString('users'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[setquestiontags] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: '❌ Failed to update the Questions tags.' });
            }

            return interaction.reply({
                content: '❌ Failed to update the Questions tags.',
                ephemeral: true
            });
        }
    }
};

async function processSetQuestionTags({ guild, input, reply }) {
    const parsed = parseQuestionTagInput(input);
    if (parsed.error) {
        return reply({
            content: '❓ Use user mentions or IDs separated by spaces/commas, or type `clear` to remove all Questions tags. Role mentions are not supported.'
        });
    }

    if (parsed.userIds.length) {
        const membership = await Promise.all(parsed.userIds.map(userId => isGuildMember(guild, userId)));
        if (membership.some(isMember => !isMember)) {
            const missingCount = membership.filter(isMember => !isMember).length;
            return reply({
                content: `❌ ${missingCount} user${missingCount === 1 ? ' is' : 's are'} not a member of this server. No changes were made.`
            });
        }
    }

    await ServerConfig.findOneAndUpdate(
        { guildId: String(guild.id) },
        {
            $setOnInsert: { guildId: String(guild.id) },
            $set: { questionTagUserIds: parsed.userIds }
        },
        { upsert: true, new: true }
    );

    if (!parsed.userIds.length) {
        return reply({ content: '✅ Cleared the Questions tags for this server.' });
    }

    const count = parsed.userIds.length;
    return reply({
        content: `✅ Saved **${count}** Questions contact${count === 1 ? '' : 's'} for this server. They will be tagged in matchday and reserved-fixture announcements.`
    });
}

function parseQuestionTagInput(value) {
    const input = String(value ?? '').trim();
    if (/^clear$/i.test(input)) return { userIds: [] };
    if (!input) return { error: 'empty' };

    const userIds = [];
    const seen = new Set();
    const tokens = input.split(/[\s,]+/).filter(Boolean);

    for (const token of tokens) {
        const match = token.match(/^(?:<@!?(\d{15,22})>|(\d{15,22}))$/);
        const userId = match?.[1] || match?.[2];
        if (!userId) return { error: 'invalid' };
        if (!seen.has(userId)) {
            seen.add(userId);
            userIds.push(userId);
        }
    }

    return { userIds };
}

async function isGuildMember(guild, userId) {
    const members = guild?.members;
    const cached = members?.cache?.get?.(userId);
    if (cached) return true;
    if (typeof members?.fetch !== 'function') return false;

    const fetched = await members.fetch(userId).catch(() => null);
    return Boolean(fetched);
}

module.exports.processSetQuestionTags = processSetQuestionTags;
module.exports.parseQuestionTagInput = parseQuestionTagInput;
module.exports.isGuildMember = isGuildMember;
