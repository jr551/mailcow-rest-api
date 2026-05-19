'use strict';

const { notFound, badRequest, problem } = require('../errors');
const { problemSchema } = require('../schemas');

function requirePassword(req) {
    if (!req.creds.pass) {
        throw problem(401, 'Unauthorized', 'ManageSieve requires Basic Auth. Bearer tokens cannot be used for mail rules because the plaintext password is needed to authenticate with Dovecot ManageSieve.');
    }
}

function validateRuleBody(body) {
    if (!body.name || typeof body.name !== 'string') {
        throw badRequest('Rule name is required');
    }
    if (!body.condition || typeof body.condition !== 'object') {
        throw badRequest('Rule condition is required');
    }
    if (!body.action || typeof body.action !== 'object') {
        throw badRequest('Rule action is required');
    }
    const validConditions = ['envelope-to-is', 'header-contains', 'header-is', 'from-contains', 'to-contains', 'subject-contains'];
    if (!validConditions.includes(body.condition.type)) {
        throw badRequest(`Invalid condition type. Must be one of: ${validConditions.join(', ')}`);
    }
    if (body.condition.type.startsWith('header-') && !body.condition.header) {
        throw badRequest('Header name is required for header conditions');
    }
    if (!body.condition.value || typeof body.condition.value !== 'string') {
        throw badRequest('Condition value is required');
    }
    const validActions = ['discard', 'redirect', 'copy'];
    if (!validActions.includes(body.action.type)) {
        throw badRequest(`Invalid action type. Must be one of: ${validActions.join(', ')}`);
    }
    if ((body.action.type === 'redirect' || body.action.type === 'copy') && !body.action.to) {
        throw badRequest('Action "to" is required for redirect and copy actions');
    }
}

module.exports = async function mailRulesRoutes(app, { sieveManager }) {
    // ========== BLOCKED RECIPIENTS (backward compat) ==========

    app.get('/v1/me/blocked-recipients', {
        schema: {
            tags: ['recipient-policy'],
            summary: 'List blocked recipient (To) addresses',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        recipients: { type: 'array', items: { type: 'string' } }
                    }
                }
            }
        }
    }, async (req) => {
        requirePassword(req);
        const user = req.creds.user;
        if (!sieveManager) return { user, recipients: [] };
        const pass = req.creds.pass;
        const recipients = await sieveManager.listBlockedRecipients(user, pass);
        return { user, recipients };
    });

    app.post('/v1/me/blocked-recipients', {
        schema: {
            tags: ['recipient-policy'],
            summary: 'Block a recipient (To) address — you must actually receive mail at this address',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['recipient'],
                properties: { recipient: { type: 'string', format: 'email' } }
            },
            response: {
                201: {
                    type: 'object',
                    properties: { recipient: { type: 'string' } }
                },
                400: problemSchema,
                403: problemSchema,
                409: problemSchema
            }
        }
    }, async (req, reply) => {
        requirePassword(req);
        const user = req.creds.user;
        if (!sieveManager) throw badRequest('ManageSieve not configured');
        const pass = req.creds.pass;
        const { recipient } = req.body;
        try {
            const result = await sieveManager.addBlockedRecipient(user, pass, recipient);
            reply.code(201);
            return result;
        } catch (err) {
            if (err.message === 'Invalid email address') throw badRequest(err.message);
            if (err.message === 'You cannot block a recipient address you do not receive mail for') throw problem(403, 'Forbidden', err.message);
            if (err.message === 'Recipient already blocked') throw problem(409, 'Conflict', err.message);
            throw err;
        }
    });

    app.delete('/v1/me/blocked-recipients/:recipient', {
        schema: {
            tags: ['recipient-policy'],
            summary: 'Unblock a recipient (To) address',
            response: {
                204: { type: 'null' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        requirePassword(req);
        const user = req.creds.user;
        if (!sieveManager) throw notFound('Blocked recipient not found');
        const pass = req.creds.pass;
        const recipient = decodeURIComponent(req.params.recipient);
        try {
            await sieveManager.removeBlockedRecipient(user, pass, recipient);
            reply.code(204).send();
        } catch (err) {
            if (err.message === 'Not found') throw notFound('Blocked recipient not found');
            throw err;
        }
    });

    // ========== UNIFIED MAIL RULES ==========

    app.get('/v1/me/mail-rules', {
        schema: {
            tags: ['mail-rules'],
            summary: 'List all mail rules (blocks, redirects, copies)',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        rules: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    name: { type: 'string' },
                                    condition: { type: 'object', additionalProperties: true },
                                    action: { type: 'object', additionalProperties: true }
                                }
                            }
                        }
                    }
                }
            }
        }
    }, async (req) => {
        requirePassword(req);
        const user = req.creds.user;
        if (!sieveManager) return { user, rules: [] };
        const pass = req.creds.pass;
        const rules = await sieveManager.listRules(user, pass);
        return { user, rules };
    });

    app.post('/v1/me/mail-rules', {
        schema: {
            tags: ['mail-rules'],
            summary: 'Add a mail rule (block, redirect, or copy)',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'condition', 'action'],
                properties: {
                    name: { type: 'string' },
                    condition: {
                        type: 'object',
                        required: ['type', 'value'],
                        properties: {
                            type: {
                                type: 'string',
                                enum: ['envelope-to-is', 'header-contains', 'header-is', 'from-contains', 'to-contains', 'subject-contains']
                            },
                            header: { type: 'string' },
                            value: { type: 'string' }
                        }
                    },
                    action: {
                        type: 'object',
                        required: ['type'],
                        properties: {
                            type: { type: 'string', enum: ['discard', 'redirect', 'copy'] },
                            to: { type: 'string', format: 'email' }
                        }
                    }
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        condition: { type: 'object', additionalProperties: true },
                        action: { type: 'object', additionalProperties: true }
                    }
                },
                400: problemSchema,
                403: problemSchema
            }
        }
    }, async (req, reply) => {
        requirePassword(req);
        const user = req.creds.user;
        if (!sieveManager) throw badRequest('ManageSieve not configured');
        const pass = req.creds.pass;
        validateRuleBody(req.body);
        try {
            const rule = await sieveManager.addRule(user, pass, req.body);
            reply.code(201);
            return rule;
        } catch (err) {
            if (err.message === 'You cannot block a recipient address you do not receive mail for') throw problem(403, 'Forbidden', err.message);
            if (err.message === 'Invalid redirect destination email') throw badRequest(err.message);
            throw err;
        }
    });

    app.delete('/v1/me/mail-rules/:id', {
        schema: {
            tags: ['mail-rules'],
            summary: 'Remove a mail rule by ID',
            response: {
                204: { type: 'null' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        requirePassword(req);
        const user = req.creds.user;
        if (!sieveManager) throw notFound('Rule not found');
        const pass = req.creds.pass;
        try {
            await sieveManager.removeRule(user, pass, req.params.id);
            reply.code(204).send();
        } catch (err) {
            if (err.message === 'Not found') throw notFound('Rule not found');
            throw err;
        }
    });
};
