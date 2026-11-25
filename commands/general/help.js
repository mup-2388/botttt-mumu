const { 
    EmbedBuilder, 
    StringSelectMenuBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    SlashCommandBuilder,
    ComponentType 
} = require('discord.js');

const { 
    getGuildPrefix,
    DEFAULT_PREFIX
} = require('../../utils/prefixManager');

module.exports = {
    name: 'help',
    aliases: ['h', 'commands'],
    description: 'List all categories or get info on a specific command.',
    category: 'general',
    usage: '[command_name | category_name]',
    cooldown: 25,

    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List all categories or get info on a specific command.')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Enter a category or command name for specific help.')),

    async execute(message, args) {
        const prefix = await getGuildPrefix(
            message.guild.id
        );
        await this.runHelp(message, args[0], prefix || DEFAULT_PREFIX, false);
    },

    async slashExecute(interaction) {
        const query = interaction.options.getString('query');
        const prefix = await getGuildPrefix(
            interaction.guild.id
        );
        await this.runHelp(interaction, query, prefix || DEFAULT_PREFIX, true);
    },

    async runHelp(input, query, prefix, isSlash) {
        const client = input.client;
        const allCommands = client.commands.filter(cmd => !cmd.hidden);
        const user = isSlash ? input.user : input.author;

        const categoryEmojis = {
            utilities: '<a:utility:1486731804395180154>',
            general: '<:general:1486731912889368679>',
            fun: '<:fun:1486732233757954126>',
            moderation: '<:moderation:1486732346769281096>',
            economy: '💰',
            info: '<:Info:1486732443888259154>',
            football: '⚽',
            cricket: '🏏',
            tournament: '<a:Tournament:1488533188547711079>',
            games: '🎮',
            config: '<a:config:1488536717660262661>',
            levelling: '<:LEVELUP:1488537174029635665>'
        };

        const categories = [...new Set(allCommands.map(cmd => cmd.category))].filter(Boolean);

        if (query) {
            const search = query.toLowerCase();
            if (categories.includes(search)) {
                const initial = this.generatePage(search, 0, allCommands, prefix, categoryEmojis, categories);
                return isSlash ? input.reply(initial) : input.reply(initial);
            }
            const command = allCommands.get(search) || allCommands.find(c => c.aliases?.includes(search));
            if (command) {
                const cmdEmbed = new EmbedBuilder()
                    .setColor(0xFEBE10)
                    .setTitle(`<:notessssss:1486742759606976644> Command: ${command.name.charAt(0).toUpperCase() + command.name.slice(1)}`)
                    .setDescription(command.description || "No description provided.")
                    .addFields(
                        { name: '<:Category:1486733439532269639> Category', value: `\`${command.category}\``, inline: true },
                        { name: '<:aliases:1487005470618030161> Aliases', value: `\`${command.aliases?.join(', ') || 'None'}\``, inline: true },
                        { name: '<:notessssss:1486742759606976644> Usage', value: `\`${prefix}${command.name} ${command.usage || ''}\``, inline: false }
                    )
                    .setFooter({ text: 'Tip: <> = Required, [] = Optional' });
                return isSlash ? input.reply({ embeds: [cmdEmbed] }) : input.reply({ embeds: [cmdEmbed] });
            }
        }

        // --- THE PRETTY MAIN MENU (RESTORED) ---
        const mainEmbed = new EmbedBuilder()
            .setColor(0xFEBE10)
            .setTitle('<:help:1486733224485847041> Mumu Bot Help Menu')
            .setThumbnail(client.user.displayAvatarURL())
            .setDescription(`Current Prefix: \`${prefix}\`\nSelect a category below to see commands.\n\n*Tip: Try \`${prefix}help <command/category>\` for direct access!*`)
            .addFields({ name: '📊 Statistics', value: `> Total Commands: **${allCommands.size}**\n> Total Categories: **${categories.length}**`, inline: false })
            .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('help-menu')
            .setPlaceholder('Choose a category...')
            .addOptions(categories.map(cat => ({
                label: cat.charAt(0).toUpperCase() + cat.slice(1),
                value: cat,
                emoji: categoryEmojis[cat] || '<:Category:1486733439532269639>'
            })));

        const row = new ActionRowBuilder().addComponents(selectMenu);
        const quitRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('quit-help').setLabel('Quit Menu').setStyle(ButtonStyle.Danger).setEmoji('<a:stop:1486741455836938461>')
        );

        const response = isSlash 
            ? await input.reply({ embeds: [mainEmbed], components: [row, quitRow], fetchReply: true })
            : await input.reply({ embeds: [mainEmbed], components: [row, quitRow] });

        let currentCat = null;
        let currentPage = 0;
        const collector = response.createMessageComponentCollector({ idle: 120000 });

        collector.on('collect', async i => {
            if (i.user.id !== user.id) return i.reply({ content: "This menu isn't for you!", ephemeral: true });
            if (i.customId === 'quit-help') return collector.stop('user_quit');

            if (i.customId === 'help-menu') {
                currentCat = i.values[0];
                currentPage = 0;
            } else if (i.customId === 'prev-page') {
                currentPage--;
            } else if (i.customId === 'next-page') {
                currentPage++;
            }

            const nextData = this.generatePage(currentCat, currentPage, allCommands, prefix, categoryEmojis, categories);
            await i.update(nextData);
        });

        collector.on('end', (_, reason) => {
            const endContent = reason === 'user_quit' 
                ? '<:closed:1486734116891394208> **Menu Closed.**' 
                : '<:caprineExpired:1486734355589103688> **Menu Expired.**';
            response.edit({ content: endContent, embeds: [], components: [] }).catch(() => null);
        });
    },

    generatePage(cat, page, allCmds, prefix, emojis, categories) {
        const catCmds = allCmds.filter(cmd => cmd.category === cat);
        const pageSize = 12;
        const totalPages = Math.ceil(catCmds.size / pageSize);
        const paged = Array.from(catCmds.values()).slice(page * pageSize, (page + 1) * pageSize);

        const embed = new EmbedBuilder()
            .setColor(0xFEBE10)
            .setTitle(`${emojis[cat] || '<:Category:1486733439532269639>'} ${cat.toUpperCase()} Commands`)
            .setDescription(`Showing page **${page + 1}/${totalPages}** of the **${cat}** category.`)
            .addFields(paged.map(cmd => ({
                name: `<:bulletin:1487005110231109654> ${prefix}${cmd.name}`,
                value: `> ${cmd.description || 'No description'}`,
                inline: true
            })))
            .setFooter({ text: `${cat.charAt(0).toUpperCase() + cat.slice(1)}: ${catCmds.size} | Page ${page + 1}/${totalPages}` });

        const select = new StringSelectMenuBuilder()
            .setCustomId('help-menu')
            .setPlaceholder('Switch Category')
            .addOptions(categories.map(c => ({
                label: c.charAt(0).toUpperCase() + c.slice(1),
                value: c,
                emoji: emojis[c] || '<:Category:1486733439532269639>',
                default: c === cat
            })));

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('prev-page').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('quit-help').setEmoji('<a:stop:1486741455836938461>').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('next-page').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        );

        return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), buttons] };
    }
};
