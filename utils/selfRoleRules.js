const DURATION_UNITS = Object.freeze({
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
});
const MAX_ROLE_DURATION_MS = 90 * DURATION_UNITS.d;

function calculateSelection({ panel, group, memberRoleIds, visibleRoleIds, selectedRoleIds }) {
    const allOptions = group.options || [];
    const optionById = new Map(allOptions.map(option => [String(option.roleId), option]));
    const visible = new Set((visibleRoleIds || []).map(String));
    const selectedOnPage = new Set((selectedRoleIds || []).map(String));
    const currentRoles = memberRoleIds instanceof Set
        ? new Set([...memberRoleIds].map(String))
        : new Set((memberRoleIds || []).map(String));

    if ([...selectedOnPage].some(roleId => !visible.has(roleId) || !optionById.has(roleId))) {
        return { ok: false, error: 'That selection is not part of this role menu. Please reopen it and try again.' };
    }

    const currentSelection = new Set(
        allOptions
            .filter(option => currentRoles.has(String(option.roleId)))
            .map(option => String(option.roleId))
    );

    let nextSelection;
    if (group.mode === 'single' && selectedOnPage.size > 0) {
        // A single-choice group has one selection across all pages, not one per page.
        nextSelection = new Set(selectedOnPage);
    } else {
        nextSelection = new Set([...currentSelection].filter(roleId => !visible.has(roleId)));
        for (const roleId of selectedOnPage) nextSelection.add(roleId);
    }

    const minSelections = Math.max(0, Number(group.minSelections) || 0);
    const configuredMax = Math.max(0, Number(group.maxSelections) || 0);
    const maxSelections = group.mode === 'single'
        ? 1
        : (configuredMax || allOptions.length);

    if (nextSelection.size < minSelections) {
        return {
            ok: false,
            error: `Keep at least ${minSelections} role${minSelections === 1 ? '' : 's'} selected in **${group.name}**.`
        };
    }
    if (nextSelection.size > maxSelections) {
        return {
            ok: false,
            error: `You can select at most ${maxSelections} role${maxSelections === 1 ? '' : 's'} in **${group.name}**.`
        };
    }

    const changedAdded = [...nextSelection].filter(roleId => !currentSelection.has(roleId));
    const changedRemoved = [...currentSelection].filter(roleId => !nextSelection.has(roleId));
    const addedGrantRoleIds = new Set();
    const removedGrantRoleIds = new Set();
    const projectedRoles = new Set(currentRoles);

    for (const roleId of changedRemoved) {
        const option = optionById.get(roleId);
        for (const grantedRoleId of [roleId, ...(option?.bundleRoleIds || [])]) {
            const normalizedId = String(grantedRoleId);
            removedGrantRoleIds.add(normalizedId);
            projectedRoles.delete(normalizedId);
        }
    }
    for (const roleId of changedAdded) {
        const option = optionById.get(roleId);
        for (const grantedRoleId of [roleId, ...(option?.bundleRoleIds || [])]) {
            const normalizedId = String(grantedRoleId);
            addedGrantRoleIds.add(normalizedId);
            projectedRoles.add(normalizedId);
        }
    }

    if (changedAdded.length) {
        const groupGateError = checkRoleGates(group, currentRoles, 'This role group');
        if (groupGateError) return { ok: false, error: groupGateError };

        const panelGateError = checkRoleGates(panel || {}, currentRoles, 'This role panel');
        if (panelGateError) return { ok: false, error: panelGateError };
    }

    const candidateGroups = panel?.groups?.length ? panel.groups : [group];
    const currentOrNextSelectedOptions = candidateGroups.flatMap(candidateGroup =>
        (candidateGroup.options || []).filter(option => {
            const optionId = String(option.roleId);
            if (candidateGroup === group) return nextSelection.has(optionId);
            return currentRoles.has(optionId);
        })
    );

    for (const option of currentOrNextSelectedOptions) {
        const optionId = String(option.roleId);
        const isNewlySelected = changedAdded.includes(optionId);
        const required = (option.requiredRoleIds || []).map(String);
        const denied = (option.deniedRoleIds || []).map(String);
        const excludes = (option.excludesRoleIds || []).map(String);

        if (isNewlySelected) {
            const optionGateError = checkRoleGates(option, projectedRoles, `**${option.label || 'That role'}**`);
            if (optionGateError) return { ok: false, error: optionGateError };

            if (excludes.some(roleId => projectedRoles.has(roleId))) {
                return {
                    ok: false,
                    error: `**${option.label || 'That role'}** conflicts with another role you currently have.`
                };
            }
            continue;
        }

        // Do not let a member remove a prerequisite while retaining a role that depends on it.
        if (required.length && !required.some(roleId => projectedRoles.has(roleId))) {
            return {
                ok: false,
                error: `Remove **${option.label || 'the dependent role'}** before removing one of its required roles.`
            };
        }
        if (denied.some(roleId => addedGrantRoleIds.has(roleId)) ||
            excludes.some(roleId => addedGrantRoleIds.has(roleId))) {
            return {
                ok: false,
                error: `That change conflicts with **${option.label || 'a role you already have'}**.`
            };
        }
    }

    return {
        ok: true,
        nextSelection: [...nextSelection],
        addedRoleIds: changedAdded,
        removedRoleIds: changedRemoved,
        addedGrantRoleIds: [...addedGrantRoleIds],
        removedGrantRoleIds: [...removedGrantRoleIds],
        projectedRoleIds: [...projectedRoles]
    };
}

function checkRoleGates(configuration, memberRoleIds, subject) {
    const roleSet = memberRoleIds instanceof Set
        ? new Set([...memberRoleIds].map(String))
        : new Set((memberRoleIds || []).map(String));
    const required = (configuration.requiredRoleIds || []).map(String);
    const denied = (configuration.deniedRoleIds || []).map(String);

    if (required.length && !required.some(roleId => roleSet.has(roleId))) {
        return `${subject} requires one of the configured roles.`;
    }
    if (denied.some(roleId => roleSet.has(roleId))) {
        return `${subject} is unavailable while you have a restricted role.`;
    }
    return null;
}

function parseDuration(input) {
    const value = String(input || '').trim().toLowerCase();
    if (!value || value === '0' || value === 'permanent' || value === 'none') return 0;

    const match = value.match(/^(\d{1,6})(s|m|h|d)$/);
    if (!match) {
        throw new Error('Use a duration like `30m`, `12h`, or `7d` (or `permanent`).');
    }

    const amount = Number(match[1]);
    const durationMs = amount * DURATION_UNITS[match[2]];
    if (!Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > MAX_ROLE_DURATION_MS) {
        throw new Error('Timed roles must last at least 1 minute and at most 90 days.');
    }

    return durationMs;
}

function normalizeKey(value, maxLength = 32) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^[-_]+|[-_]+$/g, '')
        .slice(0, maxLength);
}

module.exports = {
    MAX_ROLE_DURATION_MS,
    calculateSelection,
    checkRoleGates,
    parseDuration,
    normalizeKey
};
