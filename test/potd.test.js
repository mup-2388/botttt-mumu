const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

const renderCalls = [];
const imageLoads = [];
const drawCalls = [];
const renderedText = [];
const textDrawCalls = [];
const arcCalls = [];
const strokeCalls = [];
const fillRectCalls = [];
const templateImage = { width: 1254, height: 1254, name: 'original-card-template' };
const avatarImage = { width: 512, height: 512, name: 'player-avatar' };

const context = {
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    quadraticCurveTo() {},
    arc(...args) { arcCalls.push(args); },
    fill() {},
    clip() {},
    drawImage(...args) { drawCalls.push(args); },
    stroke(...args) { strokeCalls.push(args); },
    fillRect(...args) { fillRectCalls.push(args); },
    strokeText() {},
    fillText(text, x, y) {
        const value = String(text);
        renderedText.push(value);
        textDrawCalls.push({
            text: value,
            x,
            y,
            font: this.font,
            fillStyle: this.fillStyle,
            textAlign: this.textAlign,
            letterSpacing: this.letterSpacing,
            shadowColor: this.shadowColor,
            shadowBlur: this.shadowBlur,
            shadowOffsetX: this.shadowOffsetX,
            shadowOffsetY: this.shadowOffsetY
        });
    },
    measureText(text) {
        const size = Number(String(this.font || '').match(/([0-9.]+)px/)?.[1] || 16);
        const letterSpacing = Number.parseFloat(this.letterSpacing) || 0;
        return { width: String(text).length * size * 0.48 + Math.max(0, String(text).length - 1) * letterSpacing };
    },
    letterSpacing: '0px',
    scale() {},
    moveTo() {},
    lineTo() {},
    createLinearGradient() { return { addColorStop() {} }; }
};

const potdUtils = requireWithMocks('../utils/potdCard', {
    axios: { get: async () => ({ data: Buffer.from('avatar-bytes') }) },
    '@napi-rs/canvas': {
        createCanvas: (width, height) => ({
            width,
            height,
            getContext: () => context,
            toBuffer: format => {
                renderCalls.push({ format, width, height });
                return Buffer.from('rendered-potd-card');
            }
        }),
        GlobalFonts: { registerFromPath: () => true },
        loadImage: async source => {
            imageLoads.push(source);
            return typeof source === 'string' ? templateImage : avatarImage;
        }
    }
});

class FakeOptionBuilder {
    setName() { return this; }
    setDescription() { return this; }
    setRequired() { return this; }
    setMaxLength() { return this; }
    addChannelTypes() { return this; }
}

class FakeSubcommandBuilder extends FakeOptionBuilder {
    addChannelOption(callback) { callback(new FakeOptionBuilder()); return this; }
    addUserOption(callback) { callback(new FakeOptionBuilder()); return this; }
    addStringOption(callback) { callback(new FakeOptionBuilder()); return this; }
}

class FakeSlashCommandBuilder extends FakeSubcommandBuilder {
    addSubcommand(callback) { callback(new FakeSubcommandBuilder()); return this; }
}

function makeCommandHarness({
    channelId = 'potd-channel',
    playerRecord = { _id: 'player-db-1', name: 'KABIR PATEL' },
    rosterRecord = {
        playerNameSnapshot: 'KABIR PATEL',
        teamNameSnapshot: 'DOOMPUR DEVILS',
        isActive: true
    },
    teamRecord = null
} = {}) {
    const replies = [];
    const sent = [];
    const rendered = [];
    const config = { potdChannelId: channelId };
    const guild = {
        id: 'guild-1',
        channels: {
            cache: new Map(),
            fetch: async () => channel
        },
        members: {
            fetch: async () => ({
                displayName: 'Kabir',
                displayAvatarURL: options => `https://cdn.discordapp.test/player.png?size=${options.size}`
            })
        }
    };
    const channel = {
        id: channelId,
        guild,
        isTextBased: () => true,
        send: async payload => {
            sent.push(payload);
            return { id: 'potd-message' };
        }
    };
    const models = {
        ServerConfig: {
            findOne: () => ({ lean: async () => ({ ...config }) }),
            findOneAndUpdate: async (filter, update) => {
                config.potdChannelId = update.$set.potdChannelId;
                return { ...config };
            }
        },
        Player: {
            findOne: () => ({ lean: async () => playerRecord })
        },
        TournamentPlayer: {
            findOne: () => ({ lean: async () => rosterRecord })
        },
        Team: { findOne: () => ({ lean: async () => teamRecord }) }
    };
    const command = requireWithMocks('../commands/tournament/potd', {
        'discord.js': {
            SlashCommandBuilder: FakeSlashCommandBuilder,
            ChannelType: { GuildText: 0, GuildAnnouncement: 5 }
        },
        '../../models/Tournament': models,
        '../../utils/isOrganizer': { isOrganizer: async () => true },
        '../../utils/getTournament': {
            resolveTournament: async () => ({ tournament: { _id: 'default-tournament', name: 'Default League' } })
        },
        '../../utils/potdCard': {
            ...potdUtils,
            renderPotdCard: async input => {
                rendered.push(input);
                return Buffer.from('rendered-potd-card');
            }
        }
    });

    return {
        command,
        guild,
        channel,
        config,
        replies,
        sent,
        rendered,
        makeMessage: ({ args = [], user = null, mentionedChannel = null } = {}) => ({
            guild,
            author: { id: 'organizer-1' },
            content: '.potd',
            mentions: {
                users: { first: () => user },
                channels: { first: () => mentionedChannel }
            },
            reply: async payload => {
                replies.push(payload);
                return { id: 'reply-1' };
            },
            args
        })
    };
}

