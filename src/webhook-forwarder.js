'use strict';

const crypto = require('node:crypto');
const { ImapFlow } = require('imapflow');
const { request } = require('undici');
const { walkStructure, downloadPartText, streamToBuffer, parseAuthResultsHeader } = require('./imap');
const { headersFromSource, htmlToText, addressList } = require('./webhook-payload');
const { createWebhookStager } = require('./webhook-staging');
const { setHeader } = require('./utils/webhook-headers');

// Webhook conversion accounts.
//
// An operator lists mailboxes in WEBHOOK_ACCOUNTS (see config.js). Every
// message that lands in one is POSTed to that account's webhook URL and
// then deleted from the mailbox — turning a mailbox into a transport for
// some downstream system (ticketing, parsing, automation).
//
// The ordering matters and is deliberate: we only delete after the webhook
// has confirmed receipt with a 2xx. A failed delivery leaves the message
// in place and schedules a retry with exponential backoff, so a webhook
// that is down for an hour loses nothing. Attempt state is persisted
// (webhook-store) so restarts don't reset the backoff or re-POST
// immediately.

// 1m, 5m, 15m, 1h, 3h, 6h, 12h, then daily. Chosen so a brief outage
// recovers in minutes while a long one doesn't hammer a dead endpoint.
const BACKOFF_MS = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    60 * 60_000,
    3 * 60 * 60_000,
    6 * 60 * 60_000,
    12 * 60 * 60_000
];
const DAILY_MS = 24 * 60 * 60_000;

function backoffFor(attempts) {
    return attempts <= BACKOFF_MS.length ? BACKOFF_MS[attempts - 1] : DAILY_MS;
}

