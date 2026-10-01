/**
 * flushtournament.js
 *
 * Flush a particular tournament: remove EVERY auto-synced team and player
 * entry, delete all fixtures, clear any active draw session, and switch the
 * tournament to MANUAL registration mode.
 *
 * After a flush:
 *  - The tournament is empty and back in the registration phase.
 *  - Auto-sync will NOT re-add teams/players (manualRegistration = true).
 *  - Captains register their team manually:
 *      /register team_name:<Team Name> tournament:<key>
 *  - Captains add players manually:
 *      /addplayer user:<@user> [player_name:<name>] tournament:<key>
 *
 * Global teams and global players are NOT deleted — other tournaments keep
 * working. A player/captain who is on a team in another tournament can still
 * register or join a (new) team in the flushed tournament.
 *
 * Usage:  .flushtournament <tournamentKey> --confirm
 * Slash:  /flushtournament key:<key> confirm:<true>
 *
 * Aliases: fflush, tflush
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    TournamentSettings,
    TournamentTeam,
    TournamentPlayer,
    Fixture
} = require('../../models/Tournament');

const { getDrawKey } = require('../../utils/drawBoard');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament } = require('../../utils/getTournament');

module.exports = {
    name: 'flushtournament',
    description: 'Flush a tournament (remove all teams/players, force manual registration).',
    usage: '.flushtournament [tournamentKey] --confirm  (key omitted = default tournament)',
    aliases: ['fflush', 'tflush'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('flushtournament')
        .setDescription('Flush a tournament and force manual registration')
        .addBooleanOption(opt =>
            opt.setName('confirm')
                .setDescription('Required safety confirmation')
                .setRequired(true)
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
                return message.reply('🚫 You are not authorized to use this command.');
            }

            const parsed = parsePrefixArgs(args);

            if (!parsed.ok) {
                return message.reply(parsed.error);
            }

            return await runFlush({
                client: message.client,
                guild: message.guild,
                tournamentKey: parsed.tournamentKey,
                confirm: parsed.confirm,
                actorTag: message.author.tag,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[flushtournament] prefix error:', error);
            return message.reply('❌ Failed to flush tournament.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            if (!(await isOrganizer(interaction.guild.id, interaction.user.id))) {
                return interaction.reply({
                    content: '🚫 You are not authorized to use this command.',
                    ephemeral: true
                });
            }

            await interaction.deferReply({ ephemeral: true });

            return await runFlush({
                client: interaction.client,
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                confirm: interaction.options.getBoolean('confirm'),
                actorTag: interaction.user.tag,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[flushtournament] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to flush tournament.');
            }

            return interaction.reply({
                content: '❌ Failed to flush tournament.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   PREFIX PARSING
==================================================== */

function parsePrefixArgs(args) {
    const confirm = args.includes('--confirm');

    const keyToken = args.find(a => /^(tournament|key)=/i.test(a));
    const loose = args.find(a => !a.startsWith('--') && !/^(tournament|key)=/i.test(a));

    const tournamentKey = (
        keyToken ? keyToken.split('=')[1] : loose
    )?.trim().toLowerCase() || null;

    return { ok: true, tournamentKey, confirm };
}

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Flush one tournament:
 * 1. Delete all TournamentTeam entries (auto-synced teams)
 * 2. Delete all TournamentPlayer entries
 * 3. Delete all fixtures
 * 4. Clear any active draw session belonging to this tournament
 * 5. Reset phase to registration and ENABLE manual registration mode
 */
async function runFlush({
    client,
    guild,
    tournamentKey,
    confirm,
    actorTag,
    reply
}) {
    if (!confirm) {
        return reply({
            content:
                '⚠️ Flush blocked.\n' +
                'You must explicitly confirm this action.\n\n' +
                'Prefix: use `--confirm`\n' +
                'Slash: set `confirm` to `true`'
        });
    }

    const resolved = await resolveTournament(guild.id, tournamentKey);

    if (!resolved.tournament) {
        return reply({ content: resolved.error });
    }

    const tournament = resolved.tournament;

    /* ── 1. Remove every team entry ── */
    const teamResult = await TournamentTeam.deleteMany({
        guildId: guild.id,
        tournamentId: tournament._id
    });

    /* ── 2. Remove every player entry ── */
    const playerResult = await TournamentPlayer.deleteMany({
        guildId: guild.id,
        tournamentId: tournament._id
    });

    /* ── 3. Delete all fixtures ── */
    const fixtureResult = await Fixture.deleteMany({
        guildId: guild.id,
        tournamentId: tournament._id
    });

    /* ── 4. Clear active draw session (if it belongs to this tournament) ── */
    const drawLine = clearDrawSession(client, guild.id, tournament);

    /* ── 5. Reset to registration + manual mode ── */
    await TournamentSettings.updateOne(
        { _id: tournament._id },
        {
            $set: {
                manualRegistration: true,
                registrationOpen: true,
                currentPhase: 'registration'
            }
        }
    );

    /* ── Response ── */
    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle(`🧯 TOURNAMENT FLUSHED — ${tournament.name}`)
        .setDescription(
            `${tournament.emoji || '🏆'} Key: \`${tournament.tournamentKey}\`\n\n` +
            `Teams removed: **${teamResult.deletedCount || 0}**\n` +
            `Players removed: **${playerResult.deletedCount || 0}**\n` +
            `Fixtures deleted: **${fixtureResult.deletedCount || 0}**\n` +
            `${drawLine}\n\n` +
            `Phase reset to **registration** and **manual registration is now ON** — ` +
            'auto-sync will not re-add teams to this tournament.'
        )
        .addFields(
            {
                name: 'Next Steps (Captains)',
                value:
                    `1. Register a team for this tournament:\n` +
                    `   \`/register team_name:<Team Name> tournament:${tournament.tournamentKey}\`\n` +
                    `   _(works for existing teams too, and you can create a brand new team even if you manage one in another tournament)_\n` +
                    `2. Add players to your team:\n` +
                    `   \`/addplayer user:<@user> tournament:${tournament.tournamentKey}\``,
                inline: false
            },
            {
                name: 'Unaffected',
                value:
                    'Global teams and global players were NOT deleted. Other tournaments in this server were not touched.',
                inline: false
            }
        )
        .setFooter({ text: `Action performed by ${actorTag}` })
        .setTimestamp();

    return reply({ embeds: [embed] });
}

/* ====================================================
   DRAW SESSION
==================================================== */

function clearDrawSession(client, guildId, tournament) {
    if (!client?.liveSettings) {
        return 'Draw session: **Skipped — liveSettings missing**';
    }

    const drawKey = getDrawKey(guildId);
    const session = client.liveSettings.get(drawKey);

    if (!session) {
        return 'Draw session: **No active draw**';
    }

    if (
        session.tournamentKey &&
        session.tournamentKey !== tournament.tournamentKey
    ) {
        return `Draw session: **Skipped — active draw belongs to \`${session.tournamentKey}\`**`;
    }

    client.liveSettings.delete(drawKey);
    return 'Draw session: **Cleared**';
}
