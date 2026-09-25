/**
 * settournament.js
 *
 * Create or update tournament settings.
 * Supports league, groups+knockout, mega table+playoffs, and custom formats.
 *
 * Usage: .settournament <key> format=league mode=auto name=League_S1 teams=10
 * Slash: /settournament key:<key> format:<format> mode:<mode> [options...]
 *
 * Aliases: tsetup, tournamentsetup
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const { TournamentSettings } = require('../../models/Tournament');
const { isOrganizer } = require('../../utils/isOrganizer');
const { syncAllTeamsToTournament } = require('../../utils/tournamentSync');

module.exports = {
    name: 'settournament',
    description: 'Create or update tournament settings.',
    usage: '.settournament <key> format=league mode=auto name=League_S1 teams=10',
    aliases: ['tsetup', 'tournamentsetup'],
    hidden: true,
    cooldown: 5,
    userPermissions: [PermissionFlagsBits.SendMessages],

    data: new SlashCommandBuilder()
        .setName('settournament')
        .setDescription('Create or update tournament settings')
        .addStringOption(opt =>
            opt.setName('key')
                .setDescription('Tournament key, example: league-s1 or cup-s1')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('format')
                .setDescription('Tournament format')
                .setRequired(true)
                .addChoices(
                    { name: 'League', value: 'league' },
                    { name: 'Groups + Knockout', value: 'groups_knockout' },
                    { name: 'Mega Table + Playoffs', value: 'mega_table_playoffs' },
                    { name: 'Custom', value: 'custom' }
                )
        )
        .addStringOption(opt =>
            opt.setName('mode')
                .setDescription('Scheduling mode')
                .setRequired(true)
                .addChoices(
                    { name: 'Auto', value: 'auto' },
                    { name: 'Manual Draw', value: 'manual_draw' },
                    { name: 'Hybrid', value: 'hybrid' }
                )
        )
        .addStringOption(opt => opt.setName('name').setDescription('Tournament name').setRequired(false))
        .addIntegerOption(opt => opt.setName('teams').setDescription('Total teams').setRequired(false).setMinValue(2))
        .addIntegerOption(opt => opt.setName('groups').setDescription('Number of groups').setRequired(false).setMinValue(0))
        .addIntegerOption(opt => opt.setName('teamspergroup').setDescription('Teams per group').setRequired(false).setMinValue(0))
        .addBooleanOption(opt => opt.setName('homeaway').setDescription('Home and away fixtures?').setRequired(false))
        .addBooleanOption(opt => opt.setName('hasknockout').setDescription('Has knockouts?').setRequired(false))
        .addStringOption(opt => opt.setName('knockoutrounds').setDescription('quarterfinal,semifinal,final').setRequired(false))
        .addStringOption(opt => opt.setName('twoleggedrounds').setDescription('semifinal,final').setRequired(false))
        .addBooleanOption(opt => opt.setName('finalneutralvenue').setDescription('Neutral final venue?').setRequired(false))
        .addIntegerOption(opt => opt.setName('pointswin').setDescription('Points for win').setRequired(false))
        .addIntegerOption(opt => opt.setName('pointsdraw').setDescription('Points for draw').setRequired(false))
        .addIntegerOption(opt => opt.setName('pointsloss').setDescription('Points for loss').setRequired(false))
        .addBooleanOption(opt => opt.setName('registrationopen').setDescription('Registration open?').setRequired(false))
        .addBooleanOption(opt =>
            opt
                .setName('manualregistration')
                .setDescription('Manual registration: no auto-sync, captains register per-tournament')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('currentphase')
                .setDescription('Current phase')
                .setRequired(false)
                .addChoices(
                    { name: 'Registration', value: 'registration' },
                    { name: 'League', value: 'league' },
                    { name: 'Groups', value: 'groups' },
                    { name: 'Knockout', value: 'knockout' },
                    { name: 'Completed', value: 'completed' }
                )
        )
        .addRoleOption(opt => opt.setName('captainrole').setDescription('Captain role').setRequired(false))
        .addRoleOption(opt => opt.setName('playerrole').setDescription('Tournament player role').setRequired(false)),

    /* ================================================
       PREFIX
    ================================================ */

    async execute(message, args) {
        try {
            if (!message.guild) return;

            if (!(await isOrganizer(message.guild.id, message.author.id))) {
                return message.reply('🚫 You are not authorized to use this command.');
            }

            if (args.length < 2) return message.reply(getHelpText());

            const tournamentKey = normalizeKey(args[0]);
            if (!isValidKey(tournamentKey)) {
                return message.reply('❌ Invalid tournament key. Example: `league-s1`, `cup-s1`');
            }

            const parsed = parsePrefixArgs(args.slice(1));
            if (parsed.error) return message.reply(`❌ ${parsed.error}\n\n${getHelpText()}`);

            return await runSetup({
                guild: message.guild,
                tournamentKey,
                data: parsed.data,
                reply: payload => message.reply(payload)
            });
        } catch (error) {
            console.error('[settournament] prefix error:', error);
            return message.reply('❌ Failed to save tournament settings.');
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

            const tournamentKey = normalizeKey(interaction.options.getString('key'));
            if (!isValidKey(tournamentKey)) {
                return interaction.editReply('❌ Invalid tournament key. Example: `league-s1`, `cup-s1`');
            }

            const captainRole = interaction.options.getRole('captainrole');
            const playerRole = interaction.options.getRole('playerrole');

            const data = {
                format: interaction.options.getString('format'),
                mode: interaction.options.getString('mode'),
                name: interaction.options.getString('name') ?? undefined,
                teams: interaction.options.getInteger('teams') ?? undefined,
                groups: interaction.options.getInteger('groups') ?? undefined,
                teamsPerGroup: interaction.options.getInteger('teamspergroup') ?? undefined,
                homeAway: interaction.options.getBoolean('homeaway') ?? undefined,
                hasKnockout: interaction.options.getBoolean('hasknockout') ?? undefined,
                knockoutRounds: parseCommaString(interaction.options.getString('knockoutrounds')),
                twoLeggedRounds: parseCommaString(interaction.options.getString('twoleggedrounds')),
                finalNeutralVenue: interaction.options.getBoolean('finalneutralvenue') ?? undefined,
                pointsWin: interaction.options.getInteger('pointswin') ?? undefined,
                pointsDraw: interaction.options.getInteger('pointsdraw') ?? undefined,
                pointsLoss: interaction.options.getInteger('pointsloss') ?? undefined,
                registrationOpen: interaction.options.getBoolean('registrationopen') ?? undefined,
                manualRegistration: interaction.options.getBoolean('manualregistration') ?? undefined,
                currentPhase: interaction.options.getString('currentphase') ?? undefined,
                captainRoleId: captainRole?.id ?? undefined,
                tournamentPlayerRoleId: playerRole?.id ?? undefined
            };

            return await runSetup({
                guild: interaction.guild,
                tournamentKey,
                data,
                reply: payload => interaction.editReply(payload)
            });
        } catch (error) {
            console.error('[settournament] slash error:', error);
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply('❌ Failed to save tournament settings.');
            }
            return interaction.reply({ content: '❌ Failed to save tournament settings.', ephemeral: true });
        }
    }
};

