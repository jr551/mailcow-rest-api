'use strict';

const { badRequest, notFound, unauthorized } = require('../errors');
const { withClient } = require('../imap');
const { hashCreds } = require('../cache');

// "Webhook → email" inboxes.
//
// A user mints a secret URL in Settings and hands it to whatever service
// they want mail from — a monitor, Stripe, a shell script. A POST to that
// URL is wrapped in a minimal RFC822 message and APPENDed to the owner's
// INBOX, so it shows up like any other mail (and can be filtered by Sieve
// on the X-Webhook-Inbox header).
//
// The ingest route is public-by-token: the token in the path is the whole
// credential, so it stays under the global rate limiter and the token is
// only ever stored hashed.

const inboxPublic = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        createdAt: { type: ['integer', 'null'] },
        lastUsedAt: { type: ['integer', 'null'] }
    }
};

// CR/LF in a header value is how a "subject" becomes an injected Bcc.
function headerSafe(value, fallback) {
    const clean = String(value || '').replace(/[\r\n]+/g, ' ').trim();
    return clean.slice(0, 200) || fallback;
}

// RFC 2047-encode a header phrase when it isn't plain ASCII.
function encodePhrase(value) {
    if (/^[\x20-\x7e]*$/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMessage({ user, inbox, subject, bodyText, contentType }) {
    const domain = user.includes('@') ? user.split('@')[1] : 'localhost';
    const from = `webhook-${inbox.id}@${domain}`;
    const now = new Date();
    const lines = [
        `From: ${encodePhrase(headerSafe(inbox.label, 'Webhook'))} <${from}>`,
        `To: <${user}>`,
        `Subject: ${encodePhrase(subject)}`,
        `Date: ${now.toUTCString()}`,
        `Message-ID: <whk-${inbox.id}-${now.getTime()}@${domain}>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        'Auto-Submitted: auto-generated',
        `X-Webhook-Inbox: ${inbox.id}`,
        `X-Webhook-Content-Type: ${headerSafe(contentType, 'unknown')}`,
        '',
        bodyText
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8');
}

function bodyToText(req) {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const raw = req.body;
    if (raw === undefined || raw === null) return { text: '(empty body)', ct };
    if (Buffer.isBuffer(raw)) return { text: raw.toString('utf8'), ct };
    if (typeof raw === 'object') {
        // Fastify already parsed JSON — re-render it readable.
        return { text: JSON.stringify(raw, null, 2), ct: ct || 'application/json' };
    }
    const text = String(raw);
    if (ct === 'application/json' || ct.endsWith('+json')) {
        try { return { text: JSON.stringify(JSON.parse(text), null, 2), ct }; }
        catch { /* fall through — keep raw */ }
    }
    return { text, ct };
}

module.exports = async function webhookInboxRoutes(app, { store, pool, getPublicBaseUrl } = {}) {
    if (!store) {
        app.log.info('webhook inboxes disabled — needs CREDENTIAL_ENCRYPTION_KEY');
        return;
    }

    // The ingest endpoint accepts whatever a sender throws at it — JSON,
    // form posts, plain text. Parse everything as a buffer here (this
    // parser is scoped to this plugin's routes only) and format it in the
    // handler.
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
        done(null, body);
    });

    app.get('/v1/me/webhook-inboxes', {
        schema: {
            tags: ['webhooks'],
            summary: 'List your webhook inboxes',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        inboxes: { type: 'array', items: inboxPublic },
                        limit: { type: 'integer' }
                    }
                }
            }
        }
    }, async (req) => ({
        inboxes: store.list({ user: req.creds.user }),
        limit: store.maxPerUser
    }));

    app.post('/v1/me/webhook-inboxes', {
        schema: {
            tags: ['webhooks'],
            summary: 'Create a webhook inbox — POSTs to its URL arrive as email',
            description:
                'Returns the ingest URL once — the token in it cannot be retrieved again. ' +
                'POST any body to the URL; optional ?subject= or X-Webhook-Subject sets the subject.',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['label'],
                properties: {
                    label: { type: 'string', minLength: 1, maxLength: 100 }
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'Shown once. Store it now.' },
                        token: { type: 'string' },
                        ...inboxPublic.properties
                    }
                }
            }
        }
    }, async (req, reply) => {
        let created;
        try {
            created = store.create({
                user: req.creds.user,
                password: req.creds.pass,
                label: req.body.label
            });
        } catch (err) {
            throw badRequest(err.message);
        }
        const base = getPublicBaseUrl ? getPublicBaseUrl(req) : '';
        req.log.info({ id: created.id, label: created.label }, 'webhook inbox created');
        reply.code(201);
        return { ...created, url: `${base}/v1/webhook-inbox/${created.token}` };
    });

    app.delete('/v1/me/webhook-inboxes/:id', {
        schema: {
            tags: ['webhooks'],
            summary: 'Revoke a webhook inbox',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            response: { 204: { type: 'null' } }
        }
    }, async (req, reply) => {
        const changed = store.revoke({ id: req.params.id, user: req.creds.user });
        if (!changed) throw notFound('No such webhook inbox');
        req.log.info({ id: req.params.id }, 'webhook inbox revoked');
        reply.code(204);
        return null;
    });

    // Public ingest. The token is the credential; there is deliberately no
    // IP scope — senders are third-party services whose addresses change.
    app.post('/v1/webhook-inbox/:token', {
        config: { public: true },
        bodyLimit: 512 * 1024,
        schema: {
            tags: ['webhooks'],
            summary: 'Deliver a webhook payload to the owner\'s INBOX',
            params: {
                type: 'object',
                required: ['token'],
                properties: { token: { type: 'string' } }
            },
            querystring: {
                type: 'object',
                additionalProperties: true,
                properties: { subject: { type: 'string', maxLength: 200 } }
            },
            response: { 202: { type: 'object', properties: { ok: { type: 'boolean' } } } }
        }
    }, async (req) => {
        const result = store.verify({ token: req.params.token });
        if (!result.ok) {
            req.log.warn({ reason: result.reason, ip: req.ip }, 'webhook inbox token rejected');
            throw unauthorized('Invalid webhook token');
        }

        const { text, ct } = bodyToText(req);
        const subject = headerSafe(
            req.headers['x-webhook-subject'] || req.query?.subject,
            `Webhook: ${result.label}`
        );
        const message = buildMessage({
            user: result.user,
            inbox: { id: result.id, label: result.label },
            subject,
            bodyText: text.slice(0, 256 * 1024),
            contentType: ct
        });

        const creds = { user: result.user, pass: result.password, hash: hashCreds(result.user, result.password) };
        await withClient(pool, creds, (client) => client.append('INBOX', message));
        req.log.info({ id: result.id, user: result.user }, 'webhook delivered to inbox');
        return { ok: true };
    });
};
