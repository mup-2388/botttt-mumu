/**
 * setstadium.js
 *
 * Set your team stadium, or set any team stadium as organizer.
 * Captain/VC can set their own team's stadium (including per-tournament teams
 * they captain). Organizers can set any team.
 *
 * Usage:  .setstadium <stadium name>
 *         .setstadium team=<Team Name> <stadium name>   (pick one of your teams)
 *         .setstadium <team name> <stadium name>        (organizer only)
 * Slash:  /setstadium stadium:<name> [team:<name>]
 *
 * Aliases: stadium
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const { isOrganizer } = require('../../utils/isOrganizer');
const { Team } = require('../../models/Tournament');
const { parseTeamToken, resolveManagedTeam } = require('../../utils/teamResolver');

module.exports = {
    name: 'setstadium',
    description: 'Set your team stadium, or set any team stadium as organizer.',
    usage: '.setstadium [team=<name>] <stadium name> | Organizer: .setstadium <team name> <stadium name>',
    aliases: ['stadium'],
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('setstadium')
        .setDescription('Set team stadium')
        .addStringOption(opt =>
            opt.setName('stadium')
                .setDescription('Home stadium name')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team name (captain: one of your teams • organizer: any team)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            const guildId = message.guild.id;
            const userId = message.author.id;
            const organizer = await isOrganizer(guildId, userId);

            if (!args.length) {
                return message.reply(
                    '❓ Usage:\n' +
                    'Captain: `.setstadium Santiago Bernabeu`\n' +
                    'Captain, specific team: `.setstadium team=Bravo Santiago Bernabeu`\n' +
                    'Organizer: `.setstadium Falcons Santiago Bernabeu`'
                );
            }

            const token = await parseTeamToken(guildId, userId, args);

            let parsed;
            if (organizer && !token.teamName) {
                // Organizer legacy flexible parsing (match leading args to any team)
                parsed = await parseOrganizerTeamAndValue(guildId, args);
            } else {
                const rest = token.teamName ? token.rest : args;
                parsed = {
                    teamName: token.teamName,
                    value: rest.join(' ').trim()
                };
            }

            return await runSetStadium({
                guild: message.guild,
                userId,
                organizer,
                teamName: parsed.teamName,
                stadiumName: parsed.value,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[setstadium] prefix error:', error);
            return message.reply('❌ Failed to update stadium.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const organizer = await isOrganizer(interaction.guild.id, interaction.user.id);

            return await runSetStadium({
                guild: interaction.guild,
                userId: interaction.user.id,
                organizer,
                teamName: interaction.options.getString('team'),
                stadiumName: interaction.options.getString('stadium'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[setstadium] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to update stadium.');
            }

            return interaction.reply({
                content: '❌ Failed to update stadium.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Set a team's stadium.
 * Team resolution via resolveManagedTeam (organizer: any, captain: own teams).
 */
async function runSetStadium({ guild, userId, organizer, teamName, stadiumName, reply }) {
    const resolved = await resolveManagedTeam({
        guildId: guild.id,
        userId,
        organizer,
        teamName
    });

    if (resolved.status === 'ambiguous') {
        const list = resolved.teams.map(t => `• **${t.name}**`).join('\n');
        return reply({
            content:
                `🤔 You manage more than one team:\n${list}\n\n` +
                `Specify which one:\n` +
                `Prefix: \`.setstadium team=<Team Name> <stadium name>\`\n` +
                `Slash: \`/setstadium stadium:<name> team:<Team Name>\``
        });
    }

    if (resolved.status === 'not_found') {
        return reply({ content: `❌ Team not found: \`${resolved.teamName}\`` });
    }

    if (resolved.status === 'not_yours') {
        const list = resolved.teams.length
            ? `\nYour teams:\n${resolved.teams.map(t => `• **${t.name}**`).join('\n')}`
            : '';
        return reply({
            content: `🚫 **${resolved.teamName}** is not one of your teams.${list}`
        });
    }

    if (!resolved.team) {
        return reply({
            content: organizer
                ? '🚫 Organizers must name a team: `.setstadium <team name> <stadium name>`.'
                : '🚫 You are not a **Team Captain / Vice Captain** of any team yet.'
        });
    }

    const cleanName = String(stadiumName || '').trim();

    if (!cleanName || cleanName.length < 2) {
        return reply({ content: '❌ Please provide a valid stadium name.' });
    }

    if (cleanName.length > 80) {
        return reply({ content: '❌ Stadium name is too long. Keep it under 80 characters.' });
    }

    const team = resolved.team;
    team.stadium = cleanName;
    await team.save();

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🏟️ STADIUM UPDATED')
        .setDescription(
            `**${team.name}** will now play home matches at:\n` +
            `**${cleanName}**`
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   HELPERS
==================================================== */

/**
 * For prefix organizer usage, try to match the first N args to a known team name.
 * Returns { teamName, value } where value is the remaining args.
 */
async function parseOrganizerTeamAndValue(guildId, args) {
    const teams = await Team.find({ guildId }).select('name').lean();

    let bestMatch = null;
    let bestLength = 0;

    for (let i = 1; i < args.length; i++) {
        const possibleTeamName = args.slice(0, i).join(' ').trim().toLowerCase();

        const matchedTeam = teams.find(team =>
            team.name.toLowerCase() === possibleTeamName
        );

        if (matchedTeam && i > bestLength) {
            bestMatch = matchedTeam.name;
            bestLength = i;
        }
    }

    if (bestMatch) {
        return {
            teamName: bestMatch,
            value: args.slice(bestLength).join(' ').trim()
        };
    }

    return {
        teamName: null,
        value: args.join(' ').trim()
    };
}
