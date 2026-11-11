const test = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateSelection,
    parseDuration,
    normalizeKey,
    MAX_ROLE_DURATION_MS
} = require('../utils/selfRoleRules');

function option(roleId, extra = {}) {
    return { roleId, label: roleId, bundleRoleIds: [], ...extra };
}

test('multi-select updates only the visible page and preserves choices on other pages', () => {
    const group = {
        key: 'topics',
        name: 'Topics',
        mode: 'multiple',
        minSelections: 0,
        maxSelections: 0,
        options: [option('role-a'), option('role-b'), option('role-c'), option('role-d')]
    };
    const panel = { groups: [group] };

    const result = calculateSelection({
        panel,
        group,
        memberRoleIds: ['role-a', 'role-c'],
        visibleRoleIds: ['role-a', 'role-b'],
        selectedRoleIds: ['role-b']
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.nextSelection.sort(), ['role-b', 'role-c']);
    assert.deepEqual(result.addedRoleIds, ['role-b']);
    assert.deepEqual(result.removedRoleIds, ['role-a']);
});

test('single-choice selection replaces a role even when the previous role was on another page', () => {
    const group = {
        key: 'region',
        name: 'Region',
        mode: 'single',
        minSelections: 0,
        maxSelections: 1,
        options: [option('eu'), option('na'), option('asia')]
    };

    const result = calculateSelection({
        panel: { groups: [group] },
        group,
        memberRoleIds: ['eu'],
        visibleRoleIds: ['asia'],
        selectedRoleIds: ['asia']
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.nextSelection, ['asia']);
    assert.deepEqual(result.addedRoleIds, ['asia']);
    assert.deepEqual(result.removedRoleIds, ['eu']);
});

test('group maximum applies across pages and minimum prevents clearing required choices', () => {
    const group = {
        key: 'alerts',
        name: 'Alerts',
        mode: 'multiple',
        minSelections: 1,
        maxSelections: 2,
        options: [option('a'), option('b'), option('c')]
    };

    const overLimit = calculateSelection({
        panel: { groups: [group] },
        group,
        memberRoleIds: ['a', 'b'],
        visibleRoleIds: ['c'],
        selectedRoleIds: ['c']
    });
    assert.equal(overLimit.ok, false);
    assert.match(overLimit.error, /at most 2/);

    const belowMinimum = calculateSelection({
        panel: { groups: [group] },
        group,
        memberRoleIds: ['a'],
        visibleRoleIds: ['a'],
        selectedRoleIds: []
    });
    assert.equal(belowMinimum.ok, false);
    assert.match(belowMinimum.error, /at least 1/);
});

test('required and blocked gates stop new assignments but still permit removing an existing self-role', () => {
    const group = {
        key: 'pings',
        name: 'Pings',
        mode: 'multiple',
        minSelections: 0,
        maxSelections: 0,
        requiredRoleIds: ['verified'],
        deniedRoleIds: ['muted'],
        options: [option('events')]
    };

    const deniedAdd = calculateSelection({
        panel: { groups: [group] },
        group,
        memberRoleIds: [],
        visibleRoleIds: ['events'],
        selectedRoleIds: ['events']
    });
    assert.equal(deniedAdd.ok, false);
    assert.match(deniedAdd.error, /requires one/);

    const allowedRemoval = calculateSelection({
        panel: { groups: [group], requiredRoleIds: ['verified'] },
        group,
        memberRoleIds: ['events', 'muted'],
        visibleRoleIds: ['events'],
        selectedRoleIds: []
    });
    assert.equal(allowedRemoval.ok, true);
    assert.deepEqual(allowedRemoval.removedRoleIds, ['events']);
});

test('role dependencies prevent adding without a prerequisite or removing a prerequisite first', () => {
    const requiredGroup = {
        key: 'access',
        name: 'Access',
        mode: 'multiple',
        minSelections: 0,
        maxSelections: 0,
        options: [option('member-role', { requiredRoleIds: ['verified-role'] })]
    };
    const verifyGroup = {
        key: 'verification',
        name: 'Verification',
        mode: 'multiple',
        minSelections: 0,
        maxSelections: 0,
        options: [option('verified-role')]
    };
    const panel = { groups: [requiredGroup, verifyGroup] };

    const addWithoutPrerequisite = calculateSelection({
        panel,
        group: requiredGroup,
        memberRoleIds: [],
        visibleRoleIds: ['member-role'],
        selectedRoleIds: ['member-role']
    });
    assert.equal(addWithoutPrerequisite.ok, false);
    assert.match(addWithoutPrerequisite.error, /requires one/);

    const removePrerequisite = calculateSelection({
        panel,
        group: verifyGroup,
        memberRoleIds: ['member-role', 'verified-role'],
        visibleRoleIds: ['verified-role'],
        selectedRoleIds: []
    });
    assert.equal(removePrerequisite.ok, false);
    assert.match(removePrerequisite.error, /Remove/);
});

test('mutually exclusive role rules reject incompatible additions', () => {
    const group = {
        key: 'color',
        name: 'Color',
        mode: 'multiple',
        minSelections: 0,
        maxSelections: 0,
        options: [
            option('red', { excludesRoleIds: ['blue'] }),
            option('blue')
        ]
    };
    const result = calculateSelection({
        panel: { groups: [group] },
        group,
        memberRoleIds: ['blue'],
        visibleRoleIds: ['red'],
        selectedRoleIds: ['red']
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /conflicts/);
});

test('duration parser accepts permanent and bounded seconds/minutes/hours/days', () => {
    assert.equal(parseDuration('permanent'), 0);
    assert.equal(parseDuration('30m'), 30 * 60_000);
    assert.equal(parseDuration('12h'), 12 * 60 * 60_000);
    assert.equal(parseDuration('7d'), 7 * 24 * 60 * 60_000);
    assert.equal(parseDuration('90d'), MAX_ROLE_DURATION_MS);
    assert.throws(() => parseDuration('5s'), /at least 1 minute/);
    assert.throws(() => parseDuration('91d'), /at most 90 days/);
    assert.throws(() => parseDuration('tomorrow'), /Use a duration/);
});

test('normalizes keys for panels and groups', () => {
    assert.equal(normalizeKey(' Event Alerts '), 'event-alerts');
    assert.equal(normalizeKey('News_Updates'), 'news_updates');
});
