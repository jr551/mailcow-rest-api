'use strict';

const webpush = require('web-push');
const config = require('../config');
const { problem, badRequest, notFound } = require('../errors');
const { problemSchema } = require('../schemas');

const subscriptionSchema = {
    type: 'object',
    required: ['subscription'],
    properties: {
        subscription: {
            type: 'object',
            required: ['endpoint', 'keys'],
            properties: {
                endpoint: { type: 'string', format: 'uri', minLength: 8, maxLength: 2048 },
                expirationTime: { type: ['number', 'null'] },
                keys: {
                    type: 'object',
                    required: ['p256dh', 'auth'],
                    properties: {
                        p256dh: { type: 'string', minLength: 16, maxLength: 256 },
                        auth: { type: 'string', minLength: 8, maxLength: 256 }
                    },
                    additionalProperties: true
                }
            },
            additionalProperties: true
        }
    },
    additionalProperties: false
};

const unsubscribeSchema = {
    type: 'object',
    required: ['endpoint'],
    properties: { endpoint: { type: 'string', format: 'uri', minLength: 8, maxLength: 2048 } },
    additionalProperties: false
};

const okSchema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } }
};

const configSchema = {
    type: 'object',
    properties: {
        vapidPublicKey: { type: 'string' },
        configured: { type: 'boolean' }
    }
};

module.exports = async function pushRoutes(app, { pushStore }) {
    // Public — the SPA needs the VAPID public key before subscribing. Only
    // the public key is shared; the private key never leaves the server.
    app.get('/v1/push/config', {
        config: { public: true },
        schema: {
            tags: ['push'],
            summary: 'Web Push config (VAPID public key)',
            response: { 200: configSchema }
        }
    }, async () => ({
        vapidPublicKey: config.push.vapidPublicKey || '',
        configured: !!(config.push.vapidPublicKey && config.push.vapidPrivateKey)
    }));

    app.post('/v1/push/subscribe', {
        schema: {
            tags: ['push'],
            summary: 'Register a Web Push subscription for the current user',
            body: subscriptionSchema,
            response: { 201: okSchema }
        }
    }, async (req, reply) => {
        if (!req.creds) throw problem(401, 'Unauthorized', 'Authentication required');
        try {
            pushStore.upsert({ user: req.creds.user, subscription: req.body.subscription });
        } catch (err) {
            throw badRequest(err.message || 'Invalid subscription');
        }
        reply.code(201);
        return { ok: true };
    });

    app.delete('/v1/push/subscribe', {
        schema: {
            tags: ['push'],
            summary: 'Drop a Web Push subscription by endpoint',
            body: unsubscribeSchema,
            response: { 200: okSchema, 404: problemSchema }
        }
    }, async (req) => {
        if (!req.creds) throw problem(401, 'Unauthorized', 'Authentication required');
        const changes = pushStore.delete({ endpoint: req.body.endpoint, user: req.creds.user });
        if (!changes) throw notFound('Subscription not found');
        return { ok: true };
    });

    // Diagnostic-only: send a "test" notification to every subscription
    // the calling user has registered. Useful when troubleshooting why
    // the user reports "push isn't working" — surfaces deliver-time
    // errors per endpoint instead of waiting on the inbox poller.
    app.post('/v1/push/test', {
        schema: {
            tags: ['push'],
            summary: 'Send a test push notification to the calling user',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        sent: { type: 'integer' },
                        failed: { type: 'integer' },
                        endpoints: { type: 'array', items: {
                            type: 'object',
                            properties: {
                                endpoint: { type: 'string' },
                                ok: { type: 'boolean' },
                                error: { type: 'string' },
                                status: { type: 'integer' }
                            }
                        } }
                    }
                },
                501: problemSchema
            }
        }
    }, async (req, reply) => {
        if (!req.creds) throw problem(401, 'Unauthorized', 'Authentication required');
        const vapidPublic = config.push.vapidPublicKey || '';
        const vapidPrivate = config.push.vapidPrivateKey || '';
        if (!vapidPublic || !vapidPrivate) {
            throw problem(501, 'Not Configured', 'Server VAPID keys are not set; push cannot be delivered.');
        }
        try {
            webpush.setVapidDetails(config.push.vapidSubject || 'mailto:admin@example.com', vapidPublic, vapidPrivate);
        } catch (err) {
            throw problem(500, 'VAPID error', err.message);
        }
        const subs = pushStore.listForUser({ user: req.creds.user });
        if (!subs || subs.length === 0) {
            return { sent: 0, failed: 0, endpoints: [] };
        }
        const payload = JSON.stringify({
            title: 'Test notification',
            body: `If you can read this, push is working for ${req.creds.user}.`,
            tag: 'webmail-test',
            url: '/webmail/',
            badge: '/webmail/icon.svg'
        });
        const endpoints = [];
        let sent = 0;
        let failed = 0;
        for (const sub of subs) {
            try {
                await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
                    payload
                );
                sent++;
                endpoints.push({ endpoint: sub.endpoint, ok: true, error: '', status: 200 });
            } catch (err) {
                failed++;
                const status = (err && err.statusCode) || 0;
                if (status === 410 || status === 404) {
                    pushStore.delete({ endpoint: sub.endpoint, user: req.creds.user });
                }
                endpoints.push({
                    endpoint: sub.endpoint,
                    ok: false,
                    error: (err && err.message) || 'send failed',
                    status
                });
            }
        }
        reply.code(200);
        return { sent, failed, endpoints };
    });
};
