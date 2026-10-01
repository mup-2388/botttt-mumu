/**
 * aistatus.js
 *
 * Owner-only health report for the AI stack: which providers have keys, which
 * are cooling down, emoji catalogue size, ping-bait attempts, and a snapshot of
 * how the caller talks (style profile / roast level).
 *
 * Usage:  .aistatus
 * Slash:  /aistatus
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const { getProviderStatus } = require('../../utils/aiProviders');
const { stats: emojiStats } = require('../../utils/ai/emojiCatalog');
const { getStyleSnapshot, roastLevelFor, OWNER_ID } = require('../../utils/ai/personality');

module.exports = {
    name: 'aistatus',
    description: 'AI stack health (owner only).',
    usage: '.aistatus',
    aliases: ['aihealth'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('aistatus')
        .setDescription('AI stack health (owner only)'),

    async execute(message) {
        if (message.author.id !== OWNER_ID) return message.reply('🚫 Owner only.');

        return message.reply(await buildPayload(message.guild, message.author));
    },

    async slashExecute(interaction) {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({ content: '🚫 Owner only.', ephemeral: true });
        }

        return interaction.reply({ ...(await buildPayload(interaction.guild, interaction.user)), ephemeral: true });
    }
};

async function buildPayload(guild, user) {
    const providers = getProviderStatus();
    const emojis = emojiStats();

    const providerLines = providers.map(p => {
        if (!p.available) return `⚪ **${p.name}** — no key`;

        const rows = p.models.map(m => {
            const state = m.cooling
                ? `🥶 cooling (${Math.ceil((m.until - Date.now()) / 1000)}s)`
                : m.fail && !m.ok
                    ? `⚠️ failing (${m.lastError || 'unknown'})`
                    : `✅ ok${m.avgMs ? ` ${m.avgMs}ms` : ''}`;

            return `   ${m.model} — ${state}${m.ok + m.fail ? ` · ${m.ok}✓/${m.fail}✗` : ''}`;
        });

        return `**${p.name}** (${p.keys} key${p.keys === 1 ? '' : 's'})\n${rows.join('\n')}`;
    });

    const style = getStyleSnapshot(guild.id, user.id);
    const level = roastLevelFor({ userId: user.id, guildId: guild.id, content: '' });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🤖 AI STATUS')
        .addFields(
            { name: 'Providers (priority order)', value: providerLines.join('\n').slice(0, 3400) || 'none configured', inline: false },
            { name: 'Emoji catalogue', value: `${emojis.emojis} custom emojis indexed · ${emojis.users} user profiles`, inline: true },
            { name: 'Ping-bait guard', value: 'active (allowedMentions + sanitizer + detector)', inline: true },
            { name: `Style profile — ${user.username}`, value: `messages learnt: ${style.messages}\navg length: ${style.avgLength}\nlanguage: ${style.language}\nroast level now: **${level}**\ntop emojis: ${style.topEmojis.slice(0, 4).join(' ') || '—'}`, inline: false }
        )
        .setFooter({ text: 'Keys come from env: GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY (+ _1,_2… for extras)' })
        .setTimestamp();

    return { embeds: [embed] };
}
