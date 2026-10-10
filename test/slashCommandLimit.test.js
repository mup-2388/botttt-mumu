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

test('slash command limit leaves a compliant command list untouched', () => {
    const commands = Array.from({ length: MAX_GLOBAL_CHAT_INPUT_COMMANDS }, (_, index) => ({ name: `cmd-${index}` }));
    const result = fitSlashCommandsToLimit(commands);
    assert.deepEqual(result.selected, commands);
    assert.deepEqual(result.omitted, []);
});
