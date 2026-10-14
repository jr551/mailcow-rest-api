'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    compileRulesScript,
    compileCondition,
    parseRules,
    buildBlockedRecipientsScript,
    parseBlockedRecipients
} = require('../../src/sieve-client');
const { validateRuleCondition } = require('../../src/mail-rule-condition');

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

test('compileCondition: allof with NOT sub-conditions', () => {
    const cond = {
        match: 'all',
        conditions: [
            { type: 'from-contains', value: 'healthera' },
            { type: 'subject-contains', value: 'days left' },
            { type: 'subject-contains', value: 'X', not: true }
        ]
    };
    validateRuleCondition(cond);
    const sieve = compileCondition(cond);
    assert.equal(
        sieve,
        'allof (header :contains "From" "healthera", header :contains "Subject" "days left", not header :contains "Subject" "X")'
    );
});

test('compileCondition: anyof OR group', () => {
    const cond = {
        match: 'any',
        conditions: [
            { type: 'from-contains', value: '@a.com' },
            { type: 'from-contains', value: '@b.com' }
        ]
    };
    const sieve = compileCondition(cond);
    assert.equal(
        sieve,
        'anyof (header :contains "From" "@a.com", header :contains "From" "@b.com")'
    );
});

test('compound AND rule round-trips through compile and parse', () => {
    const rules = [{
        id: 'compound-1',
        name: 'Healthera days left',
        condition: {
            match: 'all',
            conditions: [
                { type: 'from-contains', value: 'healthera' },
                { type: 'subject-contains', value: 'days left' },
                { type: 'subject-contains', value: 'Reminder', not: true }
            ]
        },
        action: { type: 'fileinto', folder: 'Health' }
    }];
    const script = compileRulesScript(rules);
    assert.ok(script.includes('allof ('));
    assert.ok(script.includes('not header :contains "Subject" "Reminder"'));
    assert.ok(script.includes('fileinto :create "Health"'));
    const parsed = parseRules(script);
    assert.equal(parsed.rules.length, 1);
    assert.deepEqual(parsed.rules[0].condition, rules[0].condition);
});

test('legacy single-condition rules still compile and parse unchanged', () => {
    const rules = [{
        id: 'legacy-1',
        name: 'Simple from',
        condition: { type: 'from-contains', value: 'newsletter' },
        action: { type: 'discard' }
    }];
    const parsed = parseRules(compileRulesScript(rules));
    assert.deepEqual(parsed.rules[0].condition, rules[0].condition);
});

test('single leaf with not:true round-trips', () => {
    const rules = [{
        id: 'not-1',
        name: 'Not spam subject',
        condition: { type: 'subject-contains', value: 'unsubscribe', not: true },
        action: { type: 'copy', to: 'bot@example.com' }
    }];
    const script = compileRulesScript(rules);
    assert.ok(script.includes('if not header :contains "Subject" "unsubscribe"'));
    const parsed = parseRules(script);
    assert.deepEqual(parsed.rules[0].condition, rules[0].condition);
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
