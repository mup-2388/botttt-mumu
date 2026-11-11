/**
 * transfer.js
 *
 * Two-party player transfer system.
 * Captain/VC of the new team initiates. Both the player and the old team's
 * captain/VC must accept within the timeout window.
 *
 * Everything happens INSIDE one tournament — the server's DEFAULT tournament
 * unless `tournament=<key>` is given. Both teams and the player's current team
 * are the ones registered in that tournament.
 *
 * Usage:  .transfer @user [tournament=<key>]
 * Slash:  /transfer user:<user> [tournament:<key>]
 * Aliases: tr
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const {
    Player,
    TournamentTeam,
    TournamentPlayer,
    ServerConfig
} = require('../../models/Tournament');

const { getUserFromArgs } = require('../../utils/stringHelpers');
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const {
    resolveActorTeam,
    getUserTeamInTournament,
    effectiveCaptainId,
    effectiveViceCaptainId,
    sameId
} = require('../../utils/tournamentContext');

/** How long both parties have to accept (5 minutes) */
const TRANSFER_TIMEOUT = 5 * 60 * 1000;

module.exports = {
    name: 'transfer',
    description: 'Request a player transfer with approval buttons.',
    usage: '.transfer @user [tournament=<key>]',
    aliases: ['tr'],
    hidden: false,
    cooldown: 10,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('transfer')
        .setDescription('Request a player transfer')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Player to transfer')
                .setRequired(true)
        )
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

            const parsedKey = await extractTournamentFromArgs(message.guild.id, args, { tokenOnly: true });
            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            const target = message.mentions.users.first() || await getUserFromArgs(message, parsedKey.rest);

            if (!target) {
                return message.reply('❌ Usage: `.transfer @user [tournament=<key>]`');
            }

            return await runTransferRequest({
                guild: message.guild,
                channel: message.channel,
                actorId: message.author.id,
                targetUser: target,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[transfer] prefix error:', error);
            return message.reply('❌ Failed to start transfer request.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: false });

            const target = interaction.options.getUser('user');

            return await runTransferRequest({
                guild: interaction.guild,
                channel: interaction.channel,
                actorId: interaction.user.id,
                targetUser: target,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[transfer] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to start transfer request.');
            }

            return interaction.reply({
                content: '❌ Failed to start transfer request.',
                ephemeral: true
            });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Validate the transfer request, build the approval UI, and start the collector.
 */
async function runTransferRequest({ guild, channel, actorId, targetUser, tournamentKey = null, reply }) {
    // ── Transfer lock check ──
    const config = await ServerConfig.findOne({ guildId: guild.id }).lean();
    if (config?.transfersLocked) {
        return reply({ content: '🔒 Transfers are **locked**. The transfer window is currently closed.' });
    }

    // ── Self-transfer check ──
    if (actorId === targetUser.id) {
        return reply({ content: '❌ You cannot transfer yourself.' });
    }

    // ── Verify actor is captain/VC of a team IN THIS TOURNAMENT ──
    const { tournament, ctx: actorCtx, error } = await resolveActorTeam({
        guildId: guild.id,
        userId: actorId,
        tournamentKey,
        need: 'manage',
        noun: 'request transfers'
    });

    if (error) return reply({ content: error });

    // Plain copy carrying the EFFECTIVE (per-tournament aware) captain / VC
    const newTeam = {
        ...actorCtx.team.toObject(),
        captainID: effectiveCaptainId(actorCtx.entry, actorCtx.team),
        viceCaptainID: effectiveViceCaptainId(actorCtx.entry, actorCtx.team)
    };

    // ── Find target player ──
    const targetPlayer = await Player.findOne({
        guildId: guild.id,
        discordID: targetUser.id
    });

    if (!targetPlayer) {
        return reply({ content: `❌ ${targetUser} is not registered as a player.` });
    }

    const targetCtx = await getUserTeamInTournament(guild.id, tournament, targetUser.id);

    if (!targetCtx) {
        return reply({
            content:
                `❌ ${targetUser} is currently a **FREE AGENT** in **${tournament.name}**.\n` +
                'Use `.claimplayer @user` to sign them instead.'
        });
    }

    const oldTeam = {
        ...targetCtx.team.toObject(),
        captainID: effectiveCaptainId(targetCtx.entry, targetCtx.team),
        viceCaptainID: effectiveViceCaptainId(targetCtx.entry, targetCtx.team)
    };

    // ── Same-team check ──
    if (String(oldTeam._id) === String(newTeam._id)) {
        return reply({ content: `❌ ${targetUser} is already in **${newTeam.name}**.` });
    }

    // ── Cannot transfer a captain ──
    const targetIsCaptain =
        targetCtx.isCaptain ||
        sameId(oldTeam.captainID, targetUser.id);

    if (targetIsCaptain) {
        return reply({
            content:
                `❌ ${targetUser} is currently the captain of **${oldTeam.name}**.\n\n` +
                `${targetUser}, transfer captaincy first using:\n` +
                '`.cc @newCaptain`\n\n' +
                'After captaincy is changed, try the transfer again.'
        });
    }

    // ── Determine old team approvers ──
    const oldCaptainId = oldTeam.captainID;
    const oldViceCaptainId = oldTeam.viceCaptainID;

    if (!oldCaptainId && !oldViceCaptainId) {
        return reply({
            content:
                `❌ **${oldTeam.name}** does not have a captain or vice captain set.\n` +
                'Ask an organizer to fix the team captain first.'
        });
    }

    // Primary approver is captain; fallback to VC
    const oldTeamApprover = oldCaptainId || oldViceCaptainId;

    // ── Build approval state ──
    const state = {
        playerAccepted: false,
        oldCaptainAccepted: false,
        rejected: false
    };

    const embed = buildTransferEmbed({
        status: 'pending',
        targetUser,
        oldTeam,
        newTeam,
        oldTeamApprover,
        oldViceCaptainId,
        state
    });

    const buttons = buildButtons(false);

    const message = await reply({
        content: `<@${oldTeamApprover}> <@${targetUser.id}>`,
        embeds: [embed],
        components: [buttons]
    });

    if (!message?.createMessageComponentCollector) return null;

    // ── Approval collector ──
    const collector = message.createMessageComponentCollector({
        time: TRANSFER_TIMEOUT
    });

    collector.on('collect', async (interaction) => {
        try {
            await handleTransferInteraction({
                interaction,
                targetUser,
                oldTeamApprover,
                oldViceCaptainId,
                oldCaptainId,
                state,
                guild,
                tournament,
                targetPlayer,
                oldTeam,
                newTeam,
                collector,
                message
            });
        } catch (error) {
            console.error('[transfer] collector error:', error);

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Transfer interaction failed.',
                    ephemeral: true
                }).catch(() => null);
            }
        }
    });

    collector.on('end', async (_, reason) => {
        if (reason === 'completed' || reason === 'rejected') return;

        const expiredEmbed = buildTransferEmbed({
            status: 'expired',
            targetUser,
            oldTeam,
            newTeam,
            oldTeamApprover,
            oldViceCaptainId,
            state
        });

        await message.edit({
            content: null,
            embeds: [expiredEmbed],
            components: [buildButtons(true)]
        }).catch(() => null);
    });
}

/* ====================================================
   INTERACTION HANDLER
==================================================== */

/**
 * Handle a button press during the transfer approval flow.
 */
async function handleTransferInteraction({
    interaction, targetUser, oldTeamApprover, oldViceCaptainId, oldCaptainId,
    state, guild, tournament, targetPlayer, oldTeam, newTeam, collector, message
}) {
    const userId = String(interaction.user.id);

    // ── Permission check ──
    const allowedIds = new Set([
        String(targetUser.id),
        String(oldTeamApprover)
    ]);

    // Old team's VC can also interact
    if (oldViceCaptainId) {
        allowedIds.add(String(oldViceCaptainId));
    }

    if (!allowedIds.has(userId)) {
        return interaction.reply({
            content: '❌ This transfer approval is not for you.',
            ephemeral: true
        });
    }

    // ── Reject ──
    if (interaction.customId === 'transfer_reject') {
        state.rejected = true;

        const rejectedEmbed = buildTransferEmbed({
            status: 'rejected',
            targetUser,
            oldTeam,
            newTeam,
            oldTeamApprover,
            oldViceCaptainId,
            state,
            rejectedBy: interaction.user.id
        });

        collector.stop('rejected');

        return interaction.update({
            content: null,
            embeds: [rejectedEmbed],
            components: [buildButtons(true)]
        });
    }

    // ── Accept ──
    if (interaction.customId === 'transfer_accept') {
        // Player accepts
        if (userId === String(targetUser.id)) {
            state.playerAccepted = true;
        }

        // Old team captain explicitly accepts (not VC impersonating captain)
        if (oldCaptainId && userId === String(oldCaptainId)) {
            state.oldCaptainAccepted = true;
        }

        // Old team VC can approve if no captain exists, or VC is the designated approver
        if (oldViceCaptainId && userId === String(oldViceCaptainId) && !oldCaptainId) {
            state.oldCaptainAccepted = true;
        }

        // ── Both approved → complete transfer ──
        if (state.playerAccepted && state.oldCaptainAccepted) {
            const result = await completeTransfer({ guild, tournament, targetPlayer, oldTeam, newTeam });

            const completedEmbed = buildTransferEmbed({
                status: 'completed',
                targetUser,
                oldTeam,
                newTeam,
                oldTeamApprover,
                oldViceCaptainId,
                state,
                updatedTournamentPlayers: result.updatedTournamentPlayers,
                tournamentName: tournament.name
            });

            collector.stop('completed');

            return interaction.update({
                content: null,
                embeds: [completedEmbed],
                components: [buildButtons(true)]
            });
        }

        // ── Partial approval → update embed ──
        const updatedEmbed = buildTransferEmbed({
            status: 'pending',
            targetUser,
            oldTeam,
            newTeam,
            oldTeamApprover,
            oldViceCaptainId,
            state
        });

        return interaction.update({
            embeds: [updatedEmbed],
            components: [buildButtons(false)]
        });
    }
}

/* ====================================================
   TRANSFER EXECUTION
==================================================== */

/**
 * Execute the transfer INSIDE the tournament:
 *  - the player's TournamentPlayer entry moves to the new team
 *  - a vice-captain seat on the old team is vacated
 *  - the global Player record follows only if it still points at the old team
 *    (or no team) — it is never yanked away from a team of another tournament
 */
async function completeTransfer({ guild, tournament, targetPlayer, oldTeam, newTeam }) {
    const newTournamentTeam = await TournamentTeam.findOne({
        guildId: guild.id,
        tournamentId: tournament._id,
        teamId: newTeam._id,
        isActive: true
    });

    if (!newTournamentTeam) return { updatedTournamentPlayers: 0 };

    const tp = await TournamentPlayer.findOneAndUpdate(
        {
            guildId: guild.id,
            tournamentId: tournament._id,
            playerId: targetPlayer._id
        },
        {
            $set: {
                guildId: guild.id,
                tournamentId: tournament._id,
                playerId: targetPlayer._id,
                teamId: newTeam._id,
                playerNameSnapshot: targetPlayer.name,
                teamNameSnapshot: newTeam.name,
                isActive: true,
                isCaptain: false,
                isViceCaptain: false
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Vacate a VC seat on the old team
    await TournamentTeam.updateOne(
        {
            guildId: guild.id,
            tournamentId: tournament._id,
            teamId: oldTeam._id,
            viceCaptainID: String(targetPlayer.discordID)
        },
        { $set: { viceCaptainID: null } }
    );

    // Global player record follows only when it pointed at the old team / nowhere
    if (!targetPlayer.teamId || String(targetPlayer.teamId) === String(oldTeam._id)) {
        await Player.updateOne(
            { _id: targetPlayer._id },
            {
                $set: {
                    teamId: newTeam._id,
                    teamNameSnapshot: newTeam.name,
                    isCaptain: false,
                    isViceCaptain: false
                }
            }
        );
    }

    return { updatedTournamentPlayers: tp ? 1 : 0 };
}

/* ====================================================
   EMBED BUILDER
==================================================== */

/**
 * Build a transfer embed for any status (pending, completed, rejected, expired).
 */
function buildTransferEmbed({
    status, targetUser, oldTeam, newTeam,
    oldTeamApprover, oldViceCaptainId, state,
    rejectedBy, updatedTournamentPlayers, tournamentName
}) {
    const colors = {
        pending: 0xFEE75C,
        completed: 0x57F287,
        rejected: 0xED4245,
        expired: 0x95A5A6
    };

    const titles = {
        pending: '🔁 TRANSFER REQUEST',
        completed: '✅ TRANSFER COMPLETED',
        rejected: '❌ TRANSFER REJECTED',
        expired: '⌛ TRANSFER EXPIRED'
    };

    let description = '';

    if (status === 'pending') {
        description =
            `<@${newTeam.captainID || newTeam.viceCaptainID}> wants to sign ${targetUser}.\n\n` +
            `Player: ${targetUser}\n` +
            `From: **${oldTeam.name}**\n` +
            `To: **${newTeam.name}**\n\n` +
            `Required approvals:\n` +
            `Player: ${state.playerAccepted ? '✅ Accepted' : '⏳ Waiting'}\n` +
            `Old Team <@${oldTeamApprover}>${oldViceCaptainId ? ` / <@${oldViceCaptainId}>` : ''}: ${state.oldCaptainAccepted ? '✅ Accepted' : '⏳ Waiting'}`;
    }

    if (status === 'completed') {
        description =
            `${targetUser} has joined **${newTeam.name}**.\n\n` +
            `From: **${oldTeam.name}**\n` +
            `To: **${newTeam.name}**\n` +
            `Tournament: **${tournamentName || '—'}** • records updated: **${updatedTournamentPlayers || 0}**`;
    }

    if (status === 'rejected') {
        description =
            `Transfer collapsed.\n\n` +
            `Rejected by: <@${rejectedBy}>\n` +
            `Player: ${targetUser}\n` +
            `From: **${oldTeam.name}**\n` +
            `To: **${newTeam.name}**`;
    }

    if (status === 'expired') {
        description =
            `Transfer request expired — not all approvals were received in time.\n\n` +
            `Player: ${targetUser}\n` +
            `From: **${oldTeam.name}**\n` +
            `To: **${newTeam.name}**\n\n` +
            'Run `.transfer @user` to try again.';
    }

    return new EmbedBuilder()
        .setColor(colors[status] || 0xFEE75C)
        .setTitle(titles[status] || '🔁 TRANSFER')
        .setDescription(description)
        .setTimestamp();
}

/* ====================================================
   BUTTON BUILDER
==================================================== */

/**
 * Build the accept/reject button row.
 * @param {boolean} disabled - Disable both buttons
 */
function buildButtons(disabled) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('transfer_accept')
            .setLabel('Accept')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),

        new ButtonBuilder()
            .setCustomId('transfer_reject')
            .setLabel('Reject')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );
}
