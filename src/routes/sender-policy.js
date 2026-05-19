'use strict';

const { badRequest, notFound, problem } = require('../errors');
const { problemSchema } = require('../schemas');
const { isValidSenderPattern } = require('../mailcow-db');

module.exports = async function senderPolicyRoutes(app, { db }) {
    app.get('/v1/me/blocked-senders', {
        schema: {
            tags: ['sender-policy'],
            summary: 'List blocked senders for the authenticated user',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        list: { type: 'array', items: { type: 'object', properties: { prefid: { type: 'integer' }, sender: { type: 'string' } } } }
                    }
                },
                401: problemSchema
            }
        }
    }, async (req) => {
        const user = req.creds.user;
        if (!db) return { user, list: [] };
        const list = await db.listPolicies(user, 'blacklist_from');
        return { user, list };
    });

    app.post('/v1/me/blocked-senders', {
        schema: {
            tags: ['sender-policy'],
            summary: 'Block a sender',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['sender'],
                properties: { sender: { type: 'string' } }
            },
            response: {
                201: {
                    type: 'object',
                    properties: { prefid: { type: 'integer' }, sender: { type: 'string' } }
                },
                400: problemSchema,
                409: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = req.creds.user;
        if (!db) throw badRequest('Mailcow DB not configured');
        const { sender } = req.body;
        if (!isValidSenderPattern(sender)) throw badRequest('Invalid sender pattern');
        try {
            const result = await db.addPolicy(user, 'blacklist_from', sender);
            reply.code(201);
            return result;
        } catch (err) {
            if (err.message === 'Sender policy already exists') throw problem(409, 'Conflict', err.message);
            throw err;
        }
    });

    app.delete('/v1/me/blocked-senders/:prefid', {
        schema: {
            tags: ['sender-policy'],
            summary: 'Unblock a sender',
            response: {
                204: { type: 'null' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = req.creds.user;
        if (!db) throw notFound('Blocked sender not found');
        const prefid = Number(req.params.prefid);
        const ok = await db.removePolicy(user, 'blacklist_from', prefid);
        if (!ok) throw notFound('Blocked sender not found');
        reply.code(204).send();
    });

    app.get('/v1/me/allowed-senders', {
        schema: {
            tags: ['sender-policy'],
            summary: 'List allowed senders for the authenticated user',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        list: { type: 'array', items: { type: 'object', properties: { prefid: { type: 'integer' }, sender: { type: 'string' } } } }
                    }
                },
                401: problemSchema
            }
        }
    }, async (req) => {
        const user = req.creds.user;
        if (!db) return { user, list: [] };
        const list = await db.listPolicies(user, 'whitelist_from');
        return { user, list };
    });

    app.post('/v1/me/allowed-senders', {
        schema: {
            tags: ['sender-policy'],
            summary: 'Allow a sender (whitelist)',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['sender'],
                properties: { sender: { type: 'string' } }
            },
            response: {
                201: {
                    type: 'object',
                    properties: { prefid: { type: 'integer' }, sender: { type: 'string' } }
                },
                400: problemSchema,
                409: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = req.creds.user;
        if (!db) throw badRequest('Mailcow DB not configured');
        const { sender } = req.body;
        if (!isValidSenderPattern(sender)) throw badRequest('Invalid sender pattern');
        try {
            const result = await db.addPolicy(user, 'whitelist_from', sender);
            reply.code(201);
            return result;
        } catch (err) {
            if (err.message === 'Sender policy already exists') throw problem(409, 'Conflict', err.message);
            throw err;
        }
    });

    app.delete('/v1/me/allowed-senders/:prefid', {
        schema: {
            tags: ['sender-policy'],
            summary: 'Remove an allowed sender',
            response: {
                204: { type: 'null' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = req.creds.user;
        if (!db) throw notFound('Allowed sender not found');
        const prefid = Number(req.params.prefid);
        const ok = await db.removePolicy(user, 'whitelist_from', prefid);
        if (!ok) throw notFound('Allowed sender not found');
        reply.code(204).send();
    });
};
