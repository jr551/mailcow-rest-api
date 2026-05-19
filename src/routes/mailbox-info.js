'use strict';

const { notFound, badRequest } = require('../errors');
const { problemSchema } = require('../schemas');

module.exports = async function mailboxInfoRoutes(app, { db }) {
    app.get('/v1/me/mailbox', {
        schema: {
            tags: ['mailbox-info'],
            summary: 'Get mailbox stats and profile',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        username: { type: 'string' },
                        name: { type: ['string', 'null'] },
                        active: { type: 'boolean' },
                        domain: { type: 'string' },
                        localPart: { type: 'string' },
                        quota: { type: 'integer' },
                        quotaUsed: { type: 'integer' },
                        percentInUse: { type: 'integer' },
                        messages: { type: 'integer' },
                        created: { type: 'string' },
                        modified: { type: 'string' },
                        authsource: { type: 'string' },
                        attributes: { type: 'object' }
                    }
                },
                404: problemSchema
            }
        }
    }, async (req) => {
        const user = req.creds.user;
        if (!db) return { user, username: user, name: null, active: true, domain: '', localPart: '', quota: 0, quotaUsed: 0, percentInUse: 0, messages: 0, created: '', modified: '', authsource: 'mailcow', attributes: {} };
        const data = await db.getMailbox(user);
        if (!data) throw notFound('Mailbox not found');
        return data;
    });

    app.get('/v1/me/logins', {
        schema: {
            tags: ['mailbox-info'],
            summary: 'Get recent SASL login history',
            querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        logins: { type: 'array', items: { type: 'object', additionalProperties: true } }
                    }
                }
            }
        }
    }, async (req) => {
        const user = req.creds.user;
        const limit = Number(req.query.limit) || 20;
        if (!db) return { user, logins: [] };
        const logins = await db.getLogins(user, limit);
        return { user, logins };
    });

    app.get('/v1/me/aliases', {
        schema: {
            tags: ['mailbox-info'],
            summary: 'List aliases that forward to this mailbox',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        aliases: { type: 'array', items: { type: 'object', additionalProperties: true } }
                    }
                }
            }
        }
    }, async (req) => {
        const user = req.creds.user;
        if (!db) return { user, aliases: [] };
        const aliases = await db.listAliases(user);
        return { user, aliases };
    });

    app.get('/v1/me/temp-aliases', {
        schema: {
            tags: ['mailbox-info'],
            summary: 'List active time-limited (temp) aliases',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        aliases: { type: 'array', items: { type: 'object', additionalProperties: true } }
                    }
                }
            }
        }
    }, async (req) => {
        const user = req.creds.user;
        if (!db) return { user, aliases: [] };
        const aliases = await db.listTempAliases(user);
        return { user, aliases };
    });

    app.post('/v1/me/temp-aliases', {
        schema: {
            tags: ['mailbox-info'],
            summary: 'Create a time-limited alias',
            body: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    description: { type: 'string' },
                    validityHours: { type: 'integer', minimum: 1, maximum: 87600, default: 720 },
                    permanent: { type: 'boolean', default: false }
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        address: { type: 'string' },
                        validity: { type: 'integer' },
                        permanent: { type: 'boolean' }
                    }
                },
                400: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = req.creds.user;
        if (!db) throw badRequest('Mailcow DB not configured');
        const { description, validityHours, permanent } = req.body || {};
        try {
            const result = await db.createTempAlias(user, { description: description || '', validityHours, permanent });
            reply.code(201);
            return result;
        } catch (err) {
            if (err.message === 'Invalid email' || err.message.includes('Validity')) throw badRequest(err.message);
            throw err;
        }
    });

    app.delete('/v1/me/temp-aliases/:address', {
        schema: {
            tags: ['mailbox-info'],
            summary: 'Delete a time-limited alias',
            response: {
                204: { type: 'null' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = req.creds.user;
        if (!db) throw notFound('Temp alias not found');
        const address = decodeURIComponent(req.params.address);
        const ok = await db.deleteTempAlias(user, address);
        if (!ok) throw notFound('Temp alias not found');
        reply.code(204).send();
    });

    app.get('/v1/me/send-from', {
        schema: {
            tags: ['mailbox-info'],
            summary: 'Get all addresses this user can send from (mailbox + aliases + temp aliases)',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        addresses: { type: 'array', items: { type: 'string' } },
                        // Domains for which the user holds a catch-all alias
                        // (`@example.com`). Webmail uses this to allow a
                        // free-form FROM input restricted to these domains.
                        wildcardDomains: { type: 'array', items: { type: 'string' } }
                    }
                }
            }
        }
    }, async (req) => {
        const user = req.creds.user;
        if (!db) return { user, addresses: [user], wildcardDomains: [] };
        const result = await db.getSendFromAddresses(user);
        // Tolerate the older shape (plain array) so a stale db helper
        // doesn't 500 the route — happens only in tests.
        if (Array.isArray(result)) {
            return { user, addresses: result, wildcardDomains: [] };
        }
        return { user, ...result };
    });
};
