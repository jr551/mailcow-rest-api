'use strict';

// Only used as the default when no requestOverride is injected: the shared
// delivery module compares against this exact reference to decide whether to
// skip SSRF pinning, so it must be this binding, not a local re-require.
const { request } = require('undici');
// `connect()` opens its own ImapFlow rather than borrowing from the shared
// pool: each webhook authenticates as its own mailbox, and the pool is keyed
// by credential hash, so there is nothing to borrow. This import was missing
// entirely, so every connect threw `ReferenceError: ImapFlow is not defined`
// and the forwarder retried forever without ever delivering a message. The
// delivery tests inject a fake IMAP, which is why the suite stayed green.
const { ImapFlow } = require('imapflow');
const { walkStructure, downloadPartText, streamToBuffer } = require('./imap');
const {
    headersFromSource,
    htmlToText,
    addressList,
    composeForwardedText,
    encodeAttachment,
    ATTACHMENT_SCHEME_INSTRUCTIONS
} = require('./webhook-payload');
const { headerSafe, formatPhrase } = require('./utils/rfc822');
const { backoffFor } = require('./webhook-forwarder');
const { deliverOutbound } = require('./outbound-webhook-deliver');

// Per-user outbound webhooks: mail that matched a rule is POSTed to a URL the
// user named.
//
// The rule cannot do this itself — Sieve has no HTTP action — so it files
// the message into a hidden mailbox (`.wh-<id>`) and this worker polls it.
// That is why the mailbox exists at all, and why the delivery state is keyed
// by (user, uidvalidity, uid): the message is a real IMAP message sitting in a
// real folder, so it can be re-seen after a restart.
//
// Ordering is deliberate and matches webhook-forwarder.js: POST first, and
// only act on the message once the POST is confirmed. A failed delivery leaves
// the message where it is and schedules a retry, so an endpoint that is down
// for an hour loses nothing. A confirmed delivery that then fails to be
// filed/deleted is recorded as delivered so the next poll retries only the
// mailbox action and never re-POSTs — a duplicate POST is a duplicate ticket
// on the receiver.

const SENT_FOLDER = 'Sent';

