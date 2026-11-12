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

class Option {
    setName() { return this; }
    setDescription() { return this; }
    setRequired() { return this; }
}

class SlashCommandBuilder {
    setName() { return this; }
    setDescription() { return this; }
    addStringOption(configure) { configure(new Option()); return this; }
}

class ActionRowBuilder {
    addComponents(...components) { this.components = components; return this; }
}

class StringSelectMenuBuilder {
    setCustomId() { return this; }
    setPlaceholder() { return this; }
    addOptions(options) { this.options = options; return this; }
}

class ButtonBuilder {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
}

class AttachmentBuilder {
    constructor(buffer, options) {
        this.buffer = buffer;
        this.name = options.name;
    }
}

async function renderStandings(tournament) {
    const calls = { bracket: 0, standings: 0, payload: null };
    const liveSettings = new Map();
    const command = requireWithMocks('../commands/tournament/standings-hf', {
        'discord.js': {
            SlashCommandBuilder,
            ActionRowBuilder,
            StringSelectMenuBuilder,
            ButtonBuilder,
            ButtonStyle: { Success: 1, Secondary: 2, Primary: 3 },
            AttachmentBuilder
        },
        '../../models/Tournament': {
            TournamentTeam: { find: () => ({ populate() { return this; }, lean: async () => [] }) }
        },
        '../../utils/getTournament': {
            getDefaultTournament: async () => tournament,
            getSelectableTournaments: async () => [tournament],
            getTournamentByKey: async () => tournament
        },
        '../../utils/generateStandingsImage': {
            generateStandingsImage: async () => {
                calls.standings += 1;
                return { buffer: Buffer.from('standings'), fileName: 'standings.png' };
            }
        },
        '../../utils/generateKnockoutBracketImage': {
            generateKnockoutBracketImage: async () => {
                calls.bracket += 1;
                return { buffer: Buffer.from('bracket'), fileName: 'knockout-bracket.png' };
            }
        },
        '../../utils/standingsHelpers': {
            sortTeams: entries => entries,
            compactName: value => value,
            getQualificationZone: () => 'neutral',
            truncate: value => value
        }
    });

    await command.slashExecute({
        guild: { id: 'guild-1' },
        user: { id: 'organizer-1' },
        client: { liveSettings },
        options: { getString: () => null },
        reply: async payload => { calls.payload = payload; }
    });

    return { ...calls, liveSettings };
}

test('standings shows the bracket only for knockout formats/stages and does not own its live-message reference', async () => {
    const straightKnockout = await renderStandings({
        tournamentKey: 'cup', name: 'Cup', formatType: 'knockout', currentPhase: 'registration', groupCount: 0
    });
    assert.equal(straightKnockout.bracket, 1);
    assert.equal(straightKnockout.standings, 0);
    assert.equal(straightKnockout.payload.files[0].name, 'knockout-bracket.png');
    assert.equal(straightKnockout.liveSettings.size, 0);

    const groupsStage = await renderStandings({
        tournamentKey: 'groups-cup', name: 'Groups Cup', formatType: 'groups_knockout', currentPhase: 'groups', groupCount: 2
    });
    assert.equal(groupsStage.bracket, 0);
    assert.equal(groupsStage.standings, 1);
    assert.equal(groupsStage.payload.files[0].name, 'standings.png');
    assert.equal(groupsStage.liveSettings.size, 0);

    const knockoutStage = await renderStandings({
        tournamentKey: 'groups-cup', name: 'Groups Cup', formatType: 'groups_knockout', currentPhase: 'quarterfinal', groupCount: 2
    });
    assert.equal(knockoutStage.bracket, 1);
    assert.equal(knockoutStage.standings, 0);
    assert.equal(knockoutStage.payload.files[0].name, 'knockout-bracket.png');
    assert.equal(knockoutStage.liveSettings.size, 0);
});
