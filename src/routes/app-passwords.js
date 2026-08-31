'use strict';

const { badRequest, forbidden, notFound } = require('../errors');

const appPasswordPublic = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        ipRanges: { type: 'array', items: { type: 'string' } },
        createdAt: { type: ['integer', 'null'] },
        expiresAt: { type: ['integer', 'null'] },
        lastUsedAt: { type: ['integer', 'null'] },
        lastUsedIp: { type: ['string', 'null'] }
    }
};

module.exports = async function appPasswordRoutes(app, { store } = {}) {
    if (!store) {
        app.log.info('app passwords disabled — needs CREDENTIAL_ENCRYPTION_KEY');
        return;
    }

    // An app password must never be able to mint or revoke another one.
    // Otherwise a token leaked from one machine could issue itself a fresh
    // credential scoped to the attacker's own network, and revoking the
    // original would no longer shut the door.
    function requireFullLogin(req) {
        if (req.appPassword) {
            throw forbidden('App passwords cannot manage app passwords — sign in with your mailbox password');
        }
    }

    app.get('/v1/me/app-passwords', {
        schema: {
            tags: ['auth'],
            summary: 'List your app passwords',
            description: 'The token itself is shown only once, when it is created, and is never returned here.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        appPasswords: { type: 'array', items: appPasswordPublic },
                        limit: { type: 'integer' }
                    }
                }
            }
        }
    }, async (req) => {
        requireFullLogin(req);
        return { appPasswords: store.list({ user: req.creds.user }), limit: store.maxPerUser };
    });

    app.post('/v1/me/app-passwords', {
        schema: {
            tags: ['auth'],
            summary: 'Create an app password scoped to one or more IP ranges',
            description:
                'Returns the token once — it cannot be retrieved again. Use it in place of ' +
                'your mailbox password for REST or MCP clients (Basic auth with your address ' +
                'as the username, or as a bearer token on its own). Requests presenting it ' +
                'from outside the given ranges are rejected.',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'ipRanges'],
                properties: {
                    label: { type: 'string', minLength: 1, maxLength: 100 },
                    ipRanges: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 20,
                        items: { type: 'string', minLength: 1 },
                        description: 'IPv4/IPv6 addresses or CIDRs, e.g. ["203.0.113.4", "10.0.0.0/8"]'
                    },
                    expiresInDays: { type: 'integer', minimum: 1, maximum: 3650 }
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        token: { type: 'string', description: 'Shown once. Store it now.' },
                        ...appPasswordPublic.properties
                    }
                }
            }
        }
    }, async (req, reply) => {
        requireFullLogin(req);
        let created;
        try {
            created = store.create({
                user: req.creds.user,
                password: req.creds.pass,
                label: req.body.label,
                ipRanges: req.body.ipRanges,
                expiresInDays: req.body.expiresInDays
            });
        } catch (err) {
            throw badRequest(err.message);
        }
        req.log.info({ id: created.id, label: created.label }, 'app password created');
        reply.code(201);
        return created;
    });

    app.delete('/v1/me/app-passwords/:id', {
        schema: {
            tags: ['auth'],
            summary: 'Revoke an app password',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            response: {
                204: { type: 'null' }
            }
        }
    }, async (req, reply) => {
        requireFullLogin(req);
        const changed = store.revoke({ id: req.params.id, user: req.creds.user });
        if (!changed) throw notFound('No such app password');
        req.log.info({ id: req.params.id }, 'app password revoked');
        reply.code(204);
        return null;
    });
};
