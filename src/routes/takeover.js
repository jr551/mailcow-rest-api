'use strict';

// "AI assistant takeover": a per-user assistant that looks at unread INBOX,
// decides which messages really need a reply, and drafts in the user's voice.
// Confident replies go out directly when the matching sender rule's autoSend
// says so (the worker's injected `send` path); everything else stops for
// approval — the worker's exit for those is a self-POST to /v1/messages/send
// over Basic auth (see takeoverDeliver in server.js), which lands in the
// EXISTING approval gate at src/routes/send.js (`if (isBasicAuth(req))`) and
// creates a pending approve/deny record.
//
// These routes are the user-facing surface only: the tuning governors, the
// per-sender rules that decide which mail the assistant touches and how each
// sender's drafts behave, the blocked ("needs input") queue, and the stop
// switch. The drafting lives in takeover-worker.js; the state lives in
// takeover-store.js. There is deliberately no send capability anywhere in
// this file.

const { badRequest, notFound, unauthorized, problem } = require('../errors');
const { problemSchema } = require('../schemas');

// Only used for the status `counts.processed` readout: the store keeps a
// bounded decision log (recentDecisions), not a lifetime counter, so the
// count is "decisions in the last N" and is capped at this many rows.
const PROCESSED_CAP = 500;

const stateProps = {
    enabled: { type: 'boolean' },
    maxRepliesPerHour: { type: 'integer' },
    minDelayMinutes: { type: 'integer' },
    lookbackHours: { type: 'integer' },
    considerAttachments: { type: 'boolean' }
};

// A per-sender rule. instructions is stored encrypted at rest by the store
// and comes back in the clear only to the rule's owner.
const senderSchema = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        pattern: { type: 'string', maxLength: 200 },
        instructions: { type: 'string', maxLength: 2000 },
        autoSend: { type: 'boolean' },
        signReplies: { type: 'boolean' },
        createdAt: { type: 'integer' }
    }
};

const statusSchema = {
    type: 'object',
    properties: {
        ...stateProps,
        counts: {
            type: 'object',
            properties: {
                processed: { type: 'integer' },
                needsInput: { type: 'integer' }
            }
        },
        blocked: { type: 'boolean', description: 'True while the assistant has stopped on something that needs input.' }
    }
};

const stateSchema = {
    type: 'object',
    properties: stateProps
};

const needsInputSchema = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        messageId: { type: 'string' },
        from: { type: 'string' },
        subject: { type: 'string' },
        missing: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
        threadSnippet: { type: 'string' },
        createdAt: { type: ['integer', 'string', 'null'] },
        status: { type: 'string' },
        resolvedAt: { type: ['integer', 'string', 'null'] },
        advice: { type: ['string', 'null'] }
    }
};

// One decision-ledger row: what the assistant did with a message it looked
// at — sent, drafted (waiting on approval), declined, delayed, rate-limited,
// or stopped for input. `reason` is the owner-facing sentence the worker
// wrote; `detail` (raw model notes) stays server-side.
const decisionSchema = {
    type: 'object',
    properties: {
        messageId: { type: 'string' },
        decision: { type: 'string' },
        reason: { type: 'string' },
        at: { type: 'integer' },
        count: { type: 'integer' }
    }
};

// The global auth hook (src/auth.js) already rejects unauthenticated
// requests before any route runs. This second check keeps the route safe on
// its own as well, so a wiring slip can never expose one mailbox's blocked
// queue to an anonymous caller.
function requireUser(req) {
    const user = req.creds && req.creds.user;
    if (!user) throw unauthorized();
    return user;
}

