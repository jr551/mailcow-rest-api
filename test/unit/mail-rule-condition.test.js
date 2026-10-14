'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRuleCondition } = require('../../src/mail-rule-condition');

test('validateRuleCondition accepts legacy single leaf', () => {
    validateRuleCondition({ type: 'from-contains', value: 'x' });
});

test('validateRuleCondition rejects nested compound', () => {
    assert.throws(
        () => validateRuleCondition({
            match: 'all',
            conditions: [{ match: 'any', conditions: [{ type: 'from-contains', value: 'a' }] }]
        }),
        /Nested compound/
    );
});

test('validateRuleCondition rejects empty compound', () => {
    assert.throws(
        () => validateRuleCondition({ match: 'all', conditions: [] }),
        /at least one/
    );
});
