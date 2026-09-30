'use strict';

const { parseBasicAuth, verifyWithDovecot } = require('../auth');
const { unauthorized, problem } = require('../errors');
const { problemSchema } = require('../schemas');

module.exports = async function sessionRoutes(app, { cache, imap, sessionTtlMs, appPasswords = null, webhookInboxes = null, outboundWebhooks = null }) {
    app.post('/v1/auth/session', {
        config: { public: false },
        schema: {
            tags: ['auth'],
            summary: 'Create a session token',
            description: 'Exchange Basic Auth credentials for a time-limited Bearer token. The token is valid for one hour by default.',
            response: {
                201: {
                    type: 'object',
                    properties: {
                        token: { type: 'string' },
                        expiresAt: { type: 'string', format: 'date-time' }
                    }
                },
                401: problemSchema
            }
        }
    }, async (req, reply) => {
        // With the session store down (the fail-open path in server.js) a
        // token could not be created AND could never be validated again, so
        // issuing one would be a lie. Say so plainly instead of throwing a
        // TypeError at `cache.hashCreds`. Basic-authenticated API calls
        // keep working in this state — only bearer tokens are unavailable.
        if (!cache) {
            throw problem(503, 'Service Unavailable', 'Session store unavailable — use Basic authentication');
        }
        const creds = parseBasicAuth(req.headers.authorization);
        if (!creds) {
            throw unauthorized('Missing Basic credentials');
        }

        const { hashCreds } = cache;
        const hash = hashCreds(creds.user, creds.pass);
        const cached = cache.get(hash);
        let valid = cached && cached.valid;

        if (!cached) {
            let result;
            try {
                result = await verifyWithDovecot(imap, creds.user, creds.pass);
            } catch (err) {
                req.log.warn({ err }, 'imap backend unreachable during session creation');
                throw problem(502, 'Bad Gateway', 'IMAP backend unavailable');
            }
            cache.set(hash, result.valid);
            valid = result.valid;
        }

        if (!valid) {
            throw unauthorized('Invalid credentials');
        }

        // Existing app passwords hold an encrypted copy of the mailbox
        // password so they can reach IMAP. A password change would leave every
        // one of them pointing at the old value and silently break every
        // configured client, so a successful sign-in re-keys them. Outbound
        // webhooks keep the same kind of copy for the same reason.
        for (const store of [appPasswords, webhookInboxes, outboundWebhooks]) {
            if (!store) continue;
            try {
                store.refreshSecrets({ user: creds.user, password: creds.pass });
            } catch (err) {
                req.log.warn({ err }, 'could not refresh stored credential secrets');
            }
        }

        const session = cache.createSession(creds.user, creds.pass, hash);
        reply.code(201);
        return {
            token: session.token,
            expiresAt: new Date(session.expiresAt).toISOString()
        };
    });

    app.get('/v1/auth/session', {
        config: { public: false },
        schema: {
            tags: ['auth'],
            summary: 'Check current session status',
            description: 'Returns the session expiry when called with a valid Bearer token.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        authenticated: { type: 'boolean' },
                        expiresAt: { type: 'string', format: 'date-time' }
                    }
                },
                401: problemSchema
            }
        }
    }, async (req) => {
        if (!req.session) {
            throw unauthorized('No active session');
        }
        return {
            authenticated: true,
            expiresAt: new Date(req.session.expiresAt).toISOString()
        };
    });

    // Without this a leaked bearer token was usable until its TTL with no
    // recourse. Bearer auth revokes just the presented token; Basic auth
    // revokes every token for the mailbox (password change / incident
    // response).
    app.delete('/v1/auth/session', {
        config: { public: false },
        schema: {
            tags: ['auth'],
            summary: 'Revoke session tokens',
            description: 'Bearer authentication revokes the current token. Basic authentication revokes every token for that mailbox, intended for password changes or incident response.',
            response: {
                204: { type: 'null' },
                401: problemSchema
            }
        }
    }, async (req, reply) => {
        // Nothing can be revoked from a session store that isn't there —
        // and nothing can be validated against it either, so every token it
        // ever issued is already unusable. 204 is the honest answer.
        if (cache) {
            if (req.session?.token) {
                cache.deleteSession(req.session.token);
            } else {
                cache.deleteSessionsByUser(req.creds.user);
            }
        }
        reply.code(204).send();
    });
};
