'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    createMailcowDb,
    createMailcowDbFromPool,
    isValidSenderPattern
} = require('../../src/mailcow-db');

function makePool(executeImpl) {
    const calls = [];
    return {
        calls,
        pool: {
            execute: async (sql, params) => {
                calls.push({ sql, params });
                return executeImpl(sql, params, calls);
            },
            end: async () => {}
        }
    };
}

test('createMailcowDb returns null when password is missing or blank', () => {
    assert.equal(createMailcowDb({ pass: '' }), null);
    assert.equal(createMailcowDb({ pass: '   ' }), null);
    assert.equal(createMailcowDb({ pass: undefined }), null);
});

test('isValidSenderPattern accepts wildcards and rejects unsafe characters', () => {
    assert.equal(isValidSenderPattern('*@example.com'), true);
    assert.equal(isValidSenderPattern('user@host.com'), true);
    assert.equal(isValidSenderPattern(''), false);
    assert.equal(isValidSenderPattern('a b'), false);
    assert.equal(isValidSenderPattern('a;b'), false);
});

test('getLogins clamps limit to 1..100 before querying', async () => {
    const { pool, calls } = makePool(() => [[], {}]);
    const db = createMailcowDbFromPool(pool);
    await db.getLogins('u@x.com', 9999);
    assert.equal(calls.at(-1).params[1], 100);
    await db.getLogins('u@x.com', 0);
    assert.equal(calls.at(-1).params[1], 1);
    await db.getLogins('u@x.com', 'not-a-number');
    assert.equal(calls.at(-1).params[1], 20);
});

test('getMailbox treats missing quota2 row as zero usage', async () => {
    const { pool } = makePool((sql) => {
        if (sql.includes('FROM mailbox')) {
            return [[{
                username: 'u@x.com',
                name: 'User',
                active: 1,
                domain: 'x.com',
                local_part: 'u',
                quota: 1_000_000,
                created: null,
                modified: null,
                authsource: 'mailcow',
                attributes: '{"foo":1}',
                bytes: null,
                messages: null
            }], {}];
        }
        return [[], {}];
    });
    const db = createMailcowDbFromPool(pool);
    const mb = await db.getMailbox('u@x.com');
    assert.equal(mb.quotaUsed, 0);
    assert.equal(mb.messages, 0);
    assert.equal(mb.percentInUse, 0);
    assert.deepEqual(mb.attributes, { foo: 1 });
});

test('createTempAlias retries on duplicate address collisions', async () => {
    let inserts = 0;
    const { pool } = makePool((sql) => {
        if (sql.startsWith('INSERT INTO spamalias')) {
            inserts += 1;
            if (inserts === 1) {
                const err = new Error('dup');
                err.code = 'ER_DUP_ENTRY';
                throw err;
            }
            return [{ insertId: 1 }, {}];
        }
        return [[], {}];
    });
    const db = createMailcowDbFromPool(pool);
    const alias = await db.createTempAlias('owner@x.com', { validityHours: 24 });
    assert.match(alias.address, /^[a-z0-9]+@x\.com$/);
    assert.equal(inserts, 2);
});

test('getSendFromAddresses collects catch-all wildcard domains', async () => {
    const { pool } = makePool((sql) => {
        if (sql.includes('FROM alias')) {
            return [[
                { address: 'alias@x.com' },
                { address: '@x.com' },
                { address: '@Other.COM' }
            ], {}];
        }
        if (sql.includes('FROM spamalias')) return [[{ address: 'temp@x.com' }], {}];
        return [[], {}];
    });
    const db = createMailcowDbFromPool(pool);
    const out = await db.getSendFromAddresses('owner@x.com');
    assert.ok(out.addresses.includes('owner@x.com'));
    assert.ok(out.addresses.includes('alias@x.com'));
    assert.ok(out.addresses.includes('temp@x.com'));
    assert.deepEqual(out.wildcardDomains.sort(), ['other.com', 'x.com']);
});
