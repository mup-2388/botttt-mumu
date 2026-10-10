const MAX_GLOBAL_CHAT_INPUT_COMMANDS = 100;

/**
 * Keep public slash commands available when the application reaches Discord's
 * per-scope chat-input command cap. Hidden commands remain usable through the
 * prefix handler if they are the ones omitted.
 */
function fitSlashCommandsToLimit(commands, limit = MAX_GLOBAL_CHAT_INPUT_COMMANDS) {
    if (!Array.isArray(commands)) throw new TypeError('commands must be an array');
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    if (commands.length <= limit) return { selected: [...commands], omitted: [] };

    const visible = commands.filter(command => command.hidden !== true);
    const hidden = commands.filter(command => command.hidden === true);
    const selected = [...visible, ...hidden].slice(0, limit);
    const selectedSet = new Set(selected);
    const omitted = commands.filter(command => !selectedSet.has(command));
    return { selected, omitted };
}

module.exports = {
    MAX_GLOBAL_CHAT_INPUT_COMMANDS,
    fitSlashCommandsToLimit
};
