/**
 * optionalStep.js
 *
 * Runs a NON-ESSENTIAL follow-up step that happens AFTER the real work of a
 * command is already done — Discord role cleanup, DMs, live-widget refreshes,
 * profile bookkeeping, walkover generation, ...
 *
 * Such a step must never turn an already-successful command into
 * "❌ Failed to ...". If it throws, the error is logged and the fallback value
 * (or null) is returned so the command can still report success.
 *
 * Usage:
 *   const roleResult = await optionalStep(
 *       'delete-player: role cleanup',
 *       () => tryRemoveRole({ ... }),
 *       { status: 'remove_failed' }
 *   );
 */

async function optionalStep(label, step, fallback = null) {
    try {
        const result = await (typeof step === 'function' ? step() : step);

        return result === undefined || result === null ? fallback : result;
    } catch (error) {
        console.error(
            `[optional step] ${label} failed (command result is unaffected):`,
            error?.stack || error
        );

        return fallback;
    }
}

module.exports = { optionalStep };
