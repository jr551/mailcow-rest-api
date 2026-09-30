'use strict';

// Two error-handling bugs in src/routes/calendar.js:
//   * GET /v1/me/calendars/:calendar/events passed ?start=/?end= straight to
//     caldav-client's date formatter, which throws `Invalid date` on garbage
//     — a 500 for a user typo. Validate up front like the calendar
//     subscription route does.
//   * GET /v1/public/event/:grant/edit swallowed getEventRaw errors with
//     `.catch(() => null)` and rendered "Event not found" (404) — a CalDAV
//     outage looked like every event had been deleted. getEventRaw already
//     returns null only for a true 404 and throws otherwise (as the POST
//     handler correctly surfaces as 502); the GET must do the same.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const calendarRoutes = require('../../src/routes/calendar');
const { CaldavClient } = require('../../src/caldav-client');
const { IcalTokenStore } = require('../../src/ical-token-store');

// Mirrors the helper in routes/calendar.js.
function makeEventGrant(rec, uid) {
    const uidPart = Buffer.from(String(uid), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', rec.editKey)
        .update(`${rec.id}:${uid}`)
        .digest('base64url')
        .slice(0, 27);
    return `${rec.id}.${uidPart}.${sig}`;
}

async function buildApp(dataDir) {
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
    await app.register(calendarRoutes, { sogoUrl: 'http://sogo-test/SOGo', dataDir });
    return app;
}

test('?start=garbage&end=x is a 400, not a 500', async () => {
    const calls = [];
    const orig = CaldavClient.prototype.listEvents;
    CaldavClient.prototype.listEvents = async function (...args) {
        calls.push(args);
        return [];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-val-'));
    const app = await buildApp(dir);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/me/calendars/cal/events?start=garbage&end=x'
        });
        assert.equal(res.statusCode, 400);
        assert.equal(calls.length, 0, 'the CalDAV client must never see unvalidated dates');
    } finally {
        CaldavClient.prototype.listEvents = orig;
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a valid date range still lists events', async () => {
    const orig = CaldavClient.prototype.listEvents;
    CaldavClient.prototype.listEvents = async function () {
        return [{ uid: 'e1', summary: 'Standup', dtstart: '2026-01-01T10:00:00', dtend: '2026-01-01T11:00:00' }];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-val-'));
    const app = await buildApp(dir);
    try {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/me/calendars/cal/events?start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z'
        });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.events.length, 1);
    } finally {
        CaldavClient.prototype.listEvents = orig;
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

async function buildEditFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-edit-'));
    // Issue before the app so the route's token store loads the record
    // (with its public id and signing key) from disk.
    const store = new IcalTokenStore(path.join(dir, 'ical-tokens.json'));
    const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
    const rec = store.get(token);
    const grant = makeEventGrant(rec, 'ev1@example.com');
    const app = await buildApp(dir);
    return { dir, app, grant };
}

test('public edit: a CalDAV outage is 502, not a fake "event gone" 404', async () => {
    const { dir, app, grant } = await buildEditFixture();
    const orig = CaldavClient.prototype.getEventRaw;
    CaldavClient.prototype.getEventRaw = async function () {
        throw new Error('ECONNREFUSED');
    };
    try {
        const res = await app.inject({ method: 'GET', url: `/v1/public/event/${grant}/edit` });
        assert.equal(res.statusCode, 502);
        assert.ok(res.body.includes('Could not load event'));
    } finally {
        CaldavClient.prototype.getEventRaw = orig;
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('public edit: a genuinely deleted event is still a 404', async () => {
    const { dir, app, grant } = await buildEditFixture();
    const orig = CaldavClient.prototype.getEventRaw;
    CaldavClient.prototype.getEventRaw = async function () {
        return null;
    };
    try {
        const res = await app.inject({ method: 'GET', url: `/v1/public/event/${grant}/edit` });
        assert.equal(res.statusCode, 404);
        assert.ok(res.body.includes('Event not found'));
    } finally {
        CaldavClient.prototype.getEventRaw = orig;
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
