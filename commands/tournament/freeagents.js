/**
 * freeagents.js
 *
 * List all free agents of a tournament (players without a team in it).
 * Default tournament unless `tournament=<key>` / a tournament key is given.
 * Shows name and Discord mention, sorted alphabetically.
 *
 * Usage:  .freeagents [tournamentKey]
 * Slash:  /freeagents [tournament:<key>]
 *
 * Aliases: fas, freeagentlist
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');

const { Player, TournamentPlayer } = require('../../models/Tournament');
const { extractTournamentFromArgs, resolveTournament } = require('../../utils/getTournament');
const { getTournamentTeams, effectiveCaptainId, effectiveViceCaptainId } = require('../../utils/tournamentContext');

module.exports = {
    name: 'freeagents',
    description: 'List all free agents in the server.',
    usage: '.freeagents [tournamentKey]',
    aliases: ['fas', 'freeagentlist'],
    hidden: false,
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('freeagents')
        .setDescription('List all free agents in a tournament')
        .addStringOption(opt =>
            opt.setName('tournament')
                .setDescription('Tournament key (default: the default tournament)')
                .setRequired(false)
        ),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args = []) {
        try {
            if (!message.guild) return;

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args);
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            return await runFreeAgents({
                guild: message.guild,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[freeagents] prefix error:', error);
            return message.reply('❌ Failed to list free agents.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply();

            return await runFreeAgents({
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[freeagents] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to list free agents.');
            }

            return interaction.reply({ content: '❌ Failed to list free agents.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/** Fetch and display all players without a team in the tournament. */
async function runFreeAgents({ guild, tournamentKey = null, reply }) {
    const resolved = await resolveTournament(guild.id, tournamentKey);
    if (!resolved.tournament) return reply({ content: resolved.error });

    const tournament = resolved.tournament;

    // A missing isActive flag is a legacy active entry (the schema default).
    // Read all current assignments so explicit tournament free agents can be
    // distinguished from global team members who have not been synced yet.
    const [tournamentPlayers, teams] = await Promise.all([
        TournamentPlayer.find({
            guildId: guild.id,
            tournamentId: tournament._id,
            $or: [
                { isActive: true },
                { isActive: { $exists: false } }
            ]
        }).select('playerId teamId teamNameSnapshot').lean(),
        getTournamentTeams(guild.id, tournament)
    ]);

    const tournamentTeamIds = new Set(teams.map(({ team }) => idOf(team?._id)).filter(Boolean));
    const tournamentTeamNames = new Set(teams.map(({ team }) => normalize(team?.name)).filter(Boolean));
    const rosteredIds = new Set();
    const explicitFreeAgentIds = new Set();

    for (const entry of tournamentPlayers) {
        const playerId = idOf(entry.playerId);
        if (!playerId) continue;

        const snapshotTeamName = normalize(entry.teamNameSnapshot);
        const hasAssignedTeam = entry.teamId != null
            || (snapshotTeamName && tournamentTeamNames.has(snapshotTeamName));

        if (hasAssignedTeam) {
            rosteredIds.add(playerId);
        } else if (snapshotTeamName === 'free agent') {
            explicitFreeAgentIds.add(playerId);
        }
    }

    const leaderDiscordIds = new Set();
    for (const { entry, team } of teams) {
        const c = effectiveCaptainId(entry, team);
        const v = effectiveViceCaptainId(entry, team);
        if (c) leaderDiscordIds.add(String(c));
        if (v) leaderDiscordIds.add(String(v));
    }

    const all = await Player.find({ guildId: guild.id }).sort({ name: 1 }).lean();

    const players = all.filter(player => {
        const playerId = idOf(player._id);
        if (rosteredIds.has(playerId)) return false;
        if (player.discordID && leaderDiscordIds.has(String(player.discordID))) return false;

        // An explicitly marked tournament free-agent entry overrides global
        // affiliation. Otherwise, membership in a team active here is enough to
        // keep a global player from being mislabeled as a free agent.
        if (explicitFreeAgentIds.has(playerId)) return true;
        const globalTeamId = idOf(player.teamId);
        return !globalTeamId || !tournamentTeamIds.has(globalTeamId);
    });

    const lines = players.map((player, index) => {
        const mention = player.discordID
            ? `<@${player.discordID}>`
            : '`No Discord Linked`';

        return `${index + 1}. **${player.name}** — ${mention}`;
    });

    const embed = new EmbedBuilder()
        .setColor(0x95A5A6)
        .setTitle(`🕊️ FREE AGENTS — ${tournament.name}`)
        .setDescription(
            lines.length
                ? lines.slice(0, 50).join('\n')
                : 'No free agents found.'
        )
        .setFooter({ text: `Total free agents: ${players.length} • ${tournament.tournamentKey}` })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

function idOf(value) {
    if (value == null) return null;
    return String(value._id || value);
}

function normalize(value) {
    return String(value || '').trim().toLowerCase();
}
