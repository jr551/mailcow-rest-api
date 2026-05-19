'use strict';

const { parseBasicAuth, verifyWithDovecot } = require('../auth');
const { unauthorized, problem } = require('../errors');
const { problemSchema } = require('../schemas');

module.exports = async function sessionRoutes(app, { cache, imap, sessionTtlMs }) {
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
};
