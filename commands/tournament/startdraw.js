/**
 * startdraw.js
 *
 * Start a public tournament draw (group or knockout).
 * Organizer reveals teams one-by-one with interactive buttons.
 *
 * Usage:  .startdraw [tournamentKey] [groups|knockout] [phase]
 * Slash:  /startdraw key:<value> stage:<value> phase:<value>
 * Aliases: drawstart, groupdraw
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');

const {
    TournamentTeam
} = require('../../models/Tournament');

const {
    getDefaultTournament,
    getTournamentByKey
} = require('../../utils/getTournament');

const {
    getDrawKey
} = require('../../utils/drawBoard');

const { prettyPhase } = require('../../utils/displayHelpers');
const { isOrganizer } = require('../../utils/isOrganizer');
const { vsLine, slotEmoji } = require('../../utils/ai/emojiSlots');

module.exports = {
    name: 'startdraw',
    description: 'Start a public tournament draw.',
    usage: '.startdraw [tournamentKey] [groups|knockout] [phase]',
    aliases: ['drawstart', 'groupdraw'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('startdraw')
        .setDescription('Start tournament draw')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Optional tournament key')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('stage')
                .setDescription('Draw stage')
                .setRequired(false)
                .addChoices(
                    { name: 'Groups', value: 'groups' },
                    { name: 'Knockout', value: 'knockout' }
                )
        )
        .addStringOption(opt =>
            opt.setName('phase')
                .setDescription('Knockout phase, example: quarterfinal, semifinal, final')
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

            return await runStartDraw({
                client: message.client,
                guild: message.guild,
                channel: message.channel,
                starterId: message.author.id,
                key: parsed.key,
                stage: parsed.stage,
                phase: parsed.phase,
                reply: payload => message.channel.send(payload)
            });
        } catch (error) {
            console.error('[startdraw] prefix error:', error);
            return message.reply('❌ Failed to start draw.');
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

            const sent = await runStartDraw({
                client: interaction.client,
                guild: interaction.guild,
                channel: interaction.channel,
                starterId: interaction.user.id,
                key: interaction.options.getString('key')?.toLowerCase() || null,
                stage: interaction.options.getString('stage') || null,
                phase: interaction.options.getString('phase')?.toLowerCase() || null,
                reply: payload => interaction.channel.send(payload)
            });

            await interaction.editReply('✅ Draw board created.');

            return sent;
        } catch (error) {
            console.error('[startdraw] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to start draw.');
            }

            return interaction.reply({
                content: '❌ Failed to start draw.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   ARG PARSER
==================================================== */

function parsePrefixArgs(args) {
    let key = null;
    let stage = null;
    let phase = null;

    for (const raw of args) {
        const arg = String(raw || '').toLowerCase();

        if (['groups', 'group', 'knockout', 'ko'].includes(arg)) {
            stage = arg === 'group' ? 'groups' : arg === 'ko' ? 'knockout' : arg;
            continue;
        }

        if (['qualifier', 'eliminator', 'quarterfinal', 'semifinal', 'final'].includes(arg)) {
            phase = arg;
            continue;
        }

        if (!key) key = arg;
    }

    return {
        key,
        stage,
        phase
    };
}

/* ====================================================
   CORE LOGIC
==================================================== */

async function runStartDraw({
    client,
    guild,
    channel,
    starterId,
    key,
    stage,
    phase,
    reply
}) {
    if (!client.liveSettings) {
        return reply({
            content: '❌ liveSettings storage is missing on client.'
        });
    }

    const tournament = key
        ? await getTournamentByKey(guild.id, key)
        : await getDefaultTournament(guild.id);

    if (!tournament) {
        return reply({
            content: '❌ Tournament not found. Set a default tournament or provide a valid key.'
        });
    }

    const drawStage = stage || inferDefaultStage(tournament);

    if (!['groups', 'knockout'].includes(drawStage)) {
        return reply({
            content: '❌ Invalid draw stage. Use `groups` or `knockout`.'
        });
    }

    const drawKey = getDrawKey(guild.id);
    const existing = client.liveSettings.get(drawKey);

    if (existing && existing.type === 'manual_draw' && existing.status === 'active') {
        return reply({
            content:
                `❌ A draw is already active for \`${existing.tournamentKey || 'unknown'}\`.\n` +
                'Use `.canceldraw --force` before starting another draw.'
        });
    }

    if (drawStage === 'groups') {
        return startGroupDraw({
            client,
            guild,
            channel,
            tournament,
            starterId,
            drawKey,
            reply
        });
    }

    return startKnockoutDraw({
        client,
        guild,
        channel,
        tournament,
        starterId,
        drawKey,
        phase: phase || resolveKnockoutPhase(tournament),
        reply
    });
}

