/**
 * setlogo.js
 *
 * Set your team logo, or set any team logo as organizer.
 * Captain/VC can set their own team's logo (including per-tournament teams
 * they captain). Organizers can set any team.
 * Accepts image URLs or Discord attachments.
 *
 * Usage:  .setlogo <image link>  (or attach image)
 *         .setlogo team=<Team Name> <image link>   (pick one of your teams)
 *         .setlogo <team name> <image link>        (organizer only)
 * Slash:  /setlogo [image_url] [team:<name>]
 *
 * Aliases: logo
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const { isOrganizer } = require('../../utils/isOrganizer');
const { parseTeamToken, resolveManagedTeam } = require('../../utils/teamResolver');

module.exports = {
    name: 'setlogo',
    description: 'Set your team logo, or set any team logo as organizer.',
    usage: '.setlogo [team=<name>] <image link> (or attach) | Organizer: .setlogo <team name> <image link>',
    aliases: ['logo'],
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('setlogo')
        .setDescription('Set team logo')
        .addStringOption(opt =>
            opt.setName('image_url')
                .setDescription('Image link for logo')
                .setRequired(false)
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

            let logoURL = null;
            let teamName = null;
            let rest = args;

            // Optional explicit team= token (works for captains and organizers)
            const token = await parseTeamToken(guildId, userId, args);
            if (token.teamName) {
                teamName = token.teamName;
                rest = token.rest;
            }

            if (organizer && !teamName) {
                // Organizer legacy flexible parsing
                if (message.attachments.first()) {
                    logoURL = message.attachments.first().url;
                    if (args.length) teamName = args.join(' ').trim();
                } else {
                    const urlIndex = args.findIndex(arg => /^https?:\/\//i.test(arg));
                    if (urlIndex !== -1) {
                        logoURL = args[urlIndex];
                        if (urlIndex > 0) teamName = args.slice(0, urlIndex).join(' ').trim();
                    }
                }
            } else {
                // Captain (or organizer with team= token)
                if (message.attachments.first()) {
                    logoURL = message.attachments.first().url;
                } else {
                    const urlIndex = rest.findIndex(arg => /^https?:\/\//i.test(arg));
                    if (urlIndex !== -1) logoURL = rest[urlIndex];
                }
            }

            return await runSetLogo({
                guild: message.guild,
                userId,
                organizer,
                teamName,
                logoURL,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[setlogo] prefix error:', error);
            return message.reply('❌ Failed to update logo.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const organizer = await isOrganizer(interaction.guild.id, interaction.user.id);

            return await runSetLogo({
                guild: interaction.guild,
                userId: interaction.user.id,
                organizer,
                teamName: interaction.options.getString('team'),
                logoURL: interaction.options.getString('image_url'),
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[setlogo] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to update logo.');
            }

            return interaction.reply({
                content: '❌ Failed to update logo.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Set a team's logo.
 * Team resolution via resolveManagedTeam (organizer: any, captain: own teams).
 */
async function runSetLogo({ guild, userId, organizer, teamName, logoURL, reply }) {
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
                `Prefix: \`.setlogo team=<Team Name> <image_link>\` (or attach the image)\n` +
                `Slash: \`/setlogo team:<Team Name> image_url:<link>\``
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
                ? '🚫 Organizers must name a team: `.setlogo <team name> <image link>`.'
                : '🚫 You are not a **Team Captain / Vice Captain** of any team yet.'
        });
    }

    if (!logoURL) {
        return reply({
            content:
                '❓ Usage:\n' +
                'Captain: `.setlogo <image_link>` (or attach an image)\n' +
                'Captain, specific team: `.setlogo team=<Team Name> <image_link>`\n' +
                'Organizer: `.setlogo <team name> <image_link>` (or attach with the team name)'
        });
    }

    if (!isValidImageUrl(logoURL)) {
        return reply({
            content:
                '❌ Invalid image link.\n' +
                'Use a direct image URL ending with `.png`, `.jpg`, `.jpeg`, `.webp`, or `.gif`.'
        });
    }

    const team = resolved.team;
    team.logoURL = logoURL;
    await team.save();

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('🛡️ TEAM LOGO UPDATED')
        .setDescription(`Logo updated for **${team.name}**.`)
        .setImage(logoURL)
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   HELPERS
==================================================== */

/** Check if a URL points to a valid image format. */
function isValidImageUrl(url) {
    const value = String(url || '').trim();

    if (!/^https?:\/\//i.test(value)) return false;

    return /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(value);
}
