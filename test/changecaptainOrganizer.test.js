const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function requireWithMocks(modulePath, mocks) {
    const resolvedPath = require.resolve(modulePath);
    const originalLoad = Module._load;
    delete require.cache[resolvedPath];

    Module._load = function (request, parent, isMain) {
        if (parent?.filename === resolvedPath && Object.prototype.hasOwnProperty.call(mocks, request)) {
            return mocks[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return require(resolvedPath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[resolvedPath];
    }
}

class FakeOption {
    setName() { return this; }
    setDescription() { return this; }
    setRequired() { return this; }
}

class FakeSlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addUserOption(configure) { configure(new FakeOption()); return this; }
    addStringOption(configure) { configure(new FakeOption()); return this; }
}

class FakeEmbedBuilder {
    setColor() { return this; }
    setTitle() { return this; }
    setDescription(value) { this.description = value; return this; }
    setTimestamp() { return this; }
}

function makeCommandHarness({ organizer = true } = {}) {
    const calls = { team: [], player: [], tournamentPlayer: [], tournamentTeam: [] };
    const team = {
        _id: 'team-retards',
        name: 'Retards United',
        captainID: 'old-global-captain',
        viceCaptainID: null
    };
    const entry = {
        _id: 'tournament-team-1',
        teamId: team._id,
        captainID: null,
        viceCaptainID: null
    };
    const tournament = {
        _id: 'tournament-1',
        tournamentKey: 'glory-cup-s4',
        name: 'Glory Cup S4',
        captainRoleId: null
    };
    const targetUser = { id: 'new-captain', toString: () => '<@new-captain>' };
    const targetPlayer = { _id: 'player-new-captain', discordID: targetUser.id };
    const targetEntry = { _id: 'tournament-player-new-captain', isViceCaptain: false };

    const command = requireWithMocks('../commands/tournament/changecaptain', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            PermissionFlagsBits: { SendMessages: 1 },
            EmbedBuilder: FakeEmbedBuilder
        },
        '../../models/Tournament': {
            Team: {
                updateOne: async (...args) => calls.team.push(args)
            },
            Player: {
                findOne: async () => null,
                updateOne: async (...args) => calls.player.push(args),
                updateMany: async (...args) => calls.player.push(args)
            },
            TournamentTeam: {
                updateOne: async (...args) => calls.tournamentTeam.push(args)
            },
            TournamentPlayer: {
                updateOne: async (...args) => calls.tournamentPlayer.push(args),
                updateMany: async (...args) => calls.tournamentPlayer.push(args)
            }
        },
        '../../utils/stringHelpers': {
            getUserFromArgs: async () => null
        },
        '../../utils/isOrganizer': {
            isOrganizer: async () => organizer
        },
        '../../utils/getTournament': {
            extractTournamentFromArgs: async () => ({}),
            resolveTournament: async () => ({ tournament, explicit: true, error: null })
        },
        '../../utils/tournamentContext': {
            resolveActorTeam: async () => { throw new Error('organizer route should not require existing captain access'); },
            getRosterMembership: async () => ({ player: targetPlayer, tournamentPlayer: targetEntry }),
            findTeamInTournamentByName: async () => ({ team, entry }),
            parseTeamTokenInTournament: async () => ({ teamName: 'Retards United', rest: [] }),
            effectiveCaptainId: (teamEntry, currentTeam) => teamEntry?.captainID || currentTeam?.captainID || null,
            effectiveViceCaptainId: (teamEntry, currentTeam) => teamEntry?.viceCaptainID ||
                (teamEntry?.captainID ? null : currentTeam?.viceCaptainID) || null,
            sameId: (a, b) => a != null && b != null && String(a) === String(b)
        }
    });

    const interaction = {
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        deferred: false,
        replied: false,
        options: {
            getUser: () => targetUser,
            getString: name => name === 'team' ? team.name : name === 'tournament' ? tournament.tournamentKey : null
        },
        deferReply: async () => { interaction.deferred = true; },
        editReply: async payload => payload
    };

    return { command, interaction, calls, team, entry, targetUser };
}

test('organizer can set a tournament-specific captain without changing global team leadership', async () => {
    const { command, interaction, calls, team, entry, targetUser } = makeCommandHarness();

    const result = await command.slashExecute(interaction);

    assert.equal(calls.tournamentTeam.length, 1);
    assert.deepEqual(calls.tournamentTeam[0], [
        { _id: entry._id },
        { $set: { captainID: targetUser.id, viceCaptainID: null } }
    ]);
    assert.equal(calls.team.length, 0);
    assert.equal(calls.player.length, 0);
    assert.deepEqual(calls.tournamentPlayer[0][1], {
        $set: { isCaptain: false, isViceCaptain: false }
    });
    assert.deepEqual(calls.tournamentPlayer[1], [
        { _id: 'tournament-player-new-captain' },
        { $set: { isCaptain: true, isViceCaptain: false } }
    ]);
    assert.equal(result.embeds[0].description.includes('Retards United'), true);
    assert.equal(team.captainID, 'old-global-captain');
});

test('non-organizer cannot set captaincy for a named team', async () => {
    const { command, interaction, calls } = makeCommandHarness({ organizer: false });

    const result = await command.slashExecute(interaction);

    assert.match(result.content, /Only an organizer can set captaincy/);
    assert.equal(calls.tournamentTeam.length, 0);
    assert.equal(calls.tournamentPlayer.length, 0);
});