test('organizer can set the server POTD channel with the prefix command', async () => {
    const harness = makeCommandHarness();
    harness.config.potdChannelId = '';
    const message = harness.makeMessage({ mentionedChannel: harness.channel });

    await harness.command.execute(message, ['channel']);

    assert.equal(harness.config.potdChannelId, 'potd-channel');
    assert.match(harness.replies[0].content, /POTD cards will be posted in <#potd-channel>/);
});

test('POTD post uses the active default-tournament roster and disables all mentions', async () => {
    const harness = makeCommandHarness();
    const user = {
        id: 'player-1',
        username: 'kabir',
        displayAvatarURL: () => 'https://cdn.discordapp.test/user.png'
    };
    const message = harness.makeMessage({ args: [], user });
    const args = ['post', '<@!player-1>', '2', 'Goals,', '1', 'Assist,', '4', 'Shots', '|', 'Match', '02'];

    await harness.command.execute(message, args);

    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].files[0].name, 'potd-kabir-patel.png');
    assert.deepEqual(harness.sent[0].allowedMentions, { parse: [] });
    assert.match(harness.sent[0].content, /KABIR PATEL.*DOOMPUR DEVILS/);
    assert.deepEqual(harness.rendered[0].stats, [
        { value: '2', label: 'GOALS' },
        { value: '1', label: 'ASSIST' },
        { value: '4', label: 'SHOTS' }
    ]);
    assert.equal(harness.rendered[0].matchLabel, 'Match 02');
    assert.equal(harness.rendered[0].teamName, 'DOOMPUR DEVILS');
    assert.match(harness.replies[0].content, /Posted the POTD card/);
});

test('POTD card preserves BYE when that is the active roster team name', async () => {
    const harness = makeCommandHarness({
        playerRecord: {
            _id: 'player-db-1',
            name: 'KABIR PATEL',
            teamNameSnapshot: 'DOOMPUR DEVILS'
        },
        rosterRecord: {
            playerNameSnapshot: 'KABIR PATEL',
            teamNameSnapshot: 'BYE',
            teamId: 'team-db-1',
            isActive: true
        },
        teamRecord: { _id: 'team-db-1', name: 'DOOMPUR DEVILS' }
    });
    const user = { id: 'player-1', username: 'kabir' };
    const message = harness.makeMessage({ user });

    await harness.command.execute(message, ['post', '<@!player-1>', '2 Goals']);

    assert.equal(harness.sent.length, 1);
    assert.equal(harness.rendered[0].teamName, 'BYE');
});

test('POTD accepts BYE as a real roster team name', async () => {
    const harness = makeCommandHarness({
        playerRecord: { _id: 'player-db-1', name: 'KABIR PATEL' },
        rosterRecord: {
            playerNameSnapshot: 'KABIR PATEL',
            teamNameSnapshot: 'BYE',
            isActive: true
        }
    });
    const user = { id: 'player-1', username: 'kabir' };
    const message = harness.makeMessage({ user });

    await harness.command.execute(message, ['post', '<@!player-1>', '2 Goals']);

    assert.equal(harness.sent.length, 1);
    assert.equal(harness.rendered[0].teamName, 'BYE');
});

test('stat parser accepts value-first and label-first organizer input and caps cards at three stats', () => {
    const parsed = potdUtils.parseStats('2 Goals, Assists: 1, 4 Shots');
    assert.deepEqual(parsed, [
        { value: '2', label: 'GOALS' },
        { value: '1', label: 'ASSISTS' },
        { value: '4', label: 'SHOTS' }
    ]);
    assert.deepEqual(potdUtils.parseStats(parsed), parsed);
    assert.throws(() => potdUtils.parseStats('1 Goal, 2 Assists, 3 Saves, 4 Shots'), /up to three stats/);
});

