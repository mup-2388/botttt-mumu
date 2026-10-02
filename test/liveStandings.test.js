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

test('live standings still works when the native image renderer cannot load', async () => {
    const settings = {
        _id: 'tournament-1',
        guildId: 'guild-1',
        tournamentKey: 'default',
        name: 'Default League',
        emoji: '🏆',
        hasKnockout: false,
        qualificationSpotsPerGroup: 0,
        uclQualificationSpots: 0
    };
    const liveData = {
        _id: 'live-1',
        channelId: 'channel-1',
        messageId: 'message-1',
        groupKey: null
    };
    const teams = [
        {
            teamNameSnapshot: 'Tigers',
            teamId: { name: 'Tigers' },
            stats: { played: 1, wins: 0, draws: 0, losses: 1, gf: 0, ga: 2, points: 0 }
        },
        {
            teamNameSnapshot: 'Falcons',
            teamId: { name: 'Falcons' },
            stats: { played: 1, wins: 1, draws: 0, losses: 0, gf: 2, ga: 0, points: 3 }
        }
    ];
    let tableQuery;
    let editedPayload;
    const message = {
        edit: async payload => { editedPayload = payload; },
        delete: async () => {}
    };
    const channel = {
        messages: { fetch: async () => message },
        send: async () => ({ id: 'replacement-message' })
    };
    const LiveMessage = {
        findOne: async () => liveData,
        updateOne: async () => ({ modifiedCount: 1 })
    };

    const originalConsoleWarn = console.warn;
    console.warn = () => {};
    let standings;
    try {
        standings = requireWithMocks('../utils/updateStandings', {
            'discord.js': { AttachmentBuilder: class {} },
            '../models/Tournament': {
                TournamentSettings: { findOne: async () => settings },
                TournamentTeam: {
                    find: query => {
                        tableQuery = query;
                        return {
                            populate() { return this; },
                            lean: async () => teams
                        };
                    }
                }
            },
            '../models/LiveMessage': LiveMessage,
            './generateStandingsImage': new Proxy({}, {
                get() { throw new Error('Cannot find module @napi-rs/canvas'); }
            })
        });
    } finally {
        console.warn = originalConsoleWarn;
    }

    const originalConsoleError = console.error;
    console.error = () => {};
    let updated;
    try {
        updated = await standings.updateLiveStandings(
            { channels: { fetch: async () => channel } },
            'guild-1',
            'default'
        );
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(updated, true);
    assert.deepEqual(tableQuery, {
        guildId: 'guild-1',
        tournamentId: 'tournament-1',
        isActive: true
    });
    assert.match(editedPayload.content, /1\. Falcons/);
    assert.match(editedPayload.content, /2\. Tigers/);
    assert.deepEqual(editedPayload.attachments, []);
    assert.doesNotMatch(editedPayload.content, /Image generation unavailable/);
});

test('standings command remains loadable without the native image renderer', () => {
    class Builder {
        setName() { return this; }
        setDescription() { return this; }
        setRequired() { return this; }
        addStringOption(callback) {
            callback(new Builder());
            return this;
        }
    }

    const originalConsoleWarn = console.warn;
    console.warn = () => {};
    let command;
    try {
        command = requireWithMocks('../commands/tournament/standings-hf', {
            'discord.js': {
                ActionRowBuilder: Builder,
                ButtonBuilder: Builder,
                ButtonStyle: { Secondary: 2 },
                SlashCommandBuilder: Builder,
                StringSelectMenuBuilder: Builder,
                AttachmentBuilder: Builder
            },
            '../../models/Tournament': { TournamentTeam: {} },
            '../../utils/getTournament': {},
            '../../utils/generateStandingsImage': new Proxy({}, {
                get() { throw new Error('Cannot find module @napi-rs/canvas'); }
            }),
            '../../utils/standingsHelpers': {}
        });
    } finally {
        console.warn = originalConsoleWarn;
    }

    assert.equal(command.name, 'standings-hf');
});
