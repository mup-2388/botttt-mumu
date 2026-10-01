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

    // Everyone who IS on a team in this tournament
    const [rostered, teams] = await Promise.all([
        TournamentPlayer.find({
            guildId: guild.id,
            tournamentId: tournament._id,
            isActive: true,
            teamId: { $ne: null }
        }).select('playerId').lean(),
        getTournamentTeams(guild.id, tournament)
    ]);

    const rosteredIds = new Set(rostered.map(r => String(r.playerId)));
    const leaderDiscordIds = new Set();
    for (const { entry, team } of teams) {
        const c = effectiveCaptainId(entry, team);
        const v = effectiveViceCaptainId(entry, team);
        if (c) leaderDiscordIds.add(String(c));
        if (v) leaderDiscordIds.add(String(v));
    }

    const all = await Player.find({ guildId: guild.id }).sort({ name: 1 }).lean();

    const players = all.filter(p =>
        !rosteredIds.has(String(p._id)) &&
        !(p.discordID && leaderDiscordIds.has(String(p.discordID)))
    );

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
