'use strict';

const { badRequest, notFound } = require('../errors');
const { sanitizeWebhookHeaders } = require('../utils/webhook-headers');
const { problemSchema } = require('../schemas');
const { assertPublicDestination } = require('../utils/ssrf-guard');

// "Email → webhook" subscriptions.
//
// A user names a URL; a Sieve rule parks matching mail in the webhook's
// hidden mailbox; the forwarder POSTs it. This route owns the subscription
// itself — the delivery side lives in outbound-webhook-forwarder.js.
//
// The signing secret is returned exactly once, at creation, and never
// listed again. That is the same contract as app passwords and webhook-inbox
// tokens: a secret you can re-read is a secret that leaks through a screen
// share, a log line, or a support screenshot.

const webhookPublic = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        url: { type: 'string' },
        keep: { type: 'boolean', description: 'Keep the message in the mailbox after a successful delivery.' },
        prepend: { type: 'string', description: 'Free text placed above the quoted original in the forwarded body.' },
        mailbox: { type: 'string', description: 'Hidden IMAP folder the rule delivers into.' },
        // Names only; stored values are credentials and are masked forever.
        headers: {
            type: 'object',
            description: 'Custom request headers (e.g. Authorization). Values are masked.',
            additionalProperties: { type: 'string' }
        },
        createdAt: { type: ['integer', 'null'] },
        lastUsedAt: { type: ['integer', 'null'] }
    }
};

// Shared request-body field for POST and PATCH. The finer rules (reserved
// names, x-webhook-* prefix, control characters) live in
// sanitizeWebhookHeaders and map to 400 in the handler — JSON Schema can
// only express the shape, not the blocklist.
const headersBodyProp = {
    type: 'object',
    maxProperties: 10,
    additionalProperties: { type: 'string', maxLength: 2000 },
    description: 'Extra HTTP headers sent with every delivery, e.g. {"Authorization":"Bearer …"}'
};

// Runs the real validation and turns sanitize failures into a 400. PATCH
// semantics are handled by the store: undefined = unchanged, {} = clear.
function sanitizeOr400(input) {
    try {
        return sanitizeWebhookHeaders(input);
    } catch (err) {
        throw badRequest(err.message);
    }
}


module.exports = async function outboundWebhookRoutes(app, { store, sieveManager } = {}) {
    if (!store) {
        app.log.info('outbound webhooks disabled — needs CREDENTIAL_ENCRYPTION_KEY');
        return;
    }

    app.get('/v1/me/outbound-webhooks', {
        schema: {
            tags: ['webhooks'],
            summary: 'List your outbound webhooks',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        webhooks: { type: 'array', items: webhookPublic },
                        limit: { type: 'integer' }
                    }
                }
            }
        }
    }, async (req) => ({
        webhooks: store.list({ user: req.creds.user }),
        limit: store.maxPerUser
    }));

    app.post('/v1/me/outbound-webhooks', {
        schema: {
            tags: ['webhooks'],
            summary: 'Create an outbound webhook — matching mail is POSTed to its URL',
            description:
                'Returns the signing secret once; it cannot be retrieved again. ' +
                'Point a mail rule at the returned id with action {"type":"webhook","webhookId":"<id>"}.',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'url'],
                properties: {
                    label: { type: 'string', minLength: 1, maxLength: 100 },
                    url: { type: 'string', minLength: 1, maxLength: 2000 },
                    keep: { type: 'boolean' },
                    prepend: { type: 'string', maxLength: 4000 },
                    headers: headersBodyProp
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        secret: { type: 'string', description: 'Shown once. Store it now.' },
                        ...webhookPublic.properties
                    }
                },
                400: problemSchema
            }
        }
    }, async (req, reply) => {
        // The URL is fetched by the server on every matching message, so it
        // is a server-side request forgery sink. Reject anything that is not
        // a public http(s) destination, including a name that resolves to a
        // private address.
        try {
            // https only: the POST carries the message body, headers,
            // attachments and the raw RFC822 source, so a plaintext URL
            // would put mailbox contents on the wire in the clear.
            await assertPublicDestination(req.body.url, { schemes: ['https:'] });
        } catch (err) {
            throw badRequest(`Webhook URL is not allowed: ${err.message}`);
        }
        let created;
        try {
            created = store.create({
                user: req.creds.user,
                password: req.creds.pass,
                label: req.body.label,
                url: req.body.url,
                keep: req.body.keep,
                prepend: req.body.prepend,
                headers: sanitizeOr400(req.body.headers)
            });
        } catch (err) {
            throw badRequest(err.message);
        }
        req.log.info({ id: created.id, label: created.label }, 'outbound webhook created');
        reply.code(201);
        return created;
    });

    app.patch('/v1/me/outbound-webhooks/:id', {
        schema: {
            tags: ['webhooks'],
            summary: 'Update an outbound webhook',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            body: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    label: { type: 'string', minLength: 1, maxLength: 100 },
                    keep: { type: 'boolean' },
                    prepend: { type: 'string', maxLength: 4000 },
                    headers: headersBodyProp
                }
            },
            response: {
                200: webhookPublic,
                404: problemSchema
            }
        }
    }, async (req) => {
        const updated = store.update({
            id: req.params.id,
            user: req.creds.user,
            label: req.body.label,
            keep: req.body.keep,
            prepend: req.body.prepend,
            headers: req.body.headers === undefined ? undefined : sanitizeOr400(req.body.headers)
        });
        if (!updated) throw notFound('No such outbound webhook');
        return updated;
    });

    app.delete('/v1/me/outbound-webhooks/:id', {
        schema: {
            tags: ['webhooks'],
            summary: 'Revoke an outbound webhook',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            response: { 204: { type: 'null' }, 404: problemSchema }
        }
    }, async (req, reply) => {
        const changed = store.revoke({ id: req.params.id, user: req.creds.user });
        if (!changed) throw notFound('No such outbound webhook');
        // Drop the rules that file into this webhook's hidden mailbox. The
        // action is `fileinto ".wh-<id>"; stop;`, so a surviving rule would
        // keep mail out of INBOX and park it in a folder nothing polls.
        if (sieveManager) {
            try {
                const { removed } = await sieveManager.removeRulesByWebhook(
                    req.creds.user,
                    req.creds.pass,
                    req.params.id
                );
                if (removed) {
                    req.log.info({ id: req.params.id, removed }, 'outbound webhook rules removed on revoke');
                }
            } catch (err) {
                // The revoke itself succeeded; a Sieve hiccup must not undo it.
                req.log.warn({ err: err.message, id: req.params.id }, 'could not remove webhook rules on revoke');
            }
        }
        req.log.info({ id: req.params.id }, 'outbound webhook revoked');
        reply.code(204);
        return null;
    });
};