// imapflow hands back the raw header text when it cannot parse a Date, and
// `new Date(<garbage>).toISOString()` throws RangeError. That throw happens
// while building the payload — before the POST — so it would abort delivery
// and retry the message into giving_up for a reason neither the receiver nor
// the operator can see. Degrade to null instead, like the outbound forwarder.
function toIsoOrNull(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// `connectOverride` exists so tests can drive the whole delivery/delete
// path without a live IMAP server. Production never passes it.
function createWebhookForwarder({ config, store, logger, connect: connectOverride, stager: stagerOverride }) {
    const stager = stagerOverride || createWebhookStager({ config, logger });
    const accounts = config.webhooks.accounts || [];
    const pollIntervalMs = config.webhooks.pollIntervalMs;
    const maxAttempts = config.webhooks.maxAttempts;
    const maxBytes = config.webhooks.maxMessageBytes;
    const maxPayloadBytes = config.webhooks.maxPayloadBytes || 240 * 1024;
    const includeAttachments = config.webhooks.includeAttachments;
    const maxAttachmentBytes = config.webhooks.maxAttachmentBytes;
    const maxAttachmentsTotalBytes = config.webhooks.maxAttachmentsTotalBytes;
    const timeoutMs = config.webhooks.timeoutMs;
    const enabled = accounts.length > 0;

    let timer = null;
    let running = false;
    let stopped = false;

    async function connect(account) {
        if (connectOverride) return connectOverride(account);
        const client = new ImapFlow({
            host: config.imap.host,
            port: config.imap.port,
            secure: config.imap.secure,
            auth: { user: account.address, pass: account.password },
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

    function sign(secret, signedContent) {
        return crypto.createHmac('sha256', secret).update(signedContent).digest('hex');
    }

    async function deliver(account, payload) {
        const body = JSON.stringify(payload);
        const headers = {
            'content-type': 'application/json',
            'user-agent': 'mailcow-rest-api/webhook-forwarder'
        };
        // Operator-configured extra headers (Authorization etc.) merge
        // after our defaults — so Content-Type/User-Agent can be
        // overridden — and before the signature block; reserved names were
        // rejected when WEBHOOK_ACCOUNTS was parsed. setHeader replaces
        // case-insensitively so a custom `Content-Type` cannot duplicate
        // the default.
        for (const [name, value] of Object.entries(account.headers || {})) {
            setHeader(headers, name, value);
        }
        if (account.secret) {
            // Lets the receiver verify the POST really came from us. Signed
            // over the exact bytes we send, so the receiver must verify
            // against the raw body, not a re-serialized object.
            //
            // The timestamp is inside the signed content, which is the whole
            // point of this scheme over a body-only signature: a captured
            // request replays forever if the signature only covers the body,
            // whereas here the receiver can reject anything whose timestamp
            // has fallen outside its tolerance window. We deliberately send
            // *only* this header — emitting a legacy body-only signature
            // alongside it would hand an attacker the replay back, since
            // stripping the two V2 headers leaves a request that still
            // validates.
            const timestamp = String(Math.floor(Date.now() / 1000));
            setHeader(headers, 'x-webhook-timestamp', timestamp);
            setHeader(headers, 'x-webhook-signature-v2', sign(account.secret, `${timestamp}.${body}`));
        }
        const res = await request(account.url, {
            method: 'POST',
            headers,
            body,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs
        });
        // Drain regardless of status so the socket can be reused.
        let text = '';
        try { text = (await res.body.text()).slice(0, 300); } catch { /* */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`Webhook returned ${res.statusCode}: ${text}`);
            err.statusCode = res.statusCode;
            throw err;
        }
    }

    function safeName(value) {
        return String(value || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'attachment';
    }

    async function buildPayload(client, account, uid, uidvalidity) {
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
        const env = msg.envelope || {};

        const acc = { textPart: null, htmlPart: null, attachments: [] };
        if (msg.bodyStructure) walkStructure(msg.bodyStructure, msg.bodyStructure.part || '1', acc);
        let text = null;
        let html = null;
        try {
            if (acc.textPart) text = await downloadPartText(client, String(uid), acc.textPart);
            if (acc.htmlPart) html = await downloadPartText(client, String(uid), acc.htmlPart);
        } catch (err) {
            logger?.warn({ err: err.message, uid }, 'webhook body extraction failed; link still has full message');
        }
        if (!text && html) {
            const stripped = htmlToText(html);
            if (stripped) text = stripped;
        }

        const staged = await stager.stageMessage(account, uidvalidity, uid, source);

        const attachments = acc.attachments.map((att) => ({
            filename: att.filename || null,
            contentType: att.contentType || null,
            part: att.id || null,
            size: Number(att.size) || null
        }));

        let body = text || '';
        let truncated = false;
        const payload = {
            account: account.address,
            mailbox: account.mailbox,
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
            text: body,
            textTruncated: false,
            attachments,
            attachmentCount: attachments.length,
            fullEmailUrl: staged.url,
            expiresAt: staged.expiresAt,
            webhook: {
                version: 3,
                complete: true,
                note: 'fullEmailUrl is the complete RFC822 message with all attachments; the link is random and expires after one hour'
            }
        };

        const tooBig = () => Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxPayloadBytes;
        if (tooBig()) {
            // Keep the complete body readable where possible; shrink to a preview
            // and let the one-time link carry the full original.
            body = body.slice(0, 16000);
            truncated = true;
            payload.text = body;
            payload.textTruncated = true;
        }
        if (tooBig()) {
            payload.attachments = [];
            payload.attachmentCount = attachments.length;
        }
        if (tooBig()) {
            payload.text = body.slice(0, 4000);
            payload.textTruncated = true;
        }
        if (tooBig()) {
            throw new Error(`webhook payload remains over ${maxPayloadBytes} bytes after staging`);
        }
        return payload;
    }

    async function processAccount(account) {
        let client;
        try {
            client = await connect(account);
        } catch (err) {
            logger?.warn({ err: err.message, account: account.address }, 'webhook account IMAP connect failed');
            return;
        }

        try {
            const lock = await client.getMailboxLock(account.mailbox);
            try {
                const uidvalidity = Number(client.mailbox?.uidValidity ?? 0);
                if (!client.mailbox?.exists) return;

                const uids = await client.search({ all: true }, { uid: true });
                const now = Date.now();

                for (const uid of uids || []) {
                    if (stopped) return;
                    const state = store.get(account.address, uidvalidity, uid);
                    if (state?.giving_up) continue;

                    // Already delivered on a previous poll but the delete
                    // failed — retry ONLY the delete, never the POST.
                    if (state?.delivered) {
                        try {
                            await client.messageDelete(String(uid), { uid: true });
                            store.clear(account.address, uidvalidity, uid);
                            logger?.info({ account: account.address, uid }, 'webhook delete retry succeeded');
                        } catch (delErr) {
                            logger?.warn({ err: delErr.message, account: account.address, uid }, 'webhook delete retry failed');
                        }
                        continue;
                    }

                    if (state && state.next_attempt_at > now) continue;

                    const attempts = (state?.attempts || 0) + 1;
                    let delivered = false;
                    try {
                        const payload = await buildPayload(client, account, uid, uidvalidity);
                        if (!payload) {
                            // Vanished between search and fetch (another
                            // client moved or deleted it) — nothing to do.
                            store.clear(account.address, uidvalidity, uid);
                            continue;
                        }
                        await deliver(account, payload);
                        delivered = true;
                    } catch (err) {
                        const givingUp = attempts >= maxAttempts;
                        store.recordFailure(account.address, uidvalidity, uid, {
                            attempts,
                            nextAttemptAt: now + backoffFor(attempts),
                            error: err.message,
                            givingUp
                        });
                        logger?.[givingUp ? 'error' : 'warn'](
                            { err: err.message, account: account.address, uid, attempts, givingUp },
                            givingUp
                                ? 'webhook delivery failed permanently; message left in mailbox'
                                : 'webhook delivery failed; will retry'
                        );
                    }

                    // Only delete after a confirmed delivery. The delete is a
                    // SEPARATE try: if the connection drops between a
                    // confirmed POST and the delete, we must NOT reschedule —
                    // that would re-POST an already-delivered message (a
                    // duplicate ticket on the receiver). Instead record it as
                    // delivered so the next poll retries the delete alone.
                    if (!delivered) continue;
                    try {
                        await client.messageDelete(String(uid), { uid: true });
                        store.clear(account.address, uidvalidity, uid);
                        logger?.info(
                            { account: account.address, uid, attempts },
                            'webhook delivered; message deleted'
                        );
                    } catch (delErr) {
                        store.recordDelivered(account.address, uidvalidity, uid);
                        logger?.warn(
                            { err: delErr.message, account: account.address, uid },
                            'webhook delivered but delete failed; will retry delete only'
                        );
                    }
                }
            } finally {
                lock.release();
            }
        } catch (err) {
            logger?.warn({ err: err.message, account: account.address }, 'webhook account poll failed');
        } finally {
            try { await client.logout(); } catch { try { client.close(); } catch { /* */ } }
        }
    }

    // The poll currently in flight, so stop() can wait for its bookkeeping.
    // A confirmed POST must be able to write 'delivered' before the store
    // closes underneath it — losing that write re-sends the message after
    // the restart, a duplicate on the receiver.
    let inFlight = null;

    function tick() {
        const p = runTick();
        inFlight = p;
        void p.finally(() => { if (inFlight === p) inFlight = null; });
        return p;
    }

    async function runTick() {
        if (!enabled || running || stopped) return;
        running = true;
        try {
            for (const account of accounts) {
                if (stopped) break;
                await processAccount(account);
            }
        } catch (err) {
            // setInterval doesn't await us: an escaping rejection would be
            // an unhandled rejection, and a failed poll must not take the
            // process down.
            logger?.error({ err }, 'webhook forwarder poll failed');
        } finally {
            running = false;
        }
    }

    function start() {
        if (!enabled || timer) return;
        logger?.info(
            { accounts: accounts.map((a) => a.address), pollIntervalMs },
            'webhook forwarder enabled'
        );
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
        // Resolves once the in-flight poll has finished. Callers that close
        // stores (server.js onClose) MUST await this before closing them.
        return inFlight || Promise.resolve();
    }

    return { start, stop, tick, enabled };
}

module.exports = { createWebhookForwarder, backoffFor };
