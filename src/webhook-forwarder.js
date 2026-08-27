'use strict';

const crypto = require('node:crypto');
const { ImapFlow } = require('imapflow');
const { request } = require('undici');
const { walkStructure, downloadPartText, streamToBuffer, parseAuthResultsHeader } = require('./imap');

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

function headersFromSource(sourceBuf) {
    // Unfold and parse RFC822 headers from the raw source. Lower-cased keys; duplicates -> array.
    const str = sourceBuf.toString('utf8');
    const end = str.search(/\r?\n\r?\n/);
    const head = end === -1 ? str : str.slice(0, end);
    const lines = head.split(/\r?\n/);
    const out = {};
    let curKey = null;
    let curVal = '';
    const push = () => {
        if (!curKey) return;
        const k = curKey.toLowerCase();
        const v = curVal.trim();
        if (out[k] === undefined) out[k] = v;
        else if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
    };
    for (const line of lines) {
        if (/^\s/.test(line) && curKey) curVal += ' ' + line.trim();
        else {
            push();
            const m = line.match(/^([^:]+):\s*(.*)$/);
            if (m) { curKey = m[1]; curVal = m[2]; } else { curKey = null; curVal = ''; }
        }
    }
    push();
    return out;
}

function htmlToText(html) {
    if (!html) return null;
    // Minimal HTML -> text for LLM extraction: strip tags, decode entities, collapse space.
    let t = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<[^>]+>/g, ' ');
    t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
    t = t.replace(/\s+/g, ' ').trim();
    return t.length ? t : null;
}

function addressList(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((a) => ({ name: a?.name || null, address: a?.address || null }))
        .filter((a) => a.address || a.name);
}

// `connectOverride` exists so tests can drive the whole delivery/delete
// path without a live IMAP server. Production never passes it.
function createWebhookForwarder({ config, store, logger, connect: connectOverride }) {
    const accounts = config.webhooks.accounts || [];
    const pollIntervalMs = config.webhooks.pollIntervalMs;
    const maxAttempts = config.webhooks.maxAttempts;
    const maxBytes = config.webhooks.maxMessageBytes;
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
            headers['x-webhook-timestamp'] = timestamp;
            headers['x-webhook-signature-v2'] = sign(account.secret, `${timestamp}.${body}`);
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
        const truncated = source.length > maxBytes;
        const env = msg.envelope || {};

        // Decode the body rather than shipping only base64.
        //
        // The receiver is usually a model or a script, and neither can do
        // anything useful with a base64 blob: an LLM can't reliably decode
        // it, and it inflates the payload by a third — a 100 KB mail became
        // 133 KB of unreadable characters in the prompt. The raw source is
        // still included for anything that wants to parse MIME itself, but
        // text and html are now there to be read directly.
        const acc = { textPart: null, htmlPart: null, attachments: [] };
        if (msg.bodyStructure) walkStructure(msg.bodyStructure, msg.bodyStructure.part || '1', acc);
        let text = null;
        let html = null;
        try {
            if (acc.textPart) text = await downloadPartText(client, String(uid), acc.textPart);
            if (acc.htmlPart) html = await downloadPartText(client, String(uid), acc.htmlPart);
        } catch (err) {
            logger?.warn({ err: err.message, uid }, 'webhook body extraction failed; sending raw only');
        }
        // HTML-only mails (Tesco receipts) would otherwise leave text=null and force the LLM to parse raw HTML.
        // Provide a stripped text fallback so the agent can extract line items without decoding base64 raw.
        if (!text && html) {
            const stripped = htmlToText(html);
            if (stripped) text = stripped;
        }
        const headers = headersFromSource(source);
        const authHeaderRaw = headers['authentication-results'] ? (Array.isArray(headers['authentication-results']) ? headers['authentication-results'][0] : headers['authentication-results']) : null;
        const auth = parseAuthResultsHeader(authHeaderRaw);

        // Attachment bytes, not just a manifest.
        //
        // A receiver told an invoice exists but not given it can't do
        // anything with it — and digging the part back out of the base64
        // raw source means reimplementing a MIME parser at the other end,
        // which is the work this payload exists to avoid.
        //
        // Bounded per attachment and in total: a mailbox is allowed 25 MB
        // attachments, and base64 adds a third on top, so an unbounded
        // payload could be ~33 MB of JSON per message. Anything over the
        // cap is described and flagged rather than silently dropped, so
        // the receiver knows something was there.
        const attachments = [];
        let attachmentBudget = maxAttachmentsTotalBytes;
        for (const att of acc.attachments) {
            const meta = { ...att, included: false, content: null, encoding: 'base64' };
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
                meta.included = true;
                meta.bytes = buf.length;
                meta.content = buf.toString('base64');
                attachments.push(meta);
            } catch (err) {
                meta.omittedReason = `fetch failed: ${err.message}`;
                attachments.push(meta);
                logger?.warn({ err: err.message, uid, part: att.id }, 'webhook attachment fetch failed');
            }
        }

        return {
            account: account.address,
            mailbox: account.mailbox,
            uid,
            uidvalidity,
            internalDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
            size: msg.size ?? source.length,
            flags: msg.flags ? [...msg.flags] : [],
            envelope: {
                messageId: env.messageId || null,
                inReplyTo: env.inReplyTo || null,
                date: env.date ? new Date(env.date).toISOString() : null,
                subject: env.subject || null,
                from: addressList(env.from),
                sender: addressList(env.sender),
                replyTo: addressList(env.replyTo),
                to: addressList(env.to),
                cc: addressList(env.cc),
                bcc: addressList(env.bcc)
            },
            // Decoded bodies — what a downstream model or script actually
            // reads. Null when the message has no part of that type.
            text,
            html,
            headers,
            authenticationResults: authHeaderRaw,
            auth,
            attachments,
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

    async function tick() {
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
    }

    return { start, stop, tick, enabled };
}

module.exports = { createWebhookForwarder, backoffFor };
