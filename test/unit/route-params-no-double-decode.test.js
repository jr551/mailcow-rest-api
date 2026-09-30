'use strict';

// find-my-way percent-decodes route params exactly once before the handler
// runs. These handlers then called decodeURIComponent on the decoded value
// again, which had two failure modes:
//   * a mailbox (or recipient / id / uid) literally named `A%2FB` arrived
//     at the backend as `A/B` — a DELETE / PUT aimed at one mailbox silently
//     operating on a different one;
//   * a name containing a bare percent (`100%`) threw URIError inside the
//     handler and surfaced as a 500.
// Both shapes are pinned per module below: the request must reach the
// backend with the router-provided value unchanged, and no input may 500.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makePoolStub(clientMethods) {
    const client = {
        authenticated: true,
        usable: true,
        async getMailboxLock() {
            return { release() {} };
        },
        async search() { return []; },
        ...clientMethods
    };
    return {
        async acquire() { return client; },
        release() {},
        discard() {}
    };
}

async function buildApp(register, registerOpts) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        const problem = err.problem || { type: 'about:blank', title: err.name || 'Error', status, detail: err.message };
        reply.code(status).type('application/problem+json').send(problem);
    });
    app.addHook('onRequest', async (req) => {
        req.creds = { user: 't@x.com', pass: 'pw', hash: 'h' };
    });
    await app.register(register, registerOpts);
    return app;
}

// ── src/routes/mailboxes.js ──

test('mailboxes: DELETE targets the mailbox as spelled, not a decoded look-alike', async () => {
    const seen = [];
    const pool = makePoolStub({
        async mailboxDelete(p) { seen.push(p); }
    });
    const app = await buildApp(require('../../src/routes/mailboxes'), { pool });
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/mailboxes/A%252FB' });
        assert.equal(res.statusCode, 204);
        assert.deepEqual(seen, ['A%2FB'], 'the raw param value must reach IMAP unchanged');
    } finally {
        await app.close();
    }
});

test('mailboxes: a name with a bare percent is not a 500', async () => {
    const seen = [];
    const pool = makePoolStub({
        async mailboxDelete(p) { seen.push(p); }
    });
    const app = await buildApp(require('../../src/routes/mailboxes'), { pool });
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/mailboxes/100%25' });
        assert.equal(res.statusCode, 204);
        assert.deepEqual(seen, ['100%']);
    } finally {
        await app.close();
    }
});

test('mailboxes: PUT rename keeps the source path intact', async () => {
    const seen = [];
    const pool = makePoolStub({
        async mailboxRename(from, newPath) {
            seen.push([from, newPath]);
            return { newPath, delimiter: '/' };
        }
    });
    const app = await buildApp(require('../../src/routes/mailboxes'), { pool });
    try {
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/mailboxes/A%252FB',
            payload: { newPath: 'A%2FB-renamed' }
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(seen, [['A%2FB', 'A%2FB-renamed']]);
    } finally {
        await app.close();
    }
});

// ── src/routes/mail-rules.js ──

function sieveStub(seen) {
    return {
        async removeBlockedRecipient(user, pass, recipient) { seen.push(recipient); }
    };
}

test('mail-rules: unblocking keeps the recipient as spelled', async () => {
    const seen = [];
    const app = await buildApp(require('../../src/routes/mail-rules'), { sieveManager: sieveStub(seen) });
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/me/blocked-recipients/a%252Fb%40x.com' });
        assert.equal(res.statusCode, 204);
        assert.deepEqual(seen, ['a%2Fb@x.com']);
    } finally {
        await app.close();
    }
});

test('mail-rules: a recipient with a bare percent is not a 500', async () => {
    const seen = [];
    const app = await buildApp(require('../../src/routes/mail-rules'), { sieveManager: sieveStub(seen) });
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/me/blocked-recipients/100%25%40x.com' });
        assert.equal(res.statusCode, 204);
        assert.deepEqual(seen, ['100%@x.com']);
    } finally {
        await app.close();
    }
});

// ── src/routes/calendar.js ──

const { CaldavClient } = require('../../src/caldav-client');

function calendarApp(dataDir) {
    return buildApp(require('../../src/routes/calendar'), {
        sogoUrl: 'http://sogo-test/SOGo',
        dataDir
    });
}

