/**
 * setcolor.js
 *
 * Set your team color, or set any team color as organizer.
 * Captain/VC can set their own team's color (including per-tournament teams
 * they captain). Organizers can set any team.
 *
 * Usage:  .setcolor <color name OR hex>
 *         .setcolor team=<Team Name> <color>   (pick one of your teams)
 *         .setcolor <team name> <color>        (organizer only)
 * Slash:  /setcolor color:<color> [team:<name>]
 *
 * Aliases: teamcolor
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const { isOrganizer } = require('../../utils/isOrganizer');
const { ServerConfig } = require('../../models/Tournament');
const { resolveManagedTeamInTournament } = require('../../utils/teamResolver');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const { parseTeamTokenInTournament } = require('../../utils/tournamentContext');

module.exports = {
    name: 'setcolor',
    description: 'Set your team color, or set any team color as organizer.',
    usage: '.setcolor [team=<name>] <color name OR hex> [tournament=<key>] | Organizer: .setcolor <team name> <color>',
    aliases: ['teamcolor'],
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('setcolor')
        .setDescription('Set team color')
        .addStringOption(opt =>
            opt.setName('color')
                .setDescription('Color name or hex code')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('team')
                .setDescription('Team name (captain: one of your teams • organizer: any team)')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
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
                    'Captain: `.setcolor red`\n' +
                    'Captain, specific team: `.setcolor team=Bravo red`\n' +
                    'Organizer: `.setcolor Falcons red`'
                );
            }

            let colorInput;
            let teamName;

            // Optional tournament=<key> token (never a loose word)
            const parsedKey = await extractTournamentFromArgs(guildId, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const resolvedTournament = await resolveTournament(
                guildId,
                parsedKey.explicit ? parsedKey.tournament.tournamentKey : null
            );
            if (!resolvedTournament.tournament) {
                return message.reply(resolvedTournament.error);
            }
            const tournament = resolvedTournament.tournament;

            if (organizer) {
                // Organizer: last arg is the color, the rest is the team name
                colorInput = parsedKey.rest[parsedKey.rest.length - 1];
                teamName = parsedKey.rest.length > 1
                    ? parsedKey.rest.slice(0, -1).join(' ').trim()
                    : null;
            } else {
                // Captain: optional team= token, last remaining arg is the color
                const token = await parseTeamTokenInTournament(guildId, tournament, parsedKey.rest);
                const rest = token.teamName ? token.rest : parsedKey.rest;

                if (!rest.length) {
                    return message.reply(
                        '❓ Usage:\n' +
                        'Captain: `.setcolor red`\n' +
                        'Captain, specific team: `.setcolor team=Bravo red`'
                    );
                }

                colorInput = rest[rest.length - 1];
                teamName = token.teamName;
            }

            return await runSetColor({
                guild: message.guild,
                userId,
                organizer,
                teamName,
                colorInput,
                tournament,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[setcolor] prefix error:', error);
            return message.reply('❌ Failed to update team color.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            const organizer = await isOrganizer(interaction.guild.id, interaction.user.id);

            return await runSetColor({
                guild: interaction.guild,
                userId: interaction.user.id,
                organizer,
                teamName: interaction.options.getString('team'),
                colorInput: interaction.options.getString('color'),
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[setcolor] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to update team color.');
            }

            return interaction.reply({
                content: '❌ Failed to update team color.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   COLOR MAP
==================================================== */

/** Named color to hex map. */
const COLOR_MAP = {
    red: '#FF0000',
    blue: '#3498DB',
    green: '#2ECC71',
    yellow: '#F1C40F',
    orange: '#E67E22',
    purple: '#9B59B6',
    pink: '#E91E63',
    black: '#111111',
    white: '#FFFFFF',
    grey: '#808080',
    gray: '#808080',
    cyan: '#00FFFF',
    teal: '#1ABC9C',
    gold: '#FFD700',
    silver: '#C0C0C0',
    maroon: '#800000',
    navy: '#000080'
};

/**
 * Parse a color input (name or hex) into a hex string.
 * Returns { ok: true, hex } or { ok: false }.
 */
function parseColorInput(input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false };

    const lower = raw.toLowerCase();
    if (COLOR_MAP[lower]) return { ok: true, hex: COLOR_MAP[lower] };

    const cleaned = raw.replace('#', '').toUpperCase();
    if (/^[0-9A-F]{6}$/.test(cleaned)) return { ok: true, hex: `#${cleaned}` };

    return { ok: false };
}

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Set a team's color.
 * Team resolution via resolveManagedTeam (organizer: any, captain: own teams).
 */
async function runSetColor({ guild, userId, organizer, teamName, colorInput, tournament = null, tournamentKey = null, reply }) {
    const serverConfig = await ServerConfig.findOne({ guildId: guild.id }).lean();
    if (serverConfig?.teamRoleColorsEnabled === false) {
        return reply({
            content:
                '🎨 Team-role color changes are disabled in this server. Existing role colors are being preserved. ' +
                'An organizer can re-enable them with `.teamrolecolors on`.'
        });
    }

    if (!tournament) {
        const r = await resolveTournament(guild.id, tournamentKey);
        if (!r.tournament) return reply({ content: r.error });
        tournament = r.tournament;
    }

    const resolved = await resolveManagedTeamInTournament({
        guildId: guild.id,
        tournament,
        userId,
        organizer,
        teamName
    });

    if (resolved.status === 'none') {
        return reply({
            content:
                `❌ You are not the captain or vice captain of a team in **${tournament.name}**.` +
                (tournamentKey ? '' : '\nManaging a team in another tournament? Add `tournament=<key>`.')
        });
    }

    if (resolved.status === 'ambiguous') {
        const list = resolved.teams.map(t => `• **${t.name}**`).join('\n');
        return reply({
            content:
                `🤔 You manage more than one team:\n${list}\n\n` +
                `Specify which one:\n` +
                `Prefix: \`.setcolor team=<Team Name> <color>\`\n` +
                `Slash: \`/setcolor color:<color> team:<Team Name>\``
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
                ? '🚫 Organizers must name a team: `.setcolor <team name> <color>`.'
                : '🚫 You are not a **Team Captain / Vice Captain** of any team yet.'
        });
    }

    const parsed = parseColorInput(colorInput);

    if (!parsed.ok) {
        return reply({
            content:
                '❌ Invalid color.\n' +
                'Use a hex code like `#FF0000` or a color name like `red`, `blue`, `gold`, `purple`.'
        });
    }

    const team = resolved.team;
    team.color = parsed.hex;
    await team.save();

    const embed = new EmbedBuilder()
        .setColor(parseInt(parsed.hex.replace('#', ''), 16))
        .setTitle('🎨 TEAM COLOR UPDATED')
        .setDescription(
            `**${team.name}** color updated.\n\n` +
            `Color: \`${parsed.hex}\``
        )
        .setTimestamp();

    return reply({ embeds: [embed] });
}

module.exports.runSetColor = runSetColor;
