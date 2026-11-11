const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    name: 'testalert',
    description: 'Sends a fake goal alert to test the live match configuration.',
    permissions: PermissionFlagsBits.Administrator,
    async execute(message, args) {
        const client = message.client;
        const guildId = message.guild.id;

        // 1. Pull the live setup from Enmap
        const serverData = client.liveSettings.get(guildId);

        if (!serverData || !serverData.channelId) {
            return message.reply("❌ **Setup not found.** Run your live setup command first!");
        }

        const channel = message.guild.channels.cache.get(serverData.channelId);
        if (!channel) {
            return message.reply("❌ **Channel not found.** The configured channel might have been deleted.");
        }

        // 2. Create the "Fake" Goal Embed (Exact match to your goalAlerts logic)
        const testEmbed = new EmbedBuilder()
            .setColor(0x2ECC71) // Goal Green
            .setTitle('<a:footballg:1486727534576930846> GOAL! - Primera División')
            .setDescription(`<:alerts:1486802066767610066> **Real Madrid** <:vsvs:1555297535361286225> **Barcelona**\nScore: **1 - 0**\n<:Stadium:1487010283506630776> **Venue:** Santiago Bernabéu`)
            .setTimestamp()
            .setFooter({ text: 'Mumu Live Test Alert' });

        try {
            await channel.send({ content: '📢 **Live Match Update Test**', embeds: [testEmbed] });
            return message.reply(`✅ **Success!** Test alert sent to <#${serverData.channelId}>.`);
        } catch (err) {
            console.error(err);
            return message.reply("❌ **Failed to send.** Check my permissions in the target channel.");
        }
    },
};