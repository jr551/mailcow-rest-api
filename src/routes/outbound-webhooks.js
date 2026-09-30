'use strict';

const { badRequest, notFound, problem } = require('../errors');
const { sanitizeWebhookHeaders } = require('../utils/webhook-headers');
const { problemSchema } = require('../schemas');
// Aliased: the route takes `assertPublicDestination` as an injectable seam
// below, and a parameter default cannot reference a binding of the same
// name (temporal dead zone). The alias keeps the seam and the import from
// colliding.
const { assertPublicDestination: assertPublicDestinationImpl } = require('../utils/ssrf-guard');
const { deliverOutbound } = require('../outbound-webhook-deliver');
const { headerSafe } = require('../utils/rfc822');
const { composeForwardedText } = require('../webhook-payload');

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

// A test send must not consume a real message, and there may be no message
// to consume — the user is usually testing a webhook before any rule exists.
// So this synthesises the smallest payload that still exercises every part of
// the delivery path a receiver can check: the preamble they configured, the
// body field, the JSON envelope, and the signature over the exact bytes.
//
// It deliberately does NOT include attachments or a raw RFC822 blob: the point
// is to prove the transport, signature and auth headers, not to ship a
// synthetic "attachment" that a receiver could mistake for real mail.
const TEST_SUBJECT = 'Test delivery from mailcow-rest-api';
const TEST_BODY =
    'This is a test delivery triggered from the webmail settings page.\n' +
    'No real message was read, nothing was taken out of the mailbox, and no ' +
    'delivery queue was touched.';

function buildTestPayload(webhook, now) {
    const at = new Date(now()).toISOString();
    return {
        webhook: { id: webhook.id, label: webhook.label },
        mailbox: webhook.mailbox,
        // Absent on a real delivery too — it comes from IMAP — but named so
        // a receiver that switches on it does not silently misbehave.
        test: true,
        internalDate: at,
        envelope: {
            messageId: null,
            inReplyTo: null,
            date: at,
            subject: TEST_SUBJECT,
            from: [],
            sender: [],
            replyTo: [],
            to: [],
            cc: [],
            bcc: []
        },
        message: composeForwardedText({ prepend: webhook.prepend, text: TEST_BODY }),
        text: TEST_BODY,
        html: null,
        headers: {
            subject: headerSafe(TEST_SUBJECT, TEST_SUBJECT),
            'x-mailcow-test': 'true',
            'x-outbound-webhook': webhook.id
        },
        attachments: []
    };
}

// Test sends are an SSRF hammer on demand: each one is a POST from this
// server's IP to a URL the caller chose, authenticated with that webhook's
// own credentials. Nothing in the ordinary API surface lets a user make us
// POST at will, so without a brake this route is exactly that — a proxy.
//
// Keyed per (user, webhook) rather than globally, so a user verifying three
// webhooks at once does not lock themselves out, and so one user's activity
// cannot deny another's. Every send consumes the budget, successful or not,
// because a failing endpoint is still a request the receiver had to serve.
const TEST_SEND_LIMIT = 10;
const TEST_SEND_WINDOW_MS = 60_000;
const testSendBudget = new Map();

function claimTestSend(user, id) {
    const key = `${user}\u0000${id}`;
    const now = Date.now();
    const used = (testSendBudget.get(key) || []).filter((t) => now - t < TEST_SEND_WINDOW_MS);
    if (used.length >= TEST_SEND_LIMIT) {
        const retryAfter = Math.ceil((TEST_SEND_WINDOW_MS - (now - used[0])) / 1000);
        return { allowed: false, retryAfter };
    }
    used.push(now);
    testSendBudget.set(key, used);
    return { allowed: true };
}

// The map is module state, so prune it: entries only go away when their own
// user sends again, and without this a process serving many mailboxes would
// hold one dead key per webhook forever. Cheap because it only runs when a
// send was actually attempted.
function pruneTestSendBudget() {
    const cutoff = Date.now() - TEST_SEND_WINDOW_MS;
    for (const [key, used] of testSendBudget) {
        const live = used.filter((t) => t >= cutoff);
        if (live.length) testSendBudget.set(key, live);
        else testSendBudget.delete(key);
    }
}

const webhookPublic = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        url: { type: 'string' },
        keep: { type: 'boolean', description: 'Keep the message in the mailbox after a successful delivery.' },
        prepend: { type: 'string', description: 'Free text placed above the quoted original in the forwarded body.' },
        // Names only, sorted; stored values are credentials and are
        // write-only — they never come back over the API.
        headerNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names of the custom request headers set on this webhook. Values are write-only.'
        },
        createdAt: { type: ['integer', 'null'] },
        lastUsedAt: { type: ['integer', 'null'] }
    }
};

// Shared request-body field for POST and PATCH. The finer rules (reserved
// names, the signature header names, control characters) live in
// sanitizeWebhookHeaders and map to 400 in the handler — JSON Schema can
// only express the shape, not the blocklist.
const headersBodyProp = {
    type: 'object',
    maxProperties: 16,
    additionalProperties: { type: 'string', maxLength: 1024 },
    description: 'Extra HTTP headers sent with every delivery, e.g. {"Authorization":"Bearer …"}'
};