// imapflow hands back the raw header text when it cannot parse a Date, and
// `new Date(<garbage>).toISOString()` throws RangeError. That throw happens
// while building the payload — before the POST — so it would abort delivery
// and strand the message for a reason the operator cannot see.
function toIsoOrNull(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function createOutboundWebhookForwarder({
    config,
    store,
    queue,
    logger,
    connect: connectOverride,
    request: requestOverride,
    now = () => Date.now()
}) {
    const pollIntervalMs = config.outboundWebhooks.pollIntervalMs;
    const timeoutMs = config.outboundWebhooks.timeoutMs;
    const maxAttempts = config.outboundWebhooks.maxAttempts;
    const maxBytes = config.outboundWebhooks.maxMessageBytes;
    const includeAttachments = config.outboundWebhooks.includeAttachments;
    const maxAttachmentBytes = config.outboundWebhooks.maxAttachmentBytes;
    const maxAttachmentsTotalBytes = config.outboundWebhooks.maxAttachmentsTotalBytes;

    let timer = null;
    let running = false;
    let stopped = false;

    async function connect(webhook) {
        if (connectOverride) return connectOverride(webhook);
        const client = new ImapFlow({
            host: config.imap.host,
            port: config.imap.port,
            secure: config.imap.secure,
            auth: { user: webhook.user, pass: webhook.password },
            tls: {
                rejectUnauthorized: config.imap.rejectUnauthorized,
                ...(config.imap.tlsServername ? { servername: config.imap.tlsServername } : {})
            },
            logger: false,
            emitLogs: false,
            connectTimeout: config.imap.connectTimeoutMs
        });
        // Without a listener, imapflow's error events become uncaught
        // exceptions on the process.
        client.on('error', () => {});
        await client.connect();
        return client;
    }

    // Every real delivery goes through the shared module so a test send is
    // the same POST by construction — signature scheme, header merge order,
    // pinned connection, reply cap. `requestOverride` exists so tests can
    // drive the whole delivery path without a live endpoint; production never
    // passes it, and the shared module skips SSRF pinning only when it is
    // driven that way.
    async function deliver(webhook, payload) {
        const outcome = await deliverOutbound({
            webhook,
            payload,
            secret: webhook.secret,
            now,
            timeoutMs,
            requestImpl: requestOverride || request
        });
        if (!outcome.ok) {
            const err = new Error(`Webhook returned ${outcome.status}: ${outcome.reply}`);
            err.statusCode = outcome.status;
            err.elapsedMs = outcome.elapsedMs;
            throw err;
        }
        return outcome;
    }

    async function buildPayload(client, webhook, uid, uidvalidity) {
        const msg = await client.fetchOne(String(uid), {
            uid: true,
            envelope: true,
            internalDate: true,
            size: true,
            flags: true,
            bodyStructure: true,
            source: true
        }, { uid: true });
        if (!msg) return null;

        const source = msg.source ? Buffer.from(msg.source) : Buffer.alloc(0);
        const truncated = source.length > maxBytes;
        const env = msg.envelope || {};

        const acc = { textPart: null, htmlPart: null, attachments: [] };
        if (msg.bodyStructure) walkStructure(msg.bodyStructure, msg.bodyStructure.part || '1', acc);
        let text = null;
        let html = null;
        try {
            if (acc.textPart) text = await downloadPartText(client, String(uid), acc.textPart);
            if (acc.htmlPart) html = await downloadPartText(client, String(uid), acc.htmlPart);
        } catch (err) {
            logger?.warn({ err: err.message, uid }, 'outbound webhook body extraction failed; sending raw only');
        }
        // HTML-only mail would otherwise leave text=null and force the
        // receiver to parse raw HTML to find anything readable.
        if (!text && html) {
            const stripped = htmlToText(html);
            if (stripped) text = stripped;
        }

        const headers = headersFromSource(source);

        const attachments = [];
        let attachmentBudget = maxAttachmentsTotalBytes;
        for (const att of acc.attachments) {
            const meta = { ...att, included: false, content: null, encoding: 'base64+gzip' };
            if (!includeAttachments) {
                meta.omittedReason = 'attachments disabled';
                attachments.push(meta);
                continue;
            }
            const declared = Number(att.size) || 0;
            if (declared > maxAttachmentBytes) {
                meta.omittedReason = `larger than the ${Math.round(maxAttachmentBytes / 1024 / 1024)} MB per-attachment limit`;
                attachments.push(meta);
                continue;
            }
            try {
                const dl = await client.download(String(uid), att.id, { uid: true });
                if (!dl || !dl.content) {
                    meta.omittedReason = 'part could not be fetched';
                    attachments.push(meta);
                    continue;
                }
                const buf = await streamToBuffer(dl.content);
                if (buf.length > maxAttachmentBytes || buf.length > attachmentBudget) {
                    meta.omittedReason = buf.length > maxAttachmentBytes
                        ? `larger than the ${Math.round(maxAttachmentBytes / 1024 / 1024)} MB per-attachment limit`
                        : 'total attachment budget for this message exhausted';
                    attachments.push(meta);
                    continue;
                }
                attachmentBudget -= buf.length;
                const encoded = encodeAttachment(buf);
                meta.included = true;
                meta.bytes = buf.length;
                meta.content = encoded.content;
                meta.encoding = encoded.encoding;
                meta.compressedBytes = encoded.compressedBytes;
                meta.instructions = encoded.instructions;
                attachments.push(meta);
            } catch (err) {
                meta.omittedReason = `fetch failed: ${err.message}`;
                attachments.push(meta);
                logger?.warn({ err: err.message, uid, part: att.id }, 'outbound webhook attachment fetch failed');
            }
        }

        return {
            webhook: { id: webhook.id, label: webhook.label },
            mailbox: webhook.mailbox,
            uid,
            uidvalidity,
            internalDate: toIsoOrNull(msg.internalDate),
            size: msg.size ?? source.length,
            flags: msg.flags ? [...msg.flags] : [],
            envelope: {
                messageId: env.messageId || null,
                inReplyTo: env.inReplyTo || null,
                date: toIsoOrNull(env.date),
                subject: env.subject || null,
                from: addressList(env.from),
                sender: addressList(env.sender),
                replyTo: addressList(env.replyTo),
                to: addressList(env.to),
                cc: addressList(env.cc),
                bcc: addressList(env.bcc)
            },
            // The user's preamble followed by the original quoted underneath.
            // This is what a receiver with no other context should read.
            message: composeForwardedText({ prepend: webhook.prepend, text }),
            // The original, untouched — a receiver that wants to parse the
            // mail itself must not have to strip our quote markers back out.
            text,
            html,
            headers,
            attachments,
            attachmentInstructions: ATTACHMENT_SCHEME_INSTRUCTIONS,
            // Full RFC822 source, base64'd, for receivers that would rather
            // parse MIME themselves than trust our extraction.
            raw: {
                encoding: 'base64',
                truncated,
                bytes: source.length,
                data: (truncated ? source.subarray(0, maxBytes) : source).toString('base64')
            }
        };
    }

    // The user-facing record of what happened, appended to Sent so it syncs to
    // every device and is searchable in the normal UI rather than living only
    // in this app.
    function buildSentRecord(webhook, payload, outcome) {
        const domain = webhook.user.includes('@') ? webhook.user.split('@')[1] : 'localhost';
        const subject = payload.envelope.subject || '(no subject)';
        const from = payload.envelope.from?.[0]?.address || 'unknown sender';
        const reply = outcome.ok
            ? `HTTP ${outcome.status}`
            : (outcome.status ? `HTTP ${outcome.status}` : 'network error');
        const seconds = (outcome.elapsedMs / 1000).toFixed(1);
        const statusLine = `Sent to webhook ${webhook.label} — reply was ${reply} in ${seconds} seconds`;
        const lines = [
            `From: ${formatPhrase('Webhook delivery')} <webhook-${webhook.id}@${domain}>`,
            `To: <${webhook.user}>`,
            `Subject: ${headerSafe(statusLine, 'Webhook delivery')}`,
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: <owh-${webhook.id}-${now()}@${domain}>`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: 8bit',
            'Auto-Submitted: auto-generated',
            `X-Outbound-Webhook: ${webhook.id}`,
            '',
            statusLine,
            '',
            `Original message: ${subject}`,
            `From: ${from}`,
            `Webhook URL: ${webhook.url}`,
            webhook.prepend ? `\nPreamble sent to the webhook:\n${webhook.prepend}` : '',
            outcome.ok ? '' : `\nError: ${outcome.error || 'unknown'}`
        ];
        return Buffer.from(lines.join('\r\n'), 'utf8');
    }

    async function appendSentRecord(client, webhook, payload, outcome) {
        try {
            await client.append(SENT_FOLDER, buildSentRecord(webhook, payload, outcome), ['\\Seen']);
        } catch (err) {
            // The delivery already happened; failing to write the receipt must
            // not turn a successful delivery into a retry.
            logger?.warn({ err: err.message, id: webhook.id }, 'outbound webhook Sent record failed');
        }
    }

    async function processWebhook(webhook) {
        let client;
        try {
            client = await connect(webhook);
        } catch (err) {
            logger?.warn({ err: err.message, id: webhook.id }, 'outbound webhook IMAP connect failed');
            return;
        }

        try {
            // The hidden folder is created by the Sieve `fileinto` on first
            // delivery, so it may not exist yet — that is not an error.
            let lock;
            try {
                lock = await client.getMailboxLock(webhook.mailbox);
            } catch {
                return;
            }
            try {
                const uidvalidity = Number(client.mailbox?.uidValidity ?? 0);
                if (!client.mailbox?.exists) return;

                const uids = await client.search({ all: true }, { uid: true });
                const current = now();

                for (const uid of uids || []) {
                    if (stopped) return;
                    const state = queue.get(webhook.user, uidvalidity, uid);
                    if (state?.giving_up) continue;

                    // Already delivered on a previous poll but the mailbox
                    // action failed — retry ONLY that, never the POST.
                    if (state?.delivered) {
                        await finishMessage(client, webhook, uid, uidvalidity);
                        continue;
                    }
                    if (state && state.next_attempt_at > current) continue;

                    const attempts = (state?.attempts || 0) + 1;
                    let payload = null;
                    let outcome = null;
                    try {
                        payload = await buildPayload(client, webhook, uid, uidvalidity);
                        if (!payload) {
                            // Vanished between search and fetch (another
                            // client moved or deleted it) — nothing to do.
                            queue.clear(webhook.user, uidvalidity, uid);
                            continue;
                        }
                        outcome = await deliver(webhook, payload);
                    } catch (err) {
                        const givingUp = attempts >= maxAttempts || err.permanent === true;
                        queue.recordFailure(webhook.user, uidvalidity, uid, {
                            attempts,
                            nextAttemptAt: current + backoffFor(attempts),
                            error: err.message,
                            givingUp
                        });
                        logger?.[givingUp ? 'error' : 'warn'](
                            { err: err.message, id: webhook.id, uid, attempts, givingUp },
                            givingUp
                                ? 'outbound webhook delivery failed permanently; message left in mailbox'
                                : 'outbound webhook delivery failed; will retry'
                        );
                        // A failed attempt is still worth a receipt: the user
                        // asked to be told what the webhook said back.
                        if (payload) {
                            await appendSentRecord(client, webhook, payload, {
                                ok: false,
                                status: err.statusCode || null,
                                elapsedMs: err.elapsedMs ?? 0,
                                error: err.message
                            });
                        }
                        continue;
                    }

                    // Mark delivered BEFORE anything else. The queue row is
                    // durable while the Sent append and mailbox action are
                    // not — a restart in that gap would otherwise re-POST an
                    // already-delivered message on the next poll.
                    queue.recordDelivered(webhook.user, uidvalidity, uid);
                    await appendSentRecord(client, webhook, payload, outcome);
                    store.touch(webhook.id, current);
                    logger?.info(
                        { id: webhook.id, uid, attempts, status: outcome.status, ms: outcome.elapsedMs },
                        'outbound webhook delivered'
                    );
                    await finishMessage(client, webhook, uid, uidvalidity);
                }
            } finally {
                lock.release();
            }
        } catch (err) {
            logger?.warn({ err: err.message, id: webhook.id }, 'outbound webhook poll failed');
        } finally {
            try { await client.logout(); } catch { try { client.close(); } catch { /* */ } }
        }
    }

    // Act on a delivered message: keep it (back to INBOX) or discard it.
    //
    // Separate from the POST on purpose. If the connection drops between a
    // confirmed POST and this, we record it as delivered so the next poll
    // retries only this step — re-POSTing an already-delivered message would
    // duplicate it on the receiver.
    async function finishMessage(client, webhook, uid, uidvalidity) {
        try {
            if (webhook.keep) {
                await client.messageMove(String(uid), 'INBOX', { uid: true });
            } else {
                await client.messageDelete(String(uid), { uid: true });
            }
            queue.clear(webhook.user, uidvalidity, uid);
        } catch (err) {
            queue.recordDelivered(webhook.user, uidvalidity, uid);
            logger?.warn(
                { err: err.message, id: webhook.id, uid },
                'outbound webhook delivered but mailbox action failed; will retry that only'
            );
        }
    }

    async function tick() {
        if (running || stopped) return;
        running = true;
        try {
            const webhooks = store.listAllLive();
            const pollable = webhooks.filter((webhook) => {
                // A webhook whose password could not be decrypted (key
                // rotated, or the user changed their password and the refresh
                // never ran) cannot be polled — skip it rather than throwing
                // an auth error on every tick.
                if (!webhook.password) {
                    logger?.warn({ id: webhook.id }, 'outbound webhook has no usable credential; skipping');
                    return false;
                }
                return true;
            });
            // Process a few at a time. Sequentially, one user with ten
            // black-holed endpoints could spend the whole interval in
            // connect timeouts and every other user's parked mail would wait
            // for the next tick. Each webhook has its own IMAP connection, so
            // overlapping them is safe.
            const POLL_CONCURRENCY = 4;
            for (let i = 0; i < pollable.length; i += POLL_CONCURRENCY) {
                if (stopped) break;
                await Promise.all(
                    pollable.slice(i, i + POLL_CONCURRENCY).map((webhook) => processWebhook(webhook))
                );
            }
        } catch (err) {
            // setInterval doesn't await us: an escaping rejection would be an
            // unhandled rejection, and a failed poll must not take the
            // process down.
            logger?.error({ err }, 'outbound webhook poll failed');
        } finally {
            running = false;
        }
    }

    function start() {
        if (timer) return;
        logger?.info({ pollIntervalMs }, 'outbound webhook forwarder enabled');
        void tick();
        timer = setInterval(() => { void tick(); }, pollIntervalMs);
        if (timer.unref) timer.unref();
    }

    function stop() {
        stopped = true;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    return { start, stop, tick, processWebhook, buildPayload, buildSentRecord };
}

module.exports = {
    createOutboundWebhookForwarder
};