function inferDefaultStage(tournament) {
    if ((tournament.groupCount || 0) > 0) return 'groups';
    if (tournament.hasKnockout) return 'knockout';
    return 'groups';
}

/* ====================================================
   GROUP DRAW
==================================================== */

async function startGroupDraw({
    client,
    guild,
    tournament,
    starterId,
    drawKey,
    reply
}) {
    if (!tournament.groupCount || tournament.groupCount < 2) {
        return reply({
            content:
                '❌ Group draw requires at least 2 groups.\n' +
                'Update tournament settings first.'
        });
    }

    const entries = await TournamentTeam.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        isActive: true
    })
        .populate('teamId')
        .sort({ createdAt: 1 });

    if (entries.length < tournament.groupCount) {
        return reply({
            content:
                '❌ Not enough active tournament teams for group draw.\n' +
                `Teams: **${entries.length}**\n` +
                `Groups: **${tournament.groupCount}**`
        });
    }

    const groupKeys = Array.from(
        { length: tournament.groupCount },
        (_, i) => String.fromCharCode(65 + i)
    );

    const groups = {};
    for (const group of groupKeys) groups[group] = [];

    const alreadyAssigned = [];
    const undrawn = [];

    for (const entry of entries) {
        const teamObj = toDrawTeam(entry);

        if (entry.groupKey && groups[entry.groupKey]) {
            groups[entry.groupKey].push(teamObj);
            alreadyAssigned.push(teamObj);
        } else {
            undrawn.push(teamObj);
        }
    }

    shuffle(undrawn);

    const session = {
        type: 'manual_draw',
        status: 'active',

        guildId: guild.id,
        tournamentId: String(tournament._id),
        tournamentKey: tournament.tournamentKey,
        tournamentName: tournament.name,
        tournamentEmoji: tournament.emoji || '🏆',

        stage: 'groups',
        startedBy: starterId,
        startedAt: Date.now(),

        groups,
        groupKeys,
        remainingTeams: undrawn,
        drawnTeams: alreadyAssigned,

        boardChannelId: null,
        boardMessageId: null
    };

    const sent = await reply({
        embeds: [buildGroupDrawEmbed(session)],
        components: [buildGroupDrawRow(starterId, session)]
    });

    session.boardChannelId = sent.channel.id;
    session.boardMessageId = sent.id;

    client.liveSettings.set(drawKey, session);

    const collector = sent.createMessageComponentCollector({
        time: 60 * 60 * 1000
    });

    collector.on('collect', async interaction => {
        try {
            if (interaction.user.id !== starterId) {
                return interaction.reply({
                    content: 'Only the organizer who started this draw can use these buttons.',
                    ephemeral: true
                });
            }

            const current = client.liveSettings.get(drawKey);
            if (!current || current.status !== 'active') {
                return interaction.reply({
                    content: '❌ This draw session is no longer active.',
                    ephemeral: true
                });
            }

            if (interaction.customId === 'draw_group_team') {
                const drawn = current.remainingTeams.shift();

                if (!drawn) {
                    return interaction.reply({
                        content: '✅ All teams are already drawn. Use `.finishdraw` now.',
                        ephemeral: true
                    });
                }

                const groupKey = chooseNextGroup(current.groups, current.groupKeys);
                current.groups[groupKey].push(drawn);
                current.drawnTeams.push(drawn);

                client.liveSettings.set(drawKey, current);

                await interaction.update({
                    embeds: [buildGroupDrawEmbed(current, drawn, groupKey)],
                    components: [buildGroupDrawRow(starterId, current)]
                });

                return;
            }

            if (interaction.customId === 'draw_group_finish_hint') {
                return interaction.reply({
                    content: `Use \`.finishdraw ${current.tournamentKey}\` to finish and generate group fixtures.`,
                    ephemeral: true
                });
            }
        } catch (error) {
            console.error('[startdraw] group collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Failed to process draw.',
                    ephemeral: true
                }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        const current = client.liveSettings.get(drawKey);
        if (!current || current.status !== 'active') return;

        await sent.edit({
            components: [buildGroupDrawRow(starterId, current, true)]
        }).catch(() => null);
    });

    return sent;
}

