'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateMessageId } = require('../../src/smtp-client');

test('generateMessageId creates valid Message-ID format', () => {
    const id = generateMessageId('example.com');
    assert.ok(id.startsWith('<'));
    assert.ok(id.endsWith('@example.com>'));
    assert.ok(id.includes('-')); // UUID has dashes
});

test('generateMessageId falls back to localhost domain', () => {
    const id = generateMessageId('');
    assert.ok(id.endsWith('@localhost>'));
});
