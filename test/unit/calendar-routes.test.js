'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const calendarRoutes = require('../../src/routes/calendar');

test('calendar routes are not registered when sogoUrl is empty', async () => {
    const app = Fastify();
    await app.register(sensible);
    await app.register(calendarRoutes, { sogoUrl: '' });

    const res = await app.inject({
        method: 'GET',
        url: '/v1/me/calendars'
    });
    assert.equal(res.statusCode, 404);
});

test('calendar routes are registered when sogoUrl is set', async () => {
    const app = Fastify();
    await app.register(sensible);
    await app.register(calendarRoutes, { sogoUrl: 'http://sogo-test/SOGo' });

    // Route exists but auth will fail since we have no auth hook.
    // The important thing is it's NOT 404.
    const res = await app.inject({
        method: 'GET',
        url: '/v1/me/calendars'
    });
    assert.notEqual(res.statusCode, 404);
});
