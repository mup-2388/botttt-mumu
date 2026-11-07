const MAX_GLOBAL_CHAT_INPUT_COMMANDS = 100;
const PRIORITY_COMMAND_NAMES = new Set(['settournament']);

/**
 * Keep essential setup commands available when the application reaches
 * Discord's per-scope chat-input command cap. Other visible commands are kept
 * ahead of hidden commands, which remain usable through the prefix handler if
 * they are omitted.
 */
function fitSlashCommandsToLimit(commands, limit = MAX_GLOBAL_CHAT_INPUT_COMMANDS) {
    if (!Array.isArray(commands)) throw new TypeError('commands must be an array');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    if (commands.length <= limit) return { selected: [...commands], omitted: [] };

    const priority = commands.filter(command => PRIORITY_COMMAND_NAMES.has(command.name));
    const prioritySet = new Set(priority);
    const visible = commands.filter(command => command.hidden !== true && !prioritySet.has(command));
    const hidden = commands.filter(command => command.hidden === true && !prioritySet.has(command));
    const selectedSet = new Set([...priority, ...visible, ...hidden].slice(0, limit));
    const selected = commands.filter(command => selectedSet.has(command));
    const omitted = commands.filter(command => !selectedSet.has(command));
    return { selected, omitted };
}

module.exports = {
    MAX_GLOBAL_CHAT_INPUT_COMMANDS,
    fitSlashCommandsToLimit
};
