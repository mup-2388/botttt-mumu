/**
 * setlivestandings.js
 *
 * Create a live-updating standings message for a tournament.
 * Supports group-specific standings.
 *
 * Usage: .setlivestandings [tournamentKey] [group]
 * Slash: /setlivestandings [key] [group]
 *
 * Aliases: sls, livestandings
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const LiveMessage = require('../../models/LiveMessage');

const {
    getDefaultTournament,
    getTournamentByKey
} = require('../../utils/getTournament');

const {
    updateLiveStandings
} = require('../../utils/updateStandings');

const { isOrganizer } = require('../../utils/isOrganizer');

module.exports = {
    name: 'setlivestandings',
    description: 'Set a live standings message.',
    usage: '.setlivestandings [tournamentKey] [group]',
    aliases: ['sls', 'livestandings'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('setlivestandings')
        .setDescription('Create live standings')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('group')
                .setDescription('Optional group key')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 Unauthorized.');
            }

            const possibleKey = args[0]?.toLowerCase();

            const tournament = await resolveTournament(
                message.guild.id,
                possibleKey
            );

            if (!tournament) {
                return message.reply('❌ Tournament not found.');
            }

            const groupKey =
                args.length >= 2
                    ? args[1].toUpperCase()
                    : null;

            return await runSetup({
                client: message.client,
                guild: message.guild,
                channel: message.channel,
                tournament,
                groupKey,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[setlivestandings] prefix error:', error);
            return message.reply('❌ Failed to create live standings.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 Unauthorized.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            const tournament = await resolveTournament(
                interaction.guild.id,
                interaction.options.getString('key')
            );

            if (!tournament) {
                return interaction.editReply('❌ Tournament not found.');
            }

            const groupKey =
                interaction.options.getString('group')?.toUpperCase() || null;

            return await runSetup({
                client: interaction.client,
                guild: interaction.guild,
                channel: interaction.channel,
                tournament,
                groupKey,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[setlivestandings] slash error:', error);

            if (interaction.replied || interaction.deferred) {
                return interaction.editReply('❌ Failed to create live standings.');
            }

            return interaction.reply({
                content: '❌ Failed to create live standings.',
                ephemeral: true
            });
        }
    }
};

async function resolveTournament(guildId, key) {
    if (key) {
        const found = await getTournamentByKey(
            guildId,
            key.toLowerCase()
        );

        if (found) return found;
    }

    return getDefaultTournament(guildId);
}

async function runSetup({
    client,
    guild,
    channel,
    tournament,
    groupKey,
    reply
}) {
    await LiveMessage.findOneAndDelete({
        guildId: guild.id,
        type: 'standings',
        tournamentKey: tournament.tournamentKey,
        groupKey: groupKey || null
    });

    const loading = await channel.send(
        `⏳ Creating live standings for **${tournament.name}**...`
    );

    await LiveMessage.create({
        guildId: guild.id,
        type: 'standings',
        tournamentKey: tournament.tournamentKey,
        groupKey: groupKey || null,
        channelId: channel.id,
        messageId: loading.id
    });

    const liveUpdated = await updateLiveStandings(
        client,
        guild.id,
        tournament.tournamentKey,
        groupKey
    );

    if (!liveUpdated) {
        await LiveMessage.findOneAndDelete({
            guildId: guild.id,
            type: 'standings',
            tournamentKey: tournament.tournamentKey,
            groupKey: groupKey || null
        }).catch(() => null);
        await loading.edit('❌ Could not initialize live standings. Check the bot’s channel permissions and try again.').catch(() => null);
        return reply({ content: '❌ Could not initialize live standings. No live record was kept.' });
    }

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('✅ LIVE STANDINGS CREATED')
        .setDescription(
            `Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n` +
            `${groupKey ? `Group: **${groupKey}**\n` : ''}\n` +
            `This message will now auto-update.`
        )
        .setTimestamp();

    return reply({
        embeds: [embed]
    });
}