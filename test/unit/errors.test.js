'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const errs = require('../../src/errors');

test('helpers produce problem objects with correct status', () => {
    assert.equal(errs.unauthorized().statusCode, 401);
    assert.equal(errs.forbidden().statusCode, 403);
    assert.equal(errs.notFound().statusCode, 404);
    assert.equal(errs.badRequest('x').statusCode, 400);
    assert.equal(errs.conflict('x').statusCode, 409);
    assert.equal(errs.badGateway('x').statusCode, 502);
});

test('fromImapError: AUTHENTICATIONFAILED → 401', () => {
    const e = errs.fromImapError({ serverResponseCode: 'AUTHENTICATIONFAILED', responseText: 'LOGIN failed' });
    assert.equal(e.statusCode, 401);
});

test('fromImapError: NONEXISTENT → 404', () => {
    const e = errs.fromImapError({ serverResponseCode: 'NONEXISTENT', responseText: 'No such mailbox' });
    assert.equal(e.statusCode, 404);
});

test('fromImapError: ALREADYEXISTS → 409', () => {
    const e = errs.fromImapError({ serverResponseCode: 'ALREADYEXISTS', responseText: 'already exists' });
    assert.equal(e.statusCode, 409);
});

test('fromImapError: network error → 502', () => {
    const e = errs.fromImapError({ message: 'ECONNRESET' });
    assert.equal(e.statusCode, 502);
});

test('fromImapError: unknown → 502', () => {
    const e = errs.fromImapError({ message: 'weird' });
    assert.equal(e.statusCode, 502);
});

test('fromImapError: null input → 502', () => {
    const e = errs.fromImapError(null);
    assert.equal(e.statusCode, 502);
});