module.exports = async function takeoverRoutes(app, { store, worker = null } = {}) {
    if (!store) {
        app.log.info('takeover routes disabled — needs TAKEOVER_ENABLED and CREDENTIAL_ENCRYPTION_KEY');
        return;
    }

    // The polling worker runs only while at least one user has the assistant
    // on. Called after every enable/disable so the same rule holds at boot
    // (server.js) and at runtime.
    function syncWorker() {
        if (!worker) return;
        const anyOn = typeof store.hasEnabledUsers === 'function' ? store.hasEnabledUsers() : false;
        try {
            if (anyOn) worker.start();
            else worker.stop();
        } catch (err) {
            app.log.warn({ err: err.message }, 'takeover worker start/stop failed');
        }
    }

    // Fire an immediate poll — used after John posts advice (resume) and
    // after enabling, so the assistant acts now instead of at the next tick.
    // wake() runs the worker's normal cycle: what happens to a draft is
    // decided by the matching sender rule's autoSend and signReplies, never
    // by this route.
    function wakeWorker() {
        if (!worker) return;
        try { worker.wake(); } catch (err) {
            app.log.warn({ err: err.message }, 'takeover worker wake failed');
        }
    }

    app.get('/v1/me/takeover', {
        schema: {
            tags: ['takeover'],
            summary: 'AI assistant takeover status',
            response: {
                200: statusSchema,
                401: problemSchema
            }
        }
    }, async (req) => {
        const user = requireUser(req);
        const items = store.listNeedsInput(user);
        const decisions = store.recentDecisions(user, PROCESSED_CAP);
        return {
            ...store.get(user),
            counts: { processed: decisions.length, needsInput: items.length },
            blocked: items.length > 0
        };
    });

    app.put('/v1/me/takeover', {
        schema: {
            tags: ['takeover'],
            summary: 'Enable/disable the assistant and set its governors',
            description:
                'The governors are enforced SERVER-SIDE by the worker. maxRepliesPerHour is 0-24 ' +
                '(0 = never draft). minDelayMinutes has a hard floor of 5 — a smaller value is ' +
                'REJECTED with 400 rather than silently clamped, because the delay is a safety ' +
                'limit that rides on top of the per-message approval, never instead of it. ' +
                'Which senders the assistant touches, and how each sender\'s drafts behave ' +
                '(standing instructions, autoSend, signReplies), is per-sender rule territory: ' +
                'see /v1/me/takeover/senders.',
            body: {
                type: 'object',
                // NOT `additionalProperties: false`: Fastify's default AJV
                // config (removeAdditional) would silently DELETE an unknown
                // knob before the handler ran, and a typo'd setting must be
                // refused, not quietly ignored. Unknown keys reach the
                // handler and are rejected there with a named 400.
                additionalProperties: true,
                minProperties: 1,
                properties: {
                    enabled: { type: 'boolean' },
                    maxRepliesPerHour: { type: 'integer', minimum: 0, maximum: 24 },
                    // The floor. 1..4 minutes is rejected with 400.
                    minDelayMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
                    lookbackHours: { type: 'integer', minimum: 1, maximum: 720 },
                    considerAttachments: { type: 'boolean' }
                }
            },
            response: {
                200: stateSchema,
                400: problemSchema,
                401: problemSchema
            }
        }
    }, async (req) => {
        const user = requireUser(req);
        // Named refusal for anything outside the five governors — see the
        // body schema for why this cannot lean on additionalProperties.
        // The store throws on the same thing; both land on a 400 with the
        // offending key in the message.
        const keys = Object.keys(req.body);
        if (!keys.length) throw badRequest('No settings given');
        for (const key of keys) {
            if (!['enabled', 'maxRepliesPerHour', 'minDelayMinutes', 'lookbackHours', 'considerAttachments'].includes(key)) {
                throw badRequest(`Unknown takeover setting: ${key}`);
            }
        }
        // The store clamps to the same ranges and throws on a key outside
        // the five governors; the schema above rejects both first, so this
        // only maps a store-side refusal to a 400 instead of a 500.
        let state;
        try {
            state = store.set(user, req.body);
        } catch (err) {
            throw badRequest(err.message);
        }
        syncWorker();
        if (state.enabled) wakeWorker();
        req.log.info({ user, ...state }, 'takeover settings updated');
        return state;
    });

    // --- per-sender rules -----------------------------------------------

    app.get('/v1/me/takeover/senders', {
        schema: {
            tags: ['takeover'],
            summary: 'List the per-sender rules, oldest first',
            response: {
                200: {
                    type: 'object',
                    properties: { senders: { type: 'array', items: senderSchema } }
                },
                401: problemSchema
            }
        }
    }, async (req) => ({ senders: store.listSenders(requireUser(req)) }));

    app.post('/v1/me/takeover/senders', {
        schema: {
            tags: ['takeover'],
            summary: 'Add a per-sender rule',
            description:
                'The assistant only ever looks at mail from a sender a rule covers; with no rules ' +
                'it idles. pattern is a full email address or an @domain (at most 200 characters); ' +
                'a second rule for the same sender, case-insensitively, is refused with 400, as is ' +
                'a pattern of any other shape. instructions are standing orders carried into every ' +
                'draft for this sender (capped at 2000 characters, encrypted at rest); autoSend ' +
                'lets a confident draft for this sender leave directly; signReplies adds the ' +
                'one-line AI sign-off. At most 50 rules per user.',
            body: {
                type: 'object',
                // additionalProperties: true for the same reason as on PUT:
                // an unknown key must be refused by name, not deleted.
                additionalProperties: true,
                required: ['pattern'],
                minProperties: 1,
                properties: {
                    pattern: { type: 'string', maxLength: 200 },
                    instructions: { type: 'string', maxLength: 2000 },
                    autoSend: { type: 'boolean' },
                    signReplies: { type: 'boolean' }
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: { sender: senderSchema }
                },
                400: problemSchema,
                401: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = requireUser(req);
        for (const key of Object.keys(req.body)) {
            if (!['pattern', 'instructions', 'autoSend', 'signReplies'].includes(key)) {
                throw badRequest(`Unknown takeover sender field: ${key}`);
            }
        }
        // The store validates the pattern shape, the duplicate and the
        // per-user cap; a refusal maps to a 400 with its reason.
        let sender;
        try {
            sender = store.addSender(user, req.body);
        } catch (err) {
            throw badRequest(err.message);
        }
        wakeWorker();
        req.log.info({ user, pattern: sender.pattern }, 'takeover sender rule added');
        reply.code(201);
        return { sender };
    });

    app.patch('/v1/me/takeover/senders/:id', {
        schema: {
            tags: ['takeover'],
            summary: 'Update one per-sender rule',
            description:
                'Merges the given fields over the rule; the pattern itself is not patchable — ' +
                'changing which sender a rule covers is delete + add, and the two are kept as ' +
                'the distinct actions they are.',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            body: {
                type: 'object',
                additionalProperties: true,
                minProperties: 1,
                properties: {
                    instructions: { type: 'string', maxLength: 2000 },
                    autoSend: { type: 'boolean' },
                    signReplies: { type: 'boolean' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: { sender: senderSchema }
                },
                400: problemSchema,
                401: problemSchema,
                404: problemSchema
            }
        }
    }, async (req) => {
        const user = requireUser(req);
        for (const key of Object.keys(req.body)) {
            if (!['instructions', 'autoSend', 'signReplies'].includes(key)) {
                throw badRequest(`Unknown takeover sender field: ${key}`);
            }
        }
        let sender;
        try {
            sender = store.updateSender(user, req.params.id, req.body);
        } catch (err) {
            throw badRequest(err.message);
        }
        if (!sender) throw notFound('No such sender rule');
        wakeWorker();
        req.log.info({ user, id: req.params.id }, 'takeover sender rule updated');
        return { sender };
    });

    app.delete('/v1/me/takeover/senders/:id', {
        schema: {
            tags: ['takeover'],
            summary: 'Remove a per-sender rule',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            response: {
                204: { type: 'null' },
                401: problemSchema,
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = requireUser(req);
        if (!store.deleteSender(user, req.params.id)) throw notFound('No such sender rule');
        req.log.info({ user, id: req.params.id }, 'takeover sender rule removed');
        reply.code(204);
        return null;
    });

    app.get('/v1/me/takeover/needs-input', {
        schema: {
            tags: ['takeover'],
            summary: 'Messages the assistant stopped on because it needs your input',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        items: { type: 'array', items: needsInputSchema }
                    }
                },
                401: problemSchema
            }
        }
    }, async (req) => ({ items: store.listNeedsInput(requireUser(req)) }));

    app.get('/v1/me/takeover/activity', {
        schema: {
            tags: ['takeover'],
            summary: 'Recent assistant decisions — the history list for the AI Cloud Reply surface',
            description:
                'Newest first, capped at 50 rows. Includes decisions whose message is also in the ' +
                'needs-input queue, so the modal can show "what happened" beside "what is waiting". ' +
                'Read-only; nothing here can send or retry anything.',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        items: { type: 'array', items: decisionSchema }
                    }
                },
                401: problemSchema
            }
        }
    }, async (req) => ({ items: store.recentDecisions(requireUser(req), 50) }));

    app.post('/v1/me/takeover/needs-input/:id', {
        schema: {
            tags: ['takeover'],
            summary: 'Answer a blocked item ("resume with advice")',
            description:
                "John's answer is stored as context for the NEXT draft the assistant makes for " +
                'this thread. This endpoint never sends anything and never submits a draft — ' +
                'the next draft is made on the worker\'s own schedule and then follows the ' +
                'owner\'s autoSend setting like every other send.',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['advice'],
                properties: {
                    advice: { type: 'string', minLength: 1, maxLength: 4000 }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        entry: needsInputSchema
                    }
                },
                400: problemSchema,
                401: problemSchema,
                404: problemSchema
            }
        }
    }, async (req) => {
        const user = requireUser(req);
        // No send path exists in this handler. The advice is context, not a
        // message: it feeds the next draft, and that draft follows the
        // owner's autoSend setting exactly as a poll-drafted one would.
        const entry = store.resolveNeedsInput(user, req.params.id, req.body.advice);
        if (!entry) throw notFound('No such blocked item');
        req.log.info({ user, id: req.params.id }, 'takeover: advice recorded');
        wakeWorker();
        return { ok: true, entry };
    });

    app.delete('/v1/me/takeover/needs-input/:id', {
        schema: {
            tags: ['takeover'],
            summary: 'Dismiss one blocked item ("stop" on this one)',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            response: {
                204: { type: 'null' },
                401: problemSchema,
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = requireUser(req);
        // Per-item "stop". dismissNeedsInput closes the item AND marks the
        // message processed, so the assistant never touches that thread
        // again — unlike resolveNeedsInput, which resumes it with advice.
        // Existence is checked by listing first so the route does not
        // depend on what dismissNeedsInput returns.
        const known = store.listNeedsInput(user).some((item) => item.id === req.params.id);
        if (!known) throw notFound('No such blocked item');
        store.dismissNeedsInput(user, req.params.id, null);
        req.log.info({ user, id: req.params.id }, 'takeover: blocked item dismissed');
        reply.code(204);
        return null;
    });

    app.post('/v1/me/takeover/stop', {
        schema: {
            tags: ['takeover'],
            summary: 'Turn the assistant off and clear its blocked state',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        cleared: { type: 'integer' }
                    }
                },
                401: problemSchema
            }
        }
    }, async (req) => {
        const user = requireUser(req);
        const items = store.listNeedsInput(user);
        // Clearing the blocked state stops work on every waiting thread:
        // dismissed, not resolved — "the whole thing off" means the
        // assistant must not come back to any of them later.
        for (const item of items) store.dismissNeedsInput(user, item.id, null);
        const state = store.set(user, { enabled: false });
        syncWorker();
        req.log.info({ user, cleared: items.length }, 'takeover stopped');
        return { enabled: state.enabled, cleared: items.length };
    });

};
