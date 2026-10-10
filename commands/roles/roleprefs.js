const { SlashCommandBuilder } = require('discord.js');
const { buildRolePrefsPayload } = require('../../utils/selfRoles');

module.exports = {
    name: 'roleprefs',
    aliases: ['rolepreferences'],
    description: 'Privately review and update your self-role preferences.',
    hidden: false,
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('roleprefs')
        .setDescription('Review your self-role preferences privately'),

    async execute(message) {
        if (!message.guild) return;
        return message.reply('Use `/roleprefs` for a private view, or click **Choose / update roles** on a published self-role panel.');
    },

    async slashExecute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: true });
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (!member) return interaction.editReply('I could not load your member profile. Please try again.');
            const payload = await buildRolePrefsPayload(interaction.guild, member, interaction.user.id);
            return interaction.editReply(payload);
        } catch (error) {
            console.error('[roleprefs] failed:', error);
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Could not load your role preferences.');
            }
            return interaction.reply({ content: '❌ Could not load your role preferences.', ephemeral: true });
        }
    }
};