test('avatar cleanup removes a flat neutral backdrop connected to the image edge', () => {
    const width = 10;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let pixel = 0; pixel < width * height; pixel += 1) {
        const offset = pixel * 4;
        data[offset] = 126;
        data[offset + 1] = 126;
        data[offset + 2] = 126;
        data[offset + 3] = 255;
    }
    for (let y = 3; y < 7; y += 1) {
        for (let x = 3; x < 7; x += 1) {
            const offset = (y * width + x) * 4;
            data[offset] = 180;
            data[offset + 1] = 105;
            data[offset + 2] = 80;
        }
    }

    const removed = potdUtils.removeNeutralEdgeBackground({ data }, width, height);
    assert.equal(removed, 84);
    assert.equal(data[3], 0);
    assert.equal(data[(5 * width + 5) * 4 + 3], 255);

    const monochrome = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < monochrome.length; offset += 4) {
        monochrome[offset] = 80;
        monochrome[offset + 1] = 80;
        monochrome[offset + 2] = 80;
        monochrome[offset + 3] = 255;
    }
    assert.equal(potdUtils.removeNeutralEdgeBackground({ data: monochrome }, width, height), 0);
    assert.equal(monochrome[3], 255);

    const circleSize = 20;
    const circleData = new Uint8ClampedArray(circleSize * circleSize * 4);
    for (let y = 0; y < circleSize; y += 1) {
        for (let x = 0; x < circleSize; x += 1) {
            const distance = Math.hypot(x - 9.5, y - 9.5);
            if (distance > 9.3) continue;
            const offset = (y * circleSize + x) * 4;
            circleData[offset] = 126;
            circleData[offset + 1] = 126;
            circleData[offset + 2] = 126;
            circleData[offset + 3] = 255;
        }
    }
    for (let y = 7; y < 13; y += 1) {
        for (let x = 8; x < 12; x += 1) {
            const offset = (y * circleSize + x) * 4;
            circleData[offset] = 180;
            circleData[offset + 1] = 105;
            circleData[offset + 2] = 80;
            circleData[offset + 3] = 255;
        }
    }

    assert.ok(potdUtils.removeNeutralEdgeBackground({ data: circleData }, circleSize, circleSize) > 0);
    assert.equal(circleData[(2 * circleSize + 9) * 4 + 3], 0);
    assert.equal(circleData[(9 * circleSize + 9) * 4 + 3], 255);
});

