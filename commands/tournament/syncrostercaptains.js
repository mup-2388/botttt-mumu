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
                return message.reply(embedNotice(
                    'Organizer only',
                    'Only an organizer can sync roster captains.',
                    0xED4245
                ));
            }

            const parsed = await extractTournamentFromArgs(message.guild.id, args);
            if (parsed.error) {
                return message.reply(embedNotice('Roster captain sync', parsed.error, 0xED4245));
            }
            if (parsed.rest.length) {
                return message.reply(embedNotice(
                    'Roster captain sync',
                    'Unknown tournament key. Use `tournament=<key>`.',
                    0xED4245
                ));
            }

            return await runSync({
                guild: message.guild,
                tournamentKey: parsed.explicit ? parsed.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[syncrostercaptains] prefix error:', error);
            return message.reply(embedNotice(
                'Roster captain sync failed',
                'Failed to sync tournament captains.',
                0xED4245
            ));
        }
    },

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild, interaction.user.id))) {
                return interaction.reply({
                    ...embedNotice('Organizer only', 'Only an organizer can sync roster captains.', 0xED4245),
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
            const failure = embedNotice(
                'Roster captain sync failed',
                'Failed to sync tournament captains.',
                0xED4245
            );
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(failure);
            }
            return interaction.reply({ ...failure, ephemeral: true });
        }
    }
};

async function runSync({ guild, tournamentKey, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey);
    if (!resolved.tournament) {
        return reply(embedNotice('Roster captain sync', resolved.error, 0xED4245));
    }

    const result = await syncCaptainsToTournamentRoster(guild.id, resolved.tournament);
    const skippedLines = result.skipped.slice(0, 10).map(item =>
        `• **${shortText(item.teamName, 70)}** — ${shortText(item.reason, 130)}`
    );
    const moreSkipped = result.skipped.length > skippedLines.length
        ? `\n…and ${result.skipped.length - skippedLines.length} more skipped team(s).`
        : '';
    const description =
        `Completed for **${shortText(resolved.tournament.name, 120)}**.` +
        (skippedLines.length
            ? `\n\n**Needs manual review**\n${skippedLines.join('\n')}${moreSkipped}`
            : '');

    return reply({
        embeds: [{
            color: 0x5865F2,
            title: 'Roster Captain Sync',
            description,
            fields: [
                { name: 'Updated', value: String(result.updated), inline: true },
                { name: 'Already correct', value: String(result.alreadyCorrect), inline: true },
                { name: 'Needs manual review', value: String(result.skipped.length), inline: true }
            ],
            footer: {
                text: 'Tournament captain data only was changed. Mentions are display-only; no notification pings were sent.'
            }
        }],
        allowedMentions: { parse: [] }
    });
}

function embedNotice(title, description, color = 0x5865F2) {
    return {
        embeds: [{ title, description: shortText(description, 4000), color }],
        allowedMentions: { parse: [] }
    };
}

function shortText(value, maxLength) {
    const text = String(value || 'Unknown').replace(/[\r\n]+/g, ' ');
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
