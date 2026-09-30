'use strict';

// The feed fetch in src/routes/calendar-subscriptions.js had two silent
// failure modes and one crash:
//   * undici's request() does NOT follow redirects (maxRedirections defaults
//     to 0), and the code only rejected statusCode >= 400 — so a feed that
//     moved (301/302/308) returned {events: []}, indistinguishable from an
//     empty calendar;
//   * `await body.text()` streamed whatever the subscribed URL served into
//     the heap with no cap, on both the success and the error path;
//   * createPinnedDispatcher() returns null for a literal-IP host, and
//     undici's request() throws `Cannot read properties of null (reading
//     'dispatch')` when handed `dispatcher: null` — so every literal-IP
//     subscription failed as 502 no matter how healthy the feed was.
// The subscription URL here is a literal TEST-NET-3 address
// (203.0.113.0/24, documentation range): validateTargetUrl accepts it and
// the pinned-dispatcher path short-circuits to null, so the request goes
// out on the global dispatcher — which the test replaces with an undici
// MockAgent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici');
const calendarSubRoutes = require('../../src/routes/calendar-subscriptions');

const BASE = 'http://203.0.113.5';

const VALID_ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:e1@example.com',
    'DTSTART:20260101T100000Z',
    'DTEND:20260101T110000Z',
    'SUMMARY:Standup',
    'END:VEVENT',
    'END:VCALENDAR',
    ''
].join('\r\n');

function makeStore(sub) {
    return {
        list: () => [],
        get: ({ id, user }) => (id === sub.id && user === sub.user ? sub : null),
        create: (o) => ({ id: 'new', ...o }),
        remove: () => true
    };
}

async function buildApp(store, opts = {}) {
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
    await app.register(calendarSubRoutes, { store, ...opts });
    return app;
}

async function withMock(fn) {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const prev = getGlobalDispatcher();
    setGlobalDispatcher(mock);
    try {
        return await fn(mock.get(BASE));
    } finally {
        setGlobalDispatcher(prev);
        await mock.close();
    }
}

const EVENTS_URL = '/v1/me/calendar-subscriptions/s1/events?start=2020-01-01T00:00:00Z&end=2030-01-01T00:00:00Z';

test('feed fetch: a healthy literal-IP feed still delivers its events', async () => {
    await withMock(async (pool) => {
        pool.intercept({ path: '/feed.ics' }).reply(200, VALID_ICS, { headers: { 'content-type': 'text/calendar' } });
        const store = makeStore({ id: 's1', user: 't@x.com', url: `${BASE}/feed.ics` });
        const app = await buildApp(store);
        try {
            const res = await app.inject({ method: 'GET', url: EVENTS_URL });
            assert.equal(res.statusCode, 200);
            const body = JSON.parse(res.body);
            assert.equal(body.events.length, 1);
            assert.equal(body.events[0].summary, 'Standup');
        } finally {
            await app.close();
        }
    });
});

test('feed fetch: a moved feed (3xx) is an error, not a silent empty calendar', async () => {
    await withMock(async (pool) => {
        pool.intercept({ path: '/moved.ics' }).reply(302, '', {
            headers: { location: `${BASE}/feed.ics` }
        });
        const store = makeStore({ id: 's1', user: 't@x.com', url: `${BASE}/moved.ics` });
        const app = await buildApp(store);
        try {
            const res = await app.inject({ method: 'GET', url: EVENTS_URL });
            assert.equal(res.statusCode, 502, 'a non-followed redirect must surface as a fetch failure');
            const body = JSON.parse(res.body);
            assert.equal(body.detail, 'Could not fetch the calendar feed');
        } finally {
            await app.close();
        }
    });
});

test('feed fetch: an oversized feed is refused at the byte cap', async () => {
    await withMock(async (pool) => {
        const huge = VALID_ICS + 'X'.repeat(8192);
        pool.intercept({ path: '/big.ics' }).reply(200, huge, { headers: { 'content-type': 'text/calendar' } });
        const store = makeStore({ id: 's1', user: 't@x.com', url: `${BASE}/big.ics` });
        const app = await buildApp(store, { maxFeedBytes: 1024 });
        try {
            const res = await app.inject({ method: 'GET', url: EVENTS_URL });
            assert.equal(res.statusCode, 502, 'a feed past the cap must fail, not be buffered whole');
        } finally {
            await app.close();
        }
    });
});

test('feed fetch: upstream error text is logged, never reflected', async () => {
    await withMock(async (pool) => {
        pool.intercept({ path: '/err.ics' }).reply(404, 'SECRET INTERNAL DETAIL http://10.0.0.5:6379');
        const store = makeStore({ id: 's1', user: 't@x.com', url: `${BASE}/err.ics` });
        const app = await buildApp(store);
        try {
            const res = await app.inject({ method: 'GET', url: EVENTS_URL });
            assert.equal(res.statusCode, 502);
            const body = JSON.parse(res.body);
            assert.equal(body.detail, 'Could not fetch the calendar feed');
            assert.ok(!res.body.includes('SECRET'), 'upstream bytes must not reach the caller');
        } finally {
            await app.close();
        }
    });
});
