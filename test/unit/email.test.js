'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidEmail } = require('../../src/utils/email');

test('isValidEmail accepts common mailbox shapes', () => {
    assert.equal(isValidEmail('a@b.co'), true);
    assert.equal(isValidEmail('user.name+tag@example.com'), true);
});

test('isValidEmail rejects empty and malformed values', () => {
    assert.equal(isValidEmail(''), false);
    assert.equal(isValidEmail('not-an-email'), false);
    assert.equal(isValidEmail('@missing.local'), false);
});
