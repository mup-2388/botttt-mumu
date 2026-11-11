const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_GLOBAL_CHAT_INPUT_COMMANDS,
    fitSlashCommandsToLimit
} = require('../utils/slashCommandLimit');

test('slash command limit keeps all visible commands and omits hidden overflow only', () => {
    const commands = [
        ...Array.from({ length: 98 }, (_, index) => ({ name: `visible-${index}`, hidden: false })),
        { name: 'visible-selfroles', hidden: false },
        { name: 'hidden-first', hidden: true },
        { name: 'hidden-last', hidden: true }
    ];

    const result = fitSlashCommandsToLimit(commands, 100);
    assert.equal(result.selected.length, 100);
    assert.ok(result.selected.some(command => command.name === 'visible-selfroles'));
    assert.deepEqual(result.omitted.map(command => command.name), ['hidden-last']);
});

test('slash command limit prioritizes settournament over visible overflow', () => {
    const commands = Array.from({ length: MAX_GLOBAL_CHAT_INPUT_COMMANDS + 1 }, (_, index) => ({
        name: `visible-${index}`,
        hidden: false
    }));
    commands[commands.length - 1] = { name: 'settournament', hidden: false };

    const result = fitSlashCommandsToLimit(commands);

    assert.equal(result.selected.length, MAX_GLOBAL_CHAT_INPUT_COMMANDS);
    assert.ok(result.selected.includes(commands.at(-1)));
    assert.deepEqual(result.omitted, [commands[MAX_GLOBAL_CHAT_INPUT_COMMANDS - 1]]);
});

test('slash command limit leaves a compliant command list untouched', () => {
    const commands = Array.from({ length: MAX_GLOBAL_CHAT_INPUT_COMMANDS }, (_, index) => ({ name: `cmd-${index}` }));
    const result = fitSlashCommandsToLimit(commands);
    assert.deepEqual(result.selected, commands);
    assert.deepEqual(result.omitted, []);
});