test('calendar: events are listed for the calendar as spelled', async () => {
    const seen = [];
    const orig = CaldavClient.prototype.listEvents;
    CaldavClient.prototype.listEvents = async function (user, pass, calendar) {
        seen.push(calendar);
        return [];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-dbl-'));
    const app = await calendarApp(dir);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/me/calendars/A%252FB/events?start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z'
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(seen, ['A%2FB']);
    } finally {
        CaldavClient.prototype.listEvents = orig;
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('calendar: a calendar name with a bare percent is not a 500', async () => {
    const seen = [];
    const orig = CaldavClient.prototype.listEvents;
    CaldavClient.prototype.listEvents = async function (user, pass, calendar) {
        seen.push(calendar);
        return [];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-dbl-'));
    const app = await calendarApp(dir);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/me/calendars/100%25/events?start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z'
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(seen, ['100%']);
    } finally {
        CaldavClient.prototype.listEvents = orig;
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('calendar: event UIDs are fetched as spelled', async () => {
    const seen = [];
    const orig = CaldavClient.prototype.getEvent;
    CaldavClient.prototype.getEvent = async function (user, pass, calendar, uid) {
        seen.push([calendar, uid]);
        return null;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-dbl-'));
    const app = await calendarApp(dir);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/calendars/cal/events/A%252FB' });
        assert.equal(res.statusCode, 404, 'not found, but never a decode blow-up');
        assert.deepEqual(seen, [['cal', 'A%2FB']]);
    } finally {
        CaldavClient.prototype.getEvent = orig;
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('calendar: a UID with a bare percent is not a 500', async () => {
    const seen = [];
    const orig = CaldavClient.prototype.getEvent;
    CaldavClient.prototype.getEvent = async function (user, pass, calendar, uid) {
        seen.push(uid);
        return null;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-dbl-'));
    const app = await calendarApp(dir);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/me/calendars/cal/events/100%25' });
        assert.equal(res.statusCode, 404);
        assert.deepEqual(seen, ['100%']);
    } finally {
        CaldavClient.prototype.getEvent = orig;
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── src/routes/calendar-subscriptions.js ──

function subStore(seen, subs) {
    return {
        list: () => [],
        get: ({ id, user }) => (subs || []).find((s) => s.id === id && s.user === user) || null,
        create: (o) => ({ id: 'new', ...o }),
        remove: ({ id, user }) => {
            seen.push(id);
            return id === 'A%2FB';
        }
    };
}

test('calendar-subscriptions: delete removes the subscription as spelled', async () => {
    const seen = [];
    const app = await buildApp(require('../../src/routes/calendar-subscriptions'), { store: subStore(seen) });
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/me/calendar-subscriptions/A%252FB' });
        assert.equal(res.statusCode, 204);
        assert.deepEqual(seen, ['A%2FB']);
    } finally {
        await app.close();
    }
});

test('calendar-subscriptions: a subscription id with a bare percent is not a 500', async () => {
    const seen = [];
    const app = await buildApp(require('../../src/routes/calendar-subscriptions'), { store: subStore(seen) });
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/me/calendar-subscriptions/100%25' });
        assert.equal(res.statusCode, 404, 'honest not-found, never a decode blow-up');
        assert.deepEqual(seen, ['100%']);
    } finally {
        await app.close();
    }
});

test('calendar-subscriptions: events lookup uses the id as spelled', async () => {
    const seen = [];
    const store = {
        list: () => [],
        get: ({ id }) => {
            seen.push(id);
            return null;
        },
        create: (o) => o,
        remove: () => true
    };
    const app = await buildApp(require('../../src/routes/calendar-subscriptions'), { store });
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/me/calendar-subscriptions/A%252FB/events?start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z'
        });
        assert.equal(res.statusCode, 404);
        assert.deepEqual(seen, ['A%2FB']);
    } finally {
        await app.close();
    }
});

// ── src/routes/mailbox-info.js (temp-alias delete; the audit filed this
//    under address-book.js but the route lives here) ──

function dbStub(seen) {
    return {
        async getMailboxStats() { return {}; },
        async getLogins() { return []; },
        async listAliases() { return []; },
        async listTempAliases() { return []; },
        async createTempAlias() { return { address: 'a@x.com', validity: 0, permanent: true }; },
        async deleteTempAlias(user, address) {
            seen.push(address);
            return true;
        },
        async getSendFromAddresses() { return []; }
    };
}

test('mailbox-info: temp-alias delete targets the address as spelled', async () => {
    const seen = [];
    const app = await buildApp(require('../../src/routes/mailbox-info'), { db: dbStub(seen) });
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/me/temp-aliases/a%252Fb%40x.com' });
        assert.equal(res.statusCode, 204);
        assert.deepEqual(seen, ['a%2Fb@x.com']);
    } finally {
        await app.close();
    }
});

test('mailbox-info: an address with a bare percent is not a 500', async () => {
    const seen = [];
    const app = await buildApp(require('../../src/routes/mailbox-info'), { db: dbStub(seen) });
    try {
        const res = await app.inject({ method: 'DELETE', url: '/v1/me/temp-aliases/100%25%40x.com' });
        assert.equal(res.statusCode, 204);
        assert.deepEqual(seen, ['100%@x.com']);
    } finally {
        await app.close();
    }
});