/* ====================================================
   KNOCKOUT DRAW
==================================================== */

async function startKnockoutDraw({
    client,
    guild,
    tournament,
    starterId,
    drawKey,
    phase,
    reply
}) {
    if (!tournament.hasKnockout) {
        return reply({
            content: '❌ This tournament does not have knockouts enabled.'
        });
    }

    const entries = await TournamentTeam.find({
        guildId: guild.id,
        tournamentId: tournament._id,
        isActive: true
    })
        .populate('teamId')
        .sort({
            'stats.points': -1,
            'stats.gf': -1,
            teamNameSnapshot: 1
        });

    if (entries.length < 2) {
        return reply({
            content: '❌ At least 2 active teams are required for knockout draw.'
        });
    }

    if (entries.length % 2 !== 0) {
        return reply({
            content:
                `❌ Knockout draw needs an even number of teams.\n` +
                `Active teams found: **${entries.length}**`
        });
    }

    const remainingTeams = entries.map(toDrawTeam);
    shuffle(remainingTeams);

    const session = {
        type: 'manual_draw',
        status: 'active',

        guildId: guild.id,
        tournamentId: String(tournament._id),
        tournamentKey: tournament.tournamentKey,
        tournamentName: tournament.name,
        tournamentEmoji: tournament.emoji || '🏆',

        stage: 'knockout',
        knockoutPhase: phase,
        startedBy: starterId,
        startedAt: Date.now(),

        remainingTeams,
        currentPair: [],
        knockoutPairs: [],

        boardChannelId: null,
        boardMessageId: null
    };

    const sent = await reply({
        embeds: [buildKnockoutDrawEmbed(session)],
        components: [buildKnockoutDrawRow(starterId, session)]
    });

    session.boardChannelId = sent.channel.id;
    session.boardMessageId = sent.id;

    client.liveSettings.set(drawKey, session);

    const collector = sent.createMessageComponentCollector({
        time: 60 * 60 * 1000
    });

    collector.on('collect', async interaction => {
        try {
            if (interaction.user.id !== starterId) {
                return interaction.reply({
                    content: 'Only the organizer who started this draw can use these buttons.',
                    ephemeral: true
                });
            }

            const current = client.liveSettings.get(drawKey);
            if (!current || current.status !== 'active') {
                return interaction.reply({
                    content: '❌ This draw session is no longer active.',
                    ephemeral: true
                });
            }

            if (interaction.customId === 'draw_ko_team') {
                const drawn = current.remainingTeams.shift();

                if (!drawn) {
                    return interaction.reply({
                        content: '✅ All knockout teams are drawn. Use `.finishdraw` now.',
                        ephemeral: true
                    });
                }

                current.currentPair.push(drawn);

                if (current.currentPair.length === 2) {
                    current.knockoutPairs.push({
                        home: current.currentPair[0],
                        away: current.currentPair[1]
                    });

                    current.currentPair = [];
                }

                client.liveSettings.set(drawKey, current);

                await interaction.update({
                    embeds: [buildKnockoutDrawEmbed(current, drawn)],
                    components: [buildKnockoutDrawRow(starterId, current)]
                });

                return;
            }

            if (interaction.customId === 'draw_ko_finish_hint') {
                return interaction.reply({
                    content: `Use \`.finishdraw ${current.tournamentKey}\` to finish and generate ${current.knockoutPhase} fixtures.`,
                    ephemeral: true
                });
            }
        } catch (error) {
            console.error('[startdraw] knockout collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Failed to process draw.',
                    ephemeral: true
                }).catch(() => null);
            }
        }
    });

    collector.on('end', async () => {
        const current = client.liveSettings.get(drawKey);
        if (!current || current.status !== 'active') return;

        await sent.edit({
            components: [buildKnockoutDrawRow(starterId, current, true)]
        }).catch(() => null);
    });

    return sent;
}

/* ====================================================
   EMBED BUILDERS
==================================================== */