test('renderer wraps a long player name safely and renders BYE as the literal team name', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potd-template-'));
    const templatePath = path.join(tempDir, 'original-template.png');
    fs.writeFileSync(templatePath, Buffer.from('test-template'));
    const oldTemplatePath = process.env.POTD_TEMPLATE_PATH;
    process.env.POTD_TEMPLATE_PATH = templatePath;
    drawCalls.length = 0;
    renderedText.length = 0;
    textDrawCalls.length = 0;
    arcCalls.length = 0;
    strokeCalls.length = 0;
    fillRectCalls.length = 0;

    try {
        await potdUtils.renderPotdCard({
            playerName: 'ABCDEFGHIJKLMNOPQRSTUVWX',
            teamName: 'BYE',
            avatarUrl: 'https://cdn.discordapp.test/player.png',
            stats: potdUtils.parseStats('1 Goals, 1 Assists')
        });

        const nameLines = textDrawCalls.filter(call => call.x === 282 && call.font === '30px "Oswald"');
        assert.equal(nameLines.length, 2);
        assert.equal(nameLines.map(call => call.text).join(''), 'ABCDEFGHIJKLMNOPQRSTUVWX');
        assert.ok(nameLines.every(call => call.y >= 637 && call.y <= 696));
        assert.ok(nameLines.every(call => call.fillStyle === '#F6FAFD'));

        const teamDraw = textDrawCalls.find(call => call.text === 'BYE');
        assert.ok(teamDraw);
        assert.equal(teamDraw.font, '24px "Inter SemiBold"');
        assert.equal(teamDraw.fillStyle, '#75C9D9');
        assert.deepEqual(textDrawCalls.filter(call => call.text === '1' && call.font === '32px "Oswald"').map(call => call.x), [470, 785]);
        assert.equal(strokeCalls.length, 0);
        assert.equal(fillRectCalls.length, 0);
    } finally {
        if (oldTemplatePath === undefined) delete process.env.POTD_TEMPLATE_PATH;
        else process.env.POTD_TEMPLATE_PATH = oldTemplatePath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('renderer draws the original template full-canvas before adding player overlays', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potd-template-'));
    const templatePath = path.join(tempDir, 'original-template.png');
    fs.writeFileSync(templatePath, Buffer.from('test-template'));
    const oldTemplatePath = process.env.POTD_TEMPLATE_PATH;
    process.env.POTD_TEMPLATE_PATH = templatePath;
    imageLoads.length = 0;
    drawCalls.length = 0;
    renderedText.length = 0;
    textDrawCalls.length = 0;
    arcCalls.length = 0;
    strokeCalls.length = 0;
    fillRectCalls.length = 0;
    renderCalls.length = 0;

    try {
        const output = await potdUtils.renderPotdCard({
            playerName: 'KABIR PATEL',
            teamName: 'DOOMPUR DEVILS',
            avatarUrl: 'https://cdn.discordapp.test/player.png',
            stats: potdUtils.parseStats('2 Goals, 1 Assist, 4 Shots'),
            matchLabel: 'Match 02',
            dateText: '02 OCT 2026'
        });

        assert.deepEqual(output, Buffer.from('rendered-potd-card'));
        assert.equal(imageLoads[0], templatePath);
        assert.equal(drawCalls[0][0], templateImage);
        assert.deepEqual(drawCalls[0].slice(1), [0, 0, 1254, 1254]);
        assert.deepEqual(drawCalls[1].slice(1), [0, 0, 512, 512, 587.5, 387.5, 255, 255]);
        assert.deepEqual(arcCalls[0].slice(0, 3), [715, 515, 127.5]);
        assert.equal(strokeCalls.length, 0);
        assert.equal(fillRectCalls.length, 0);
        assert.ok(renderedText.includes('2') && renderedText.includes('GOALS'));
        assert.doesNotMatch(renderedText.join(' '), /\[object Object\]|PLAYER OF THE DAY/);

        const playerNameDraw = textDrawCalls.find(call => call.text === 'KABIR PATEL');
        const playerNameSize = Number(playerNameDraw.font.match(/([0-9.]+)px/)?.[1]);
        assert.ok(playerNameSize >= 38 && playerNameSize <= 40);
        assert.equal(playerNameDraw.x, 282);
        assert.equal(playerNameDraw.y, 677);
        assert.equal(playerNameDraw.fillStyle, '#F6FAFD');
        assert.equal(playerNameDraw.shadowColor, 'rgba(7, 26, 50, 0.72)');
        assert.equal(playerNameDraw.shadowBlur, 0);
        assert.equal(playerNameDraw.shadowOffsetY, 2);

        const teamDraw = textDrawCalls.find(call => call.text === 'DOOMPUR DEVILS');
        assert.equal(teamDraw.font, '24px "Inter SemiBold"');
        assert.equal(teamDraw.x, 282);
        assert.equal(teamDraw.y, 736);
        assert.equal(teamDraw.fillStyle, '#75C9D9');
        assert.equal(teamDraw.letterSpacing, '0.2px');
        assert.equal(teamDraw.shadowColor, 'rgba(7, 26, 50, 0.58)');
        assert.equal(teamDraw.shadowOffsetY, 1);

        const matchDateDraw = textDrawCalls.find(call => call.text === 'MATCH 02 · 02 OCT 2026');
        assert.equal(matchDateDraw.font, '21px "Inter SemiBold"');
        assert.equal(matchDateDraw.x, 959);
        assert.equal(matchDateDraw.y, 696);
        assert.equal(matchDateDraw.textAlign, 'right');
        assert.equal(matchDateDraw.fillStyle, '#C6D0DA');
        assert.equal(matchDateDraw.letterSpacing, '0.2px');

        const goalsValue = textDrawCalls.find(call => call.text === '2' && call.x === 420);
        const goalsLabel = textDrawCalls.find(call => call.text === 'GOALS' && call.x === 420);
        assert.equal(goalsValue.fillStyle, '#F6FAFD');
        assert.equal(goalsValue.shadowColor, 'rgba(7, 26, 50, 0.7)');
        assert.equal(goalsLabel.font, '17px "Inter SemiBold"');
        assert.equal(goalsLabel.y, 947);
        assert.equal(goalsLabel.fillStyle, '#83C7D3');

        assert.deepEqual(textDrawCalls.filter(call => ['2', '1', '4'].includes(call.text)).map(call => [call.x, call.y, call.font]), [
            [420, 918, '32px "Oswald"'],
            [627, 918, '32px "Oswald"'],
            [834, 918, '32px "Oswald"']
        ]);
        assert.equal(renderCalls[0].format, 'image/png');
        assert.equal(renderCalls[0].width, 1254);
        assert.equal(renderCalls[0].height, 1254);
    } finally {
        if (oldTemplatePath === undefined) delete process.env.POTD_TEMPLATE_PATH;
        else process.env.POTD_TEMPLATE_PATH = oldTemplatePath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
