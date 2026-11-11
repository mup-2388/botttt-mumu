/**
 * resettournament.js
 *
 * Reset data for one specific tournament safely.
 * Supports multiple modes: fixtures, draw, stats, players, teams, settings, all.
 * Requires explicit confirmation to prevent accidental resets.
 */
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const {
    TournamentSettings,
    Fixture,
    TournamentTeam,
    TournamentPlayer,
    UserProfile
} = require('../../models/Tournament');

const { getDrawKey } = require('../../utils/drawBoard');
const { isOrganizer } = require('../../utils/isOrganizer');
const { resolveTournament } = require('../../utils/getTournament');
const { clearDefaultPointer } = require('../../utils/tournamentCleanup');
const LiveMessage = require('../../models/LiveMessage');

module.exports = {
    name: 'resettournament',
    description: 'Reset data for one specific tournament safely.',
    usage: '.resettournament [tournamentKey] mode=<fixtures|draw|stats|players|teams|settings|all> --confirm  (key omitted = default tournament)',
    aliases: ['rtreset', 'treset'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('resettournament')
        .setDescription('Reset data for one specific tournament')
        .addStringOption(opt =>
            opt.setName('mode')
                .setDescription('What to reset')
                .setRequired(true)
                .addChoices(
                    { name: 'Fixtures Only', value: 'fixtures' },
                    { name: 'Draw Session Only', value: 'draw' },
                    { name: 'Stats Only', value: 'stats' },
                    { name: 'Tournament Players Only', value: 'players' },
                    { name: 'Tournament Teams Only', value: 'teams' },
                    { name: 'Settings Only', value: 'settings' },
                    { name: 'All Tournament Data', value: 'all' }
                )
        )
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

            return await runReset({
                client: message.client,
                guild: message.guild,
                tournamentKey: parsed.tournamentKey,
                mode: parsed.mode,
                confirm: parsed.confirm,
                actorTag: message.author.tag,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[resettournament] prefix error:', error);
            return message.reply('❌ Failed to reset tournament data.');
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

            return await runReset({
                client: interaction.client,
                guild: interaction.guild,
                tournamentKey: interaction.options.getString('key')?.toLowerCase() || null,
                mode: interaction.options.getString('mode'),
                confirm: interaction.options.getBoolean('confirm'),
                actorTag: interaction.user.tag,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[resettournament] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to reset tournament data.');
            }

            return interaction.reply({
                content: '❌ Failed to reset tournament data.',
                ephemeral: true
            });
        }
    }
};

function parsePrefixArgs(args) {
    let tournamentKey = null;
    let mode = null;
    let confirm = false;

    for (const arg of args) {
        if (arg === '--confirm') {
            confirm = true;
            continue;
        }

        if (arg.toLowerCase().startsWith('mode=')) {
            mode = arg.split('=')[1]?.trim()?.toLowerCase();
            continue;
        }

        if (/^(tournament|key)=/i.test(arg)) {
            tournamentKey = arg.split('=')[1]?.trim()?.toLowerCase() || null;
            continue;
        }

        // First loose word = tournament key; omitted → default tournament
        if (!tournamentKey) tournamentKey = arg.toLowerCase();
    }

    const validModes = [
        'fixtures',
        'draw',
        'stats',
        'players',
        'teams',
        'settings',
        'all'
    ];

    if (!mode || !validModes.includes(mode)) {
        return {
            ok: false,
            error:
                '❌ Invalid usage.\n' +
                'Example: `.resettournament league-s1 mode=fixtures --confirm`\n' +
                'Key omitted = the **default tournament**: `.resettournament mode=stats --confirm`\n\n' +
                'Modes: `fixtures`, `draw`, `stats`, `players`, `teams`, `settings`, `all`\n\n' +
                'To remove a tournament completely (incl. leftover global teams/players) use `.deletetournament <key>`.'
        };
    }

    return {
        ok: true,
        tournamentKey,
        mode,
        confirm
    };
}

async function runReset({
    client,
    guild,
    tournamentKey,
    mode,
    confirm,
    actorTag,
    reply
}) {
    if (!confirm) {
        return reply({
            content:
                '⚠️ Reset blocked.\n' +
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

    const summaryLines = [];

    if (mode === 'draw') {
        await clearDrawSession({
            client,
            guildId: guild.id,
            tournament
        }, summaryLines);

        return reply({
            embeds: [buildResetEmbed({ tournament, mode, lines: summaryLines, actorTag })]
        });
    }

    if (mode === 'fixtures') {
        await resetFixtures({
            guildId: guild.id,
            tournament
        }, summaryLines);

        await clearDrawSession({
            client,
            guildId: guild.id,
            tournament
        }, summaryLines);

        return reply({
            embeds: [buildResetEmbed({ tournament, mode, lines: summaryLines, actorTag })]
        });
    }

    if (mode === 'stats') {
        await resetStats({
            guildId: guild.id,
            tournament
        }, summaryLines);

        return reply({
            embeds: [buildResetEmbed({ tournament, mode, lines: summaryLines, actorTag })]
        });
    }

    if (mode === 'players') {
        await resetTournamentPlayers({
            guildId: guild.id,
            tournament
        }, summaryLines);

        return reply({
            embeds: [buildResetEmbed({ tournament, mode, lines: summaryLines, actorTag })]
        });
    }

    if (mode === 'teams') {
        await resetTournamentTeams({
            guildId: guild.id,
            tournament
        }, summaryLines);

        await resetTournamentPlayers({
            guildId: guild.id,
            tournament
        }, summaryLines);

        await resetFixtures({
            guildId: guild.id,
            tournament
        }, summaryLines);

        await clearDrawSession({
            client,
            guildId: guild.id,
            tournament
        }, summaryLines);

        return reply({
            embeds: [buildResetEmbed({ tournament, mode, lines: summaryLines, actorTag })]
        });
    }

    if (mode === 'settings') {
        await resetTournamentSettings({
            guildId: guild.id,
            tournament
        }, summaryLines);

        return reply({
            embeds: [buildResetEmbed({ tournament, mode, lines: summaryLines, actorTag })]
        });
    }

    if (mode === 'all') {
        await resetFixtures({
            guildId: guild.id,
            tournament
        }, summaryLines);

        await resetTournamentPlayers({
            guildId: guild.id,
            tournament
        }, summaryLines);

        await resetTournamentTeams({
            guildId: guild.id,
            tournament
        }, summaryLines);

        await clearProfileTournamentRecords({
            guildId: guild.id,
            tournament
        }, summaryLines);

        await clearDrawSession({
            client,
            guildId: guild.id,
            tournament
        }, summaryLines);

        await resetTournamentSettings({
            guildId: guild.id,
            tournament
        }, summaryLines);

        return reply({
            embeds: [buildResetEmbed({ tournament, mode, lines: summaryLines, actorTag })]
        });
    }

    return reply({
        content: '❌ Invalid reset mode.'
    });
}

async function resetFixtures({ guildId, tournament }, summaryLines) {
    const result = await Fixture.deleteMany({
        guildId,
        tournamentId: tournament._id
    });

    summaryLines.push(`Fixtures deleted: **${result.deletedCount || 0}**`);
}

async function resetStats({ guildId, tournament }, summaryLines) {
    const playerResult = await TournamentPlayer.updateMany(
        {
            guildId,
            tournamentId: tournament._id
        },
        {
            $set: {
                'stats.played': 0,
                'stats.goals': 0,
                'stats.assists': 0,
                'stats.saves': 0,
                'stats.tackles': 0,
                'stats.interceptions': 0,
                'stats.yc': 0,
                'stats.rc': 0,
                'stats.mvps': 0
            }
        }
    );

    const teamResult = await TournamentTeam.updateMany(
        {
            guildId,
            tournamentId: tournament._id
        },
        {
            $set: {
                'stats.played': 0,
                'stats.wins': 0,
                'stats.draws': 0,
                'stats.losses': 0,
                'stats.gf': 0,
                'stats.ga': 0,
                'stats.points': 0
            }
        }
    );

    summaryLines.push(`Tournament player stats reset: **${playerResult.modifiedCount || 0}**`);
    summaryLines.push(`Tournament team standings reset: **${teamResult.modifiedCount || 0}**`);
}

async function resetTournamentPlayers({ guildId, tournament }, summaryLines) {
    const result = await TournamentPlayer.deleteMany({
        guildId,
        tournamentId: tournament._id
    });

    summaryLines.push(`Tournament player entries deleted: **${result.deletedCount || 0}**`);
}

async function resetTournamentTeams({ guildId, tournament }, summaryLines) {
    const result = await TournamentTeam.deleteMany({
        guildId,
        tournamentId: tournament._id
    });

    summaryLines.push(`Tournament team entries deleted: **${result.deletedCount || 0}**`);
}

async function resetTournamentSettings({ guildId, tournament }, summaryLines) {
    const result = await TournamentSettings.deleteOne({
        guildId,
        _id: tournament._id
    });

    summaryLines.push(`Tournament settings deleted: **${result.deletedCount || 0}**`);

    // Live standings / top-stats messages that belonged to this tournament
    await LiveMessage.deleteMany({
        guildId,
        tournamentKey: tournament.tournamentKey
    }).catch(() => null);

    // Don't leave the server default pointing at a tournament that is gone
    if (result.deletedCount) {
        const cleared = await clearDefaultPointer(guildId, tournament.tournamentKey);
        if (cleared) {
            summaryLines.push(
                '⚠️ This was the **default tournament** — default cleared. ' +
                'Use `.setdefaulttournament <key>` to pick a new one.'
            );
        }
    }
}

async function clearProfileTournamentRecords({ guildId, tournament }, summaryLines) {
    const result = await UserProfile.updateMany(
        {
            guildId
        },
        {
            $pull: {
                trophies: {
                    tournamentKey: tournament.tournamentKey
                },
                awards: {
                    tournamentKey: tournament.tournamentKey
                }
            }
        }
    ).catch(() => ({
        modifiedCount: 0
    }));

    summaryLines.push(`Profile trophies/awards removed: **${result.modifiedCount || 0}**`);
}

async function clearDrawSession({ client, guildId, tournament }, summaryLines) {
    if (!client?.liveSettings) {
        summaryLines.push('Draw session cleared: **Skipped — liveSettings missing**');
        return;
    }

    const drawKey = getDrawKey(guildId);
    const session = client.liveSettings.get(drawKey);

    if (!session) {
        summaryLines.push('Draw session cleared: **No active draw**');
        return;
    }

    if (
        session.tournamentKey &&
        session.tournamentKey !== tournament.tournamentKey
    ) {
        summaryLines.push(
            `Draw session cleared: **Skipped — active draw belongs to \`${session.tournamentKey}\`**`
        );
        return;
    }

    client.liveSettings.delete(drawKey);

    summaryLines.push('Draw session cleared: **Yes**');
}

function buildResetEmbed({
    tournament,
    mode,
    lines,
    actorTag
}) {
    return new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle(`🧹 TOURNAMENT RESET — ${mode.toUpperCase()}`)
        .setDescription(
            `${tournament.emoji || '🏆'} Tournament: **${tournament.name}**\n` +
            `Key: \`${tournament.tournamentKey}\`\n\n` +
            lines.join('\n')
        )
        .addFields({
            name: 'Unaffected',
            value:
                'Global teams and global players were not deleted (other tournaments in this server were not touched).\n' +
                'To remove a tournament completely, including its leftover global teams/players, use `.deletetournament <key>` ' +
                '(or `.purgeorphans` to clean leftovers of an already-reset tournament).',
            inline: false
        })
        .setFooter({
            text: `Action performed by ${actorTag}`
        })
        .setTimestamp();
}