function buildGroupDrawEmbed(session, lastDrawn = null, lastGroup = null) {
    const groupText = session.groupKeys.map(group => {
        const teams = session.groups[group] || [];

        const body = teams.length
            ? teams.map((team, index) => `${index + 1}. ${team.name}`).join('\n')
            : '*Waiting...*';

        return `**Group ${group}**\n${body}`;
    }).join('\n\n');

    const description = [
        `${session.tournamentEmoji || '🏆'} Tournament: **${session.tournamentName}**`,
        `Key: \`${session.tournamentKey}\``,
        `Organizer: <@${session.startedBy}>`,
        '',
        lastDrawn
            ? `🎴 Last Drawn: **${lastDrawn.name}** → **Group ${lastGroup}**`
            : '🎴 Click **Draw Team** to reveal teams.',
        '',
        `Remaining Teams: **${session.remainingTeams.length}**`
    ].join('\n');

    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🏆 PUBLIC GROUP DRAW')
        .setDescription(description)
        .addFields({
            name: 'Groups',
            value: groupText || 'No groups available.',
            inline: false
        })
        .setFooter({
            text: 'Use finishdraw after all teams are drawn.'
        })
        .setTimestamp();
}

function buildKnockoutDrawEmbed(session, lastDrawn = null) {
    const pairText = session.knockoutPairs.length
        ? session.knockoutPairs.map((pair, index) =>
            `**Tie ${index + 1}:** ${vsLine(pair.home.name, pair.away.name, session.guildId)}`
        ).join('\n')
        : '*No completed pairings yet.*';

    const currentPairText = session.currentPair?.length
        ? session.currentPair.map(team => team.name).join(` ${slotEmoji('vs', session.guildId)} `)
        : '*Waiting...*';

    const description = [
        `${session.tournamentEmoji || '🏆'} Tournament: **${session.tournamentName}**`,
        `Key: \`${session.tournamentKey}\``,
        `Phase: **${prettyPhase(session.knockoutPhase)}**`,
        `Organizer: <@${session.startedBy}>`,
        '',
        lastDrawn
            ? `🎴 Last Drawn: **${lastDrawn.name}**`
            : '🎴 Click **Draw Team** to reveal teams.',
        '',
        `Remaining Teams: **${session.remainingTeams.length}**`
    ].join('\n');

    return new EmbedBuilder()
        .setColor(0xFEBE10)
        .setTitle('🏆 PUBLIC KNOCKOUT DRAW')
        .setDescription(description)
        .addFields(
            {
                name: 'Current Tie',
                value: currentPairText,
                inline: false
            },
            {
                name: 'Completed Ties',
                value: pairText,
                inline: false
            }
        )
        .setFooter({
            text: 'Use finishdraw after all ties are complete.'
        })
        .setTimestamp();
}

/* ====================================================
   COMPONENT BUILDERS
==================================================== */

function buildGroupDrawRow(starterId, session, disabled = false) {
    const isComplete = !session.remainingTeams.length;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('draw_group_team')
            .setLabel(isComplete ? 'All Teams Drawn' : '🎴 Draw Team')
            .setStyle(isComplete ? ButtonStyle.Success : ButtonStyle.Primary)
            .setDisabled(disabled || isComplete),

        new ButtonBuilder()
            .setCustomId('draw_group_finish_hint')
            .setLabel('Finish Draw')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );
}

function buildKnockoutDrawRow(starterId, session, disabled = false) {
    const isComplete = !session.remainingTeams.length && !session.currentPair.length;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('draw_ko_team')
            .setLabel(isComplete ? 'All Teams Drawn' : '🎴 Draw Team')
            .setStyle(isComplete ? ButtonStyle.Success : ButtonStyle.Primary)
            .setDisabled(disabled || isComplete),

        new ButtonBuilder()
            .setCustomId('draw_ko_finish_hint')
            .setLabel('Finish Draw')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );
}

/* ====================================================
   HELPERS
==================================================== */

function chooseNextGroup(groups, groupKeys) {
    const sorted = [...groupKeys].sort((a, b) => {
        const aSize = groups[a]?.length || 0;
        const bSize = groups[b]?.length || 0;

        if (aSize !== bSize) return aSize - bSize;

        return a.localeCompare(b);
    });

    return sorted[0];
}

function toDrawTeam(entry) {
    return {
        _id: String(entry.teamId?._id || entry.teamId),
        teamId: String(entry.teamId?._id || entry.teamId),
        tournamentTeamId: String(entry._id),
        name: entry.teamId?.name || entry.teamNameSnapshot || 'Unknown Team'
    };
}

function resolveKnockoutPhase(tournament) {
    if (Array.isArray(tournament.knockoutRounds) && tournament.knockoutRounds.length) {
        return tournament.knockoutRounds[0];
    }

    return 'semifinal';
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const random = Math.floor(Math.random() * (i + 1));
        [array[i], array[random]] = [array[random], array[i]];
    }

    return array;
}