async function runSetup({ guild, tournamentKey, data, reply }) {
    const validation = validateSettings(data);
    if (!validation.ok) return reply({ content: `❌ ${validation.error}` });

    const payload = buildUpdatePayload(guild.id, tournamentKey, data);

    const settings = await TournamentSettings.findOneAndUpdate(
        { guildId: guild.id, tournamentKey },
        { $set: payload },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const sync = await syncAllTeamsToTournament(guild.id, settings);

    let syncLine;

    if (settings.manualRegistration === true) {
        syncLine =
            '🖐️ **Manual registration mode ON** — existing teams were NOT auto-synced.\n' +
            'Captains must register per-tournament:\n' +
            '`/register team_name:<Team Name> tournament:' + settings.tournamentKey + '`\n' +
            '`/addplayer user:<@user> tournament:' + settings.tournamentKey + '`';
    } else {
        syncLine =
            `🔄 Auto-synced teams: **${sync.syncedTeams}**\n` +
            `🔄 Auto-synced players: **${sync.syncedPlayers}**`;
    }

    return reply({
        content:
            `✅ **Tournament saved successfully.**\n\n` +
            `${buildSummary(settings)}\n\n` +
            syncLine
    });
}

function buildUpdatePayload(guildId, tournamentKey, data) {
    const payload = { guildId, tournamentKey };

    if (typeof data.name !== 'undefined') payload.name = data.name;
    if (typeof data.format !== 'undefined') payload.formatType = data.format;
    if (typeof data.mode !== 'undefined') payload.schedulingMode = data.mode;
    if (typeof data.teams !== 'undefined') payload.teamCount = data.teams;
    if (typeof data.groups !== 'undefined') payload.groupCount = data.groups;
    if (typeof data.teamsPerGroup !== 'undefined') payload.teamsPerGroup = data.teamsPerGroup;
    if (typeof data.homeAway !== 'undefined') payload.homeAway = data.homeAway;
    if (typeof data.hasKnockout !== 'undefined') payload.hasKnockout = data.hasKnockout;
    if (typeof data.knockoutRounds !== 'undefined') payload.knockoutRounds = arrayify(data.knockoutRounds);
    if (typeof data.twoLeggedRounds !== 'undefined') payload.twoLeggedRounds = arrayify(data.twoLeggedRounds);
    if (typeof data.finalNeutralVenue !== 'undefined') payload.finalNeutralVenue = data.finalNeutralVenue;
    if (typeof data.pointsWin !== 'undefined') payload.pointsWin = data.pointsWin;
    if (typeof data.pointsDraw !== 'undefined') payload.pointsDraw = data.pointsDraw;
    if (typeof data.pointsLoss !== 'undefined') payload.pointsLoss = data.pointsLoss;
    if (typeof data.registrationOpen !== 'undefined') payload.registrationOpen = data.registrationOpen;
    if (typeof data.manualRegistration !== 'undefined') payload.manualRegistration = data.manualRegistration;
    if (typeof data.currentPhase !== 'undefined') payload.currentPhase = data.currentPhase;
    if (typeof data.captainRoleId !== 'undefined') payload.captainRoleId = data.captainRoleId;
    if (typeof data.tournamentPlayerRoleId !== 'undefined') payload.tournamentPlayerRoleId = data.tournamentPlayerRoleId;
    if (typeof data.emoji !== 'undefined') payload.emoji = data.emoji;

    return payload;
}

function parsePrefixArgs(args) {
    const data = {};

    for (const token of args) {
        const eq = token.indexOf('=');
        if (eq === -1) return { error: `Invalid token: \`${token}\`. Use key=value.` };

        const key = token.slice(0, eq).trim();
        const raw = token.slice(eq + 1).trim();

        if (!key || raw === '') return { error: `Invalid key/value: \`${token}\`.` };

        if (key.toLowerCase() === 'captainrole') {
            data.captainRoleId = extractRoleId(raw);
            if (!data.captainRoleId) return { error: 'Invalid captain role.' };
            continue;
        }

        if (key.toLowerCase() === 'playerrole') {
            data.tournamentPlayerRoleId = extractRoleId(raw);
            if (!data.tournamentPlayerRoleId) return { error: 'Invalid player role.' };
            continue;
        }

        data[key] = normalizeValue(raw, key);
    }

    normalizeAliases(data);
    return { data };
}

function normalizeAliases(data) {
    const map = {
        teamspergroup: 'teamsPerGroup',
        hasknockout: 'hasKnockout',
        knockoutrounds: 'knockoutRounds',
        twoleggedrounds: 'twoLeggedRounds',
        finalneutralvenue: 'finalNeutralVenue',
        pointswin: 'pointsWin',
        pointsdraw: 'pointsDraw',
        pointsloss: 'pointsLoss',
        registrationopen: 'registrationOpen',
        manualregistration: 'manualRegistration',
        currentphase: 'currentPhase'
    };

    for (const [from, to] of Object.entries(map)) {
        if (typeof data[from] !== 'undefined' && typeof data[to] === 'undefined') {
            data[to] = data[from];
        }
    }
}

function validateSettings(data) {
    const formats = ['league', 'groups_knockout', 'mega_table_playoffs', 'custom'];
    const modes = ['auto', 'manual_draw', 'hybrid'];
    const phases = ['registration', 'league', 'groups', 'knockout', 'completed'];
    const rounds = ['qualifier', 'eliminator', 'roundof16', 'quarterfinal', 'semifinal', 'final'];

    if (!data.format) return { ok: false, error: 'Missing `format`.' };
    if (!formats.includes(data.format)) return { ok: false, error: `Invalid format. Use: ${formats.join(', ')}` };

    if (!data.mode) return { ok: false, error: 'Missing `mode`.' };
    if (!modes.includes(data.mode)) return { ok: false, error: `Invalid mode. Use: ${modes.join(', ')}` };

    if (typeof data.currentPhase !== 'undefined' && !phases.includes(data.currentPhase)) {
        return { ok: false, error: `Invalid currentPhase. Use: ${phases.join(', ')}` };
    }

    if (typeof data.teams !== 'undefined' && data.teams < 2) {
        return { ok: false, error: '`teams` must be at least 2.' };
    }

    if (typeof data.groups !== 'undefined' && data.groups < 0) {
        return { ok: false, error: '`groups` cannot be negative.' };
    }

    for (const key of ['knockoutRounds', 'twoLeggedRounds']) {
        if (typeof data[key] !== 'undefined') {
            for (const round of arrayify(data[key])) {
                if (!rounds.includes(round)) {
                    return { ok: false, error: `Invalid round: \`${round}\`.` };
                }
            }
        }
    }

    return { ok: true };
}

function buildSummary(settings) {
    return [
        `**Key:** \`${settings.tournamentKey}\``,
        `**Name:** ${settings.name}`,
        `**Format:** ${settings.formatType}`,
        `**Mode:** ${settings.schedulingMode}`,
        `**Teams:** ${settings.teamCount}`,
        `**Groups:** ${settings.groupCount}`,
        `**Teams/Group:** ${settings.teamsPerGroup}`,
        `**Home & Away:** ${settings.homeAway ? 'Yes' : 'No'}`,
        `**Knockouts:** ${settings.hasKnockout ? 'Yes' : 'No'}`,
        `**Current Phase:** ${settings.currentPhase}`,
        `**Registration Open:** ${settings.registrationOpen ? 'Yes' : 'No'}`,
        `**Manual Registration:** ${settings.manualRegistration ? 'Yes' : 'No'}`,
        `**Captain Role:** ${settings.captainRoleId ? `<@&${settings.captainRoleId}>` : 'None'}`,
        `**Player Role:** ${settings.tournamentPlayerRoleId ? `<@&${settings.tournamentPlayerRoleId}>` : 'None'}`
    ].join('\n');
}

function normalizeValue(value, key = '') {
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);

    if (value.includes(',')) return parseCommaString(value);

    const keepUnderscore = ['format', 'mode', 'currentphase', 'currentPhase'];
    return keepUnderscore.includes(key) ? value : value.replace(/_/g, ' ');
}

function parseCommaString(value) {
    if (!value) return undefined;
    return value.split(',').map(v => v.trim()).filter(Boolean);
}

function arrayify(value) {
    if (typeof value === 'undefined') return [];
    return Array.isArray(value) ? value : [value];
}

function extractRoleId(text) {
    return String(text || '').match(/\d{17,20}/)?.[0] || null;
}

function normalizeKey(key) {
    return String(key || '').trim().toLowerCase();
}

function isValidKey(key) {
    return /^[a-z0-9-]{2,40}$/.test(key);
}

function getHelpText() {
    return (
        '**Usage:** `.settournament <key> format=<format> mode=<mode> [options]`\n' +
        '**Example:** `.settournament league-s1 format=league mode=auto name=League_S1 teams=10 homeAway=true`'
    );
}
