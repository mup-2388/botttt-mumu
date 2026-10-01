/**
 * nick.js
 *
 * Change a teammate's nickname IN THE BOT (stored in the
 * Player database). Does NOT touch their server nickname.
 * Captain or VC can set any teammate's bot nickname.
 * Supports "reset" to revert to their Discord username.
 *
 * Usage:  .nick @user <new nickname>
 *         .nick @user reset
 *         .nick @user <new nickname> tournament=<key>   (not the default tournament)
 * Slash:  /teamnick user:<user> nickname:<name> [tournament:<key>]
 *
 * Works for the server's DEFAULT tournament unless a tournament is given:
 * the captain / vice captain / teammate checks use the team the user is on
 * IN THAT TOURNAMENT, never a stale team from an old tournament.
 *
 * Aliases: nickname, setnick, teamnick
 */

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');

const { Player, TournamentPlayer } = require('../../models/Tournament');
const { getUserFromArgs } = require('../../utils/stringHelpers');
const { extractTournamentFromArgs } = require('../../utils/getTournament');
const {
    resolveActorTeam,
    getRosterMembership,
    effectiveCaptainId,
    sameId
} = require('../../utils/tournamentContext');

module.exports = {
    name: 'nick',
    description: 'Change a teammate\'s nickname in the bot.',
    usage: '.nick @user <new nickname>  |  .nick @user reset',
    aliases: ['nickname', 'setnick', 'teamnick'],
    hidden: false,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('teamnick')
        .setDescription('Change a teammate\'s nickname in the bot')
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Teammate to rename')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('nickname')
                .setDescription('New nickname, or "reset" to revert to Discord username')
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

            const guildId = message.guild.id;

            /*
             * Parse from the ARGUMENT LIST, never from message.content:
             * the raw content still contains the command name, which used to
             * leak into the nickname (".nick @user Bro" → "nick Bro").
             *
             * Accepted: .nick @user <nickname>
             *           .nick @user <nickname> tournament=<key>
             *           .nick @user reset
             */
            const parsedKey = await extractTournamentFromArgs(guildId, args, { tokenOnly: true });

            if (parsedKey.explicit && parsedKey.error) {
                return message.reply(parsedKey.error);
            }

            // Everything that cannot be part of a nickname
            let tokens = parsedKey.rest
                .filter(arg => !/^<@!?\d+>$/.test(arg))          // mentions
                .filter(arg => !/^\d{17,20}$/.test(arg))         // raw user IDs
                .filter(arg => !/^(tournament|key|t)=/i.test(arg));

            /* ── Resolve the target user ── */
            const mentioned = message.mentions.users.first();

            let target = mentioned;
            let nicknameTokens = tokens;

            if (!target) {
                // Try the longest prefix first so "alice Bro" → user "alice", nick "Bro"
                for (let k = tokens.length; k >= 1; k--) {
                    const candidate = await getUserFromArgs(message, tokens.slice(0, k))
                        .catch(() => null);

                    if (candidate?.id) {
                        target = candidate;
                        nicknameTokens = tokens.slice(k);
                        break;
                    }
                }
            }

            if (!target) {
                return message.reply(
                    '❓ Usage: `.nick @user <new nickname>` or `.nick @user reset`'
                );
            }

            /* ── Strip tokens that were only there to name the target ── */
            if (!mentioned && nicknameTokens.length === tokens.length) {
                const player = await Player.findOne({
                    guildId,
                    discordID: target.id
                }).lean();

                const names = [
                    target.username,
                    target.displayName,
                    player?.name,
                    player?.discordUsername
                ]
                    .filter(Boolean)
                    .map(n => String(n).toLowerCase());

                for (let k = Math.min(tokens.length, 5); k >= 1; k--) {
                    if (names.includes(tokens.slice(0, k).join(' ').toLowerCase())) {
                        nicknameTokens = tokens.slice(k);
                        break;
                    }
                }
            }

            const nickname = nicknameTokens.join(' ').trim();

            if (!nickname) {
                return message.reply(
                    '❓ Usage: `.nick @user <new nickname>` or `.nick @user reset`'
                );
            }

            return await runNick({
                guild: message.guild,
                actorId: message.author.id,
                targetUser: target,
                nickname,
                tournamentKey: parsedKey.explicit ? parsedKey.tournament.tournamentKey : null,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[nick] prefix error:', error);
            return message.reply('❌ Failed to change nickname.');
        }
    },

    /* ================================================
       SLASH
    ================================================ */

    async slashExecute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });

            const target = interaction.options.getUser('user');
            const nickname = interaction.options.getString('nickname');

            return await runNick({
                guild: interaction.guild,
                actorId: interaction.user.id,
                targetUser: target,
                nickname,
                tournamentKey: interaction.options.getString('tournament')?.toLowerCase() || null,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[nick] slash error:', error);

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to change nickname.');
            }

            return interaction.reply({ content: '❌ Failed to change nickname.', ephemeral: true });
        }
    }
};

