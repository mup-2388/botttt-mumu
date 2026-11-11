/**
 * addteamtotournament.js
 *
 * Manually add or re-add a team to a specific tournament.
 * Organizer only. Syncs the team + its players using tournamentSync utils.
 *
 * Usage: .addteamtotournament <key> <team name> [group]
 * Slash: /addteamtotournament key:<key> team:<name> group:<group>
 *
 * Aliases: jointournament, jointour, att
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const { Team, TournamentSettings } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament, extractTournamentFromArgs } = require('../../utils/getTournament');
const { syncTeamToTournament } = require('../../utils/tournamentSync');
const { escapeRegex } = require('../../utils/stringHelpers');

module.exports = {
    name: 'addteamtotournament',
    description: 'Manually add/re-add a team to a tournament.',
    usage: '.addteamtotournament [key] <team name> [group]',
    aliases: ['jointournament', 'jointour', 'att'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('addteamtotournament')
        .setDescription('Manually add/re-add a team to a tournament')
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team name')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('group')
                .setDescription('Optional group key (e.g. A, B)')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 You are not authorized.');
            }

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args);
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const rest = parsedKey.rest;

            if (!rest.length) {
                return message.reply(
                    '❓ Usage: `.addteamtotournament [key] <team name> [group]`\n' +
                    'Without a key the server default tournament is used.'
                );
            }

            // Detect optional group key at the end (single letter)
            let groupKey = null;
            let teamName = rest.join(' ').trim();

            const last = rest[rest.length - 1];
            if (rest.length >= 2 && /^[A-Za-z]$/.test(last)) {
                groupKey = last.toUpperCase();
                teamName = rest.slice(0, -1).join(' ').trim();
            }

            return await runAdd({
                guild: message.guild,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                teamName,
                groupKey,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[addteamtotournament] prefix error:', error);
            return message.reply('❌ Failed to add team to tournament.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 You are not authorized.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runAdd({
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                teamName: interaction.options.getString('team'),
                groupKey: interaction.options.getString('group')?.toUpperCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[addteamtotournament] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to add team to tournament.');
            }

            return interaction.reply({
                content: '❌ Failed to add team to tournament.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Add a team to a tournament and sync its players.
 * Optionally assigns a group key.
 */
async function runAdd({ guild, tournamentKey, teamName, groupKey, reply }) {
    // ── Find tournament ──
    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    // ── Find team (case-insensitive) ──
    const team = await Team.findOne({
        guildId: guild.id,
        name: { $regex: new RegExp(`^${escapeRegex(teamName)}$`, 'i') }
    });

    if (!team) {
        return reply({ content: `❌ Team **${teamName}** not found.` });
    }

    // ── Assign group if provided ──
    if (groupKey) {
        team.groupKey = groupKey;
        await team.save();
    }

    // ── Sync team + players into tournament ──
    const sync = await syncTeamToTournament(guild.id, tournament, team);

    // ── Response ──
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('✅ TEAM ADDED TO TOURNAMENT')
        .setDescription(
            `**${team.name}** has been added to **${tournament.name}**.\n\n` +
            `Tournament Key: \`${tournament.tournamentKey}\`\n` +
            `${groupKey ? `Group: **${groupKey}**\n` : ''}` +
            `Players synced: **${sync.playersSynced}**`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}