// Runs the real validation and turns sanitize failures into a 400. PATCH
// semantics are handled by the store: undefined = unchanged, {} = clear.
function sanitizeOr400(input) {
    const res = sanitizeWebhookHeaders(input);
    if (!res.ok) throw badRequest(res.error);
    return res.headers;
}


module.exports = async function outboundWebhookRoutes(app, {
    store,
    sieveManager,
    // Reuse the delivery worker's HTTP timeout so a test send fails exactly
    // when a real delivery would.
    timeoutMs: testSendTimeoutMs = 15_000,
    // Seams for the route tests only — server.js passes neither. Kept as
    // options (not module-level monkey-patching) so a test can never leave
    // the SSRF check disabled for the rest of the process.
    requestImpl,
    // Defaults to the REAL guard, imported above. Naming the default
    // `defaultAssertPublicDestination` here referenced a binding that does
    // not exist in this module, so the default parameter threw a
    // ReferenceError the moment the route registered without an injected
    // seam — taking the whole file's tests with it.
    assertPublicDestination = assertPublicDestinationImpl
} = {}) {
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


    // POST a synthetic payload to an existing webhook and report what the
    // receiver actually said. The user-facing half of "it works, but I can't
    // tell whether it's my URL, my auth header or my signature".
    //
    // Three things it deliberately does NOT do, because each would either
    // break a guarantee or leak a credential:
    //  - touch the delivery queue or the hidden mailbox, so no real message
    //    is consumed and no delivery state is invented;
    //  - return the signing secret or the stored header values, so the
    //    write-only contract that makes a leaked secret meaningful still
    //    holds — the browser learns only what the receiver replied;
    //  - take its own HTTP path. It calls the same deliverOutbound the
    //    forwarder calls, with the same stored secret, so a green result
    //    here means a real delivery would also arrive signed and authorised.
    app.post('/v1/me/outbound-webhooks/:id/test', {
        schema: {
            tags: ['webhooks'],
            summary: 'Send a test delivery to an outbound webhook',
            description:
                'POSTs a synthetic payload through the real delivery path and returns the ' +
                "receiver's status and a bounded excerpt of its reply. No message is read " +
                'or consumed, and no credential is returned.',
            params: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean', description: 'True when the receiver answered 2xx.' },
                        status: { type: 'integer', description: "The receiver's HTTP status." },
                        elapsedMs: { type: 'integer' },
                        reply: { type: 'string', description: 'First 300 characters of the reply body.' },
                        truncated: { type: 'boolean' },
                        sentAt: { type: 'string' }
                    }
                },
                404: problemSchema,
                429: problemSchema,
                502: problemSchema
            }
        }
    }, async (req, reply) => {
        // getLive is scoped by user, so another mailbox's webhook id is a
        // 404 here, not an outbound POST using someone else's credentials.
        const webhook = store.getLive({ id: req.params.id, user: req.creds.user });
        if (!webhook) throw notFound('No such outbound webhook');

        const budget = claimTestSend(req.creds.user, req.params.id);
        if (!budget.allowed) {
            // The receiver is a third party and this is abuse-shaped, so the
            // count stays in the log and the response explains itself.
            req.log.warn(
                { user: req.creds.user, id: req.params.id },
                'outbound webhook test send throttled'
            );
            reply.header('retry-after', String(budget.retryAfter));
            throw problem(
                429,
                'Too Many Requests',
                `Test sends to this webhook are limited to ${TEST_SEND_LIMIT} per minute — ` +
                'a real delivery is not affected. Try again shortly.'
            );
        }
        pruneTestSendBudget();

        req.log.info({ id: webhook.id, url: webhook.url }, 'outbound webhook test send');
        const sentAt = new Date().toISOString();
        // The stored URL was vetted at creation, but so was the DNS behind
        // it, at that moment — and a test send is a POST to it on demand.
        // deliverOutbound re-resolves and pins on every call, which is the
        // check that matters; this only turns a refusal into a 400 with a
        // readable reason instead of a bare connection error.
        try {
            await assertPublicDestination(webhook.url, { schemes: ['https:'] });
        } catch (err) {
            throw badRequest(`Webhook URL is not allowed: ${err.message}`);
        }

        let outcome;
        try {
            outcome = await deliverOutbound({
                webhook,
                payload: buildTestPayload(webhook, Date.now),
                secret: webhook.secret,
                timeoutMs: testSendTimeoutMs,
                requestImpl
            });
        } catch (err) {
            if (err.permanent === true) {
                const reason = err.message.replace(/^Webhook URL is not allowed: /, '');
                throw badRequest(`Webhook URL is not allowed: ${reason}`);
            }
            // No status means we never reached the receiver at all. 502 is
            // the honest answer — this is our request failing, not theirs.
            throw problem(502, 'Bad Gateway', `Test delivery failed before any reply: ${err.message}`);
        }

        req.log.info(
            { id: webhook.id, status: outcome.status, ms: outcome.elapsedMs },
            'outbound webhook test send delivered'
        );
        return {
            ok: outcome.ok,
            status: outcome.status,
            elapsedMs: outcome.elapsedMs,
            reply: outcome.reply,
            // Lets the UI say "reply truncated" rather than implying a short
            // receiver response was the whole story.
            truncated: outcome.replyTruncated === true,
            sentAt
        };
    });

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