/* ====================================================
   CORE LOGIC
==================================================== */

/**
 * Change a teammate's nickname IN THE BOT DATABASE only.
 * Does NOT touch the Discord server nickname.
 *
 * 1. Resolve the tournament (explicit key, else the server default)
 * 2. Verify actor is captain/VC of a team IN THAT TOURNAMENT
 * 3. Verify target is on the same team IN THAT TOURNAMENT
 * 4. Update Player.name (the bot nickname) + TournamentPlayer snapshots
 */
async function runNick({ guild, actorId, targetUser, nickname, tournamentKey = null, reply }) {
    /* ── Find actor's team in the tournament + check captain / VC ── */
    const { tournament, ctx, error } = await resolveActorTeam({
        guildId: guild.id,
        userId: actorId,
        tournamentKey,
        need: 'manage',
        noun: 'change player nicknames'
    });

    if (error) return reply({ content: error });

    const { team, entry } = ctx;

    /* ── Find target player + check same team in this tournament ── */
    const { player: targetPlayer, tournamentPlayer: targetEntry } =
        await getRosterMembership(guild.id, tournament, team._id, targetUser.id);

    if (!targetPlayer) {
        return reply({ content: `❌ ${targetUser} is not registered as a player.` });
    }

    if (!targetEntry) {
        return reply({
            content:
                `❌ ${targetUser} is not in **${team.name}** (${tournament.name}). ` +
                'You can only rename your own teammates.'
        });
    }

    /* ── Can't nickname the captain (unless you ARE the captain) ── */
    const captainId = effectiveCaptainId(entry, team);
    if (sameId(captainId, targetUser.id) && !sameId(actorId, captainId)) {
        return reply({ content: '❌ Only the captain themselves can change their own nickname.' });
    }

    /* ── Resolve nickname ── */
    const isReset =
        nickname.toLowerCase() === 'reset' ||
        nickname.toLowerCase() === 'clear' ||
        nickname.toLowerCase() === 'remove';

    const newNickname = isReset ? (targetUser.username || targetUser.displayName) : nickname.slice(0, 32);

    /* ── Update Player.name in database (the nickname is global to the player) ── */
    targetPlayer.name = newNickname;
    await targetPlayer.save();

    /* ── Keep every tournament's name snapshot in sync ── */
    await TournamentPlayer.updateMany(
        { playerId: targetPlayer._id },
        { $set: { playerNameSnapshot: newNickname } }
    );

    /* ── Response ── */
    if (isReset) {
        const embed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('🏷️ NICKNAME RESET')
            .setDescription(
                `Tournament: **${tournament.name}**\n` +
                `Team: **${team.name}**\n` +
                `Player: ${targetUser}\n` +
                `Bot nickname reverted to their Discord username: **${newNickname}**`
            )
            .setFooter({ text: 'Only the bot nickname was changed — server nickname is untouched.' })
            .setTimestamp();

        return reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🏷️ NICKNAME CHANGED')
        .setDescription(
            `Tournament: **${tournament.name}**\n` +
            `Team: **${team.name}**\n` +
            `Player: ${targetUser}\n` +
            `Bot Nickname: **${newNickname}**`
        )
        .setFooter({ text: 'Only the bot nickname was changed — server nickname is untouched.' })
        .setTimestamp();

    return reply({ embeds: [embed] });
}
