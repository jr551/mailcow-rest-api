'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    compileRulesScript,
    parseRules,
    buildBlockedRecipientsScript,
    parseBlockedRecipients
} = require('../../src/sieve-client');

test('compileRulesScript with discard rules', () => {
    const rules = [
        {
            id: 'block-1',
            name: 'Block spam',
            condition: { type: 'envelope-to-is', value: 'spam@example.com' },
            action: { type: 'discard' }
        }
    ];
    const script = compileRulesScript(rules);
    assert.ok(script.includes('require ["envelope"];'));
    assert.ok(script.includes('if envelope :is "to" "spam@example.com"'));
    assert.ok(script.includes('discard;'));
    assert.ok(script.includes('stop;'));
});

test('compileRulesScript with redirect rule', () => {
    const rules = [
        {
            id: 'redirect-1',
            name: 'PagerDuty to Bot',
            condition: { type: 'to-contains', value: 'pagerduty' },
            action: { type: 'redirect', to: 'bot@example.com' }
        }
    ];
    const script = compileRulesScript(rules);
    assert.ok(!script.includes('require')); // redirect is built-in, no require needed
    assert.ok(script.includes('if header :contains "To" "pagerduty"'));
    assert.ok(script.includes('redirect "bot@example.com";'));
    assert.ok(script.includes('stop;'));
});

test('compileRulesScript with copy rule', () => {
    const rules = [
        {
            id: 'copy-1',
            name: 'Delivery copy',
            condition: { type: 'from-contains', value: '@royalmail.com' },
            action: { type: 'copy', to: 'bot@example.com' }
        }
    ];
    const script = compileRulesScript(rules);
    assert.ok(script.includes('require ["copy"];'));
    assert.ok(script.includes('if header :contains "From" "@royalmail.com"'));
    assert.ok(script.includes('redirect :copy "bot@example.com";'));
    assert.ok(!script.includes('stop;') || script.split('stop;').length === 1); // copy has no stop
});

test('compileRulesScript with mixed rules', () => {
    const rules = [
        {
            id: 'block-1',
            name: 'Block spam',
            condition: { type: 'envelope-to-is', value: 'spam@example.com' },
            action: { type: 'discard' }
        },
        {
            id: 'copy-1',
            name: 'Delivery copy',
            condition: { type: 'from-contains', value: '@royalmail.com' },
            action: { type: 'copy', to: 'bot@example.com' }
        }
    ];
    const script = compileRulesScript(rules);
    assert.ok(script.includes('require ["envelope", "copy"];'));
    assert.ok(script.includes('# rule: block-1'));
    assert.ok(script.includes('# rule: copy-1'));
});

test('compileRulesScript with preserved content', () => {
    const rules = [
        {
            id: 'block-1',
            name: 'Block spam',
            condition: { type: 'envelope-to-is', value: 'spam@example.com' },
            action: { type: 'discard' }
        }
    ];
    const preserved = 'require ["fileinto"];\nif header :contains "From" "onestream" { fileinto "Junk"; }';
    const script = compileRulesScript(rules, preserved);
    assert.ok(script.includes('# --- preserved rules ---'));
    assert.ok(script.includes('fileinto "Junk"'));
});

test('compileRulesScript empty rules with no preserved returns empty', () => {
    assert.equal(compileRulesScript([]), '');
});

test('parseRules extracts discard rules', () => {
    const rules = [
        {
            id: 'block-1',
            name: 'Block spam',
            condition: { type: 'envelope-to-is', value: 'spam@example.com' },
            action: { type: 'discard' }
        }
    ];
    const script = compileRulesScript(rules);
    const parsed = parseRules(script);
    assert.equal(parsed.rules.length, 1);
    assert.equal(parsed.rules[0].id, 'block-1');
    assert.equal(parsed.rules[0].condition.type, 'envelope-to-is');
    assert.equal(parsed.rules[0].condition.value, 'spam@example.com');
    assert.equal(parsed.rules[0].action.type, 'discard');
});

test('parseRules extracts redirect and copy rules', () => {
    const rules = [
        {
            id: 'r1',
            name: 'Redirect',
            condition: { type: 'to-contains', value: 'pagerduty' },
            action: { type: 'redirect', to: 'bot@example.com' }
        },
        {
            id: 'c1',
            name: 'Copy',
            condition: { type: 'from-contains', value: '@royalmail.com' },
            action: { type: 'copy', to: 'bot@example.com' }
        }
    ];
    const script = compileRulesScript(rules);
    const parsed = parseRules(script);
    assert.equal(parsed.rules.length, 2);
    assert.equal(parsed.rules[0].action.type, 'redirect');
    assert.equal(parsed.rules[0].action.to, 'bot@example.com');
    assert.equal(parsed.rules[1].action.type, 'copy');
    assert.equal(parsed.rules[1].action.to, 'bot@example.com');
});

test('parseRules extracts preserved content', () => {
    const rules = [{ id: 'x', name: 'X', condition: { type: 'envelope-to-is', value: 'a@b.c' }, action: { type: 'discard' } }];
    const preserved = 'require ["fileinto"];\nif header :contains "From" "onestream" { fileinto "Junk"; }';
    const script = compileRulesScript(rules, preserved);
    const parsed = parseRules(script);
    assert.ok(parsed.preservedContent.includes('fileinto "Junk"'));
});

test('parseRules handles header-contains with custom header', () => {
    const rules = [
        {
            id: 'h1',
            name: 'Custom header',
            condition: { type: 'header-contains', header: 'X-Custom', value: 'test' },
            action: { type: 'discard' }
        }
    ];
    const script = compileRulesScript(rules);
    const parsed = parseRules(script);
    assert.equal(parsed.rules[0].condition.type, 'header-contains');
    assert.equal(parsed.rules[0].condition.header, 'X-Custom');
    assert.equal(parsed.rules[0].condition.value, 'test');
});

test('buildBlockedRecipientsScript backward compat', () => {
    const script = buildBlockedRecipientsScript(['a@b.com', 'c@d.com']);
    assert.ok(script.includes('require ["envelope"];'));
    const parsed = parseBlockedRecipients(script);
    assert.deepEqual(parsed, ['a@b.com', 'c@d.com']);
});

test('parseBlockedRecipients backward compat with mixed rules', () => {
    const rules = [
        { id: 'b1', name: 'Block a', condition: { type: 'envelope-to-is', value: 'a@b.com' }, action: { type: 'discard' } },
        { id: 'r1', name: 'Redirect x', condition: { type: 'to-contains', value: 'x' }, action: { type: 'redirect', to: 'y@z.com' } }
    ];
    const script = compileRulesScript(rules);
    const blocked = parseBlockedRecipients(script);
    assert.deepEqual(blocked, ['a@b.com']);
});
