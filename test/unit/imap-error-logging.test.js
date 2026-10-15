'use strict';

// Regression tests for ROW-70: five 502s on GET /v1/mailboxes/<folder>/messages
// logged only "IMAP backend error" with no cause, because withClient threw the
// mapped problem without ever logging the imapflow error behind it. The raw
// responseText is exactly what errors.js says "belongs in the log" — but a
// Dovecot response can echo back the command it failed, credentials included,
// so it has to be redacted before it reaches the log.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withClient } = require('../../src/imap');
const { notFound } = require('../../src/errors');
const { redactForLog } = require('../../src/secret-scrub');

const PASS = 'S3cretPassw0rd!';
const CREDS = { user: 'john@example.com', pass: PASS, hash: 'hash-1' };

function makeLogger() {
    const records = [];
    const record = (level) => (payload, msg) => records.push({ level, payload, msg });
    return {
        records,
        error: record('error'),
        warn: record('warn'),
        info: record('info'),
        debug: record('debug')
    };
}

function makePool(logger) {
    const calls = { acquire: 0, release: 0, discard: 0 };
    const client = { authenticated: true, usable: true };
    return {
        calls,
        client,
        pool: {
            logger,
            async acquire() { calls.acquire++; return client; },
            release() { calls.release++; },
            discard() { calls.discard++; }
        }
    };
}

test('a raw IMAP failure is logged with its response text before being mapped to 502', async () => {
    const logger = makeLogger();
    const { pool, calls } = makePool(logger);
    const err = {
        code: 'NO',
        serverResponseCode: 'NO',
        responseText: `NO [SERVERBUG] fetch failed for ${PASS}`,
        command: 'FETCH',
        message: 'Command failed'
    };

    await assert.rejects(
        withClient(pool, CREDS, async () => { throw err; }),
        (e) => {
            assert.equal(e.statusCode, 502);
            assert.equal(e.problem.detail, 'IMAP backend error');
            return true;
        }
    );

    assert.equal(calls.release, 1);
    assert.equal(calls.discard, 0);
    assert.equal(logger.records.length, 1);
    const [rec] = logger.records;
    assert.equal(rec.level, 'error');
    assert.equal(rec.msg, 'imap operation failed');
    assert.equal(rec.payload.user, 'john@example.com');
    assert.equal(rec.payload.status, 502);
    assert.equal(rec.payload.imap.code, 'NO');
    assert.equal(rec.payload.imap.serverResponseCode, 'NO');
    assert.equal(rec.payload.imap.command, 'FETCH');
    assert.match(rec.payload.imap.responseText, /fetch failed/);
    assert.equal(rec.payload.err.message, 'Command failed');
    // The Dovecot response echoed the password; it must not survive into the log.
    assert.equal(JSON.stringify(rec.payload).includes(PASS), false);
    assert.match(rec.payload.imap.responseText, /\[redacted\]/);
});

test('an HTTP problem thrown by the route is rethrown untouched and never logged', async () => {
    const logger = makeLogger();
    const { pool, calls } = makePool(logger);
    const boom = notFound('Message not found');

    await assert.rejects(
        withClient(pool, CREDS, async () => { throw boom; }),
        (e) => {
            assert.equal(e, boom);
            return true;
        }
    );

    assert.equal(logger.records.length, 0);
    assert.equal(calls.release, 1);
    assert.equal(calls.discard, 0);
});

test('a connection-level failure discards the client', async () => {
    const logger = makeLogger();
    const { pool, client, calls } = makePool(logger);
    client.authenticated = false;

    await assert.rejects(
        withClient(pool, CREDS, async () => { throw new Error('socket closed'); }),
        (e) => {
            assert.equal(e.statusCode, 502);
            return true;
        }
    );

    assert.equal(calls.discard, 1);
    assert.equal(calls.release, 0);
    assert.equal(logger.records[0].level, 'error');
});

test('a mapped client error is logged at warn, not error', async () => {
    const logger = makeLogger();
    const { pool } = makePool(logger);

    await assert.rejects(
        withClient(pool, CREDS, async () => {
            throw { serverResponseCode: 'NONEXISTENT', responseText: 'No such mailbox', message: 'Command failed' };
        }),
        (e) => {
            assert.equal(e.statusCode, 404);
            return true;
        }
    );

    assert.equal(logger.records.length, 1);
    assert.equal(logger.records[0].level, 'warn');
    assert.equal(logger.records[0].payload.status, 404);
});

test('a pool without a logger does not break the failure path', async () => {
    const { pool } = makePool(undefined);

    await assert.rejects(
        withClient(pool, CREDS, async () => { throw { message: 'boom' }; }),
        (e) => {
            assert.equal(e.statusCode, 502);
            return true;
        }
    );
});

test('redactForLog strips caller secrets, scrubs patterns and truncates', () => {
    assert.equal(redactForLog(null), '');
    assert.equal(redactForLog(undefined), '');
    assert.equal(redactForLog(12345), '12345');
    assert.equal(redactForLog(`a ${PASS} b`, [PASS]), 'a [redacted] b');
    // Entries shorter than 4 chars are ignored — replacing them would mangle
    // ordinary text for no protection.
    assert.equal(redactForLog('abc', ['ab']), 'abc');
    // The pattern pass still applies after the explicit secret list.
    assert.match(redactForLog('password: hunter2ABC', []), /password: \[redacted\]/);
    const long = redactForLog('x'.repeat(600), []);
    assert.equal(long.length, 501);
    assert.ok(long.endsWith('…'));
    assert.equal(long.startsWith('x'.repeat(500)), true);
});
