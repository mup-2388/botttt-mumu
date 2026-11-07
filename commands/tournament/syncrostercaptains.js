/**
 * syncrostercaptains.js
 *
 * Organizer-only reconciliation for captain assignments in one tournament.
 * Global captains are preferred only when they appear on that tournament
 * team's active roster; an existing tournament captain or a unique rostered
 * captain flag is used as a safe fallback. Ambiguous teams are reported, not
 * assigned to a random player.
 *
 * Usage: .syncrostercaptains [tournament=<key>]
 * Slash: /syncrostercaptains [tournament:<key>]
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { isOrganizer } = require('../../utils/isOrganizer');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const { syncCaptainsToTournamentRoster } = require('../../utils/tournamentCaptainSync');

module.exports = {
    name: 'syncrostercaptains',
    description: 'Sync tournament captains from rostered global leaders.',
    usage: '.syncrostercaptains [tournament=<key>]',
    aliases: ['srcc', 'syncleaders'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('syncrostercaptains')
        .setDescription('Sync tournament captains from rostered global leaders')
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        ),

    async execute(message, args = []) {
        try {
            if (!message.guild) return;
            if (!(await isOrganizer(message.guild, message.author.id))) {
                return message.reply('🚫 Only an organizer can sync roster captains.');
            }

            const parsed = await extractTournamentFromArgs(message.guild.id, args);
            if (parsed.error) return message.reply(parsed.error);
            if (parsed.rest.length) {
                return message.reply('❌ Unknown tournament key. Use `.syncrostercaptains tournament=<key>`.');
            }

            return await runSync({
                guild: message.guild,
                tournamentKey: parsed.explicit ? parsed.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[syncrostercaptains] prefix error:', error);
            return message.reply('❌ Failed to sync tournament captains.');
        }
    },

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 Only an organizer can sync roster captains.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });
            return await runSync({
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[syncrostercaptains] slash error:', error);
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to sync tournament captains.');
            }
            return interaction.reply({
                content: '❌ Failed to sync tournament captains.',
                ephemeral: true
            });
        }
    }
};

async function runSync({ guild, tournamentKey, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey);
    if (!resolved.tournament) return reply(resolved.error);

    const result = await syncCaptainsToTournamentRoster(guild.id, resolved.tournament);
    const skippedLines = result.skipped.slice(0, 12).map(item =>
        `• **${item.teamName}** — ${item.reason}`
    );
    const moreSkipped = result.skipped.length > skippedLines.length
        ? `\n…and ${result.skipped.length - skippedLines.length} more skipped team(s).`
        : '';

    return reply({
        content:
            `✅ **Roster captain sync completed for ${resolved.tournament.name}.**\n` +
            `Updated: **${result.updated}** • Already correct: **${result.alreadyCorrect}** • ` +
            `Needs manual review: **${result.skipped.length}**\n\n` +
            (skippedLines.length ? `${skippedLines.join('\n')}${moreSkipped}\n\n` : '') +
            'Only this tournament’s captain assignments and roster captain flags were changed; global team leadership was left untouched.'
    });
}
