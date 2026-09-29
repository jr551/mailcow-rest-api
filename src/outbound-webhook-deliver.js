'use strict';

const crypto = require('node:crypto');
const { request } = require('undici');
const { createPinnedDispatcher } = require('./utils/ssrf-guard');

// The POST half of an outbound webhook delivery, shared by the real
// forwarder and the test-send route.
//
// It was a closure inside createOutboundWebhookForwarder, which meant the
// only way to prove "the test send behaves like a delivery" was to read the
// forwarder and trust that the two stayed in step. There is exactly one
// framing on the wire — signature scheme, header merging order, JSON body,
// pinned connection, 300-char reply cap — and a receiver that validates one
// must validate the other. A test send that took a shortcut (say, an
// unsigned request) would report success for a receiver that rejects every
// real delivery, which is worse than no test send at all.
//
// So the shape is the contract: both callers hand in the SAME delivery-shaped
// webhook (see outbound-webhook-store.getLive) and get back the SAME outcome
// shape, and neither can differ without editing this file.

// How much of the receiver's reply body to keep. Matches what the forwarder
// has always captured; the response we hand back to the browser is small,
// and a hostile or broken endpoint could stream an unbounded body.
const REPLY_CAP = 300;

function sign(secret, signedContent) {
    return crypto.createHmac('sha256', secret).update(signedContent).digest('hex');
}

// The exact header set a delivery carries.
//
// Order matters and is part of the contract: user-supplied headers merge
// AFTER our defaults and BEFORE the signature block, so the reserved names
// were already rejected at creation and nothing here can clobber the
// signature or the framing. `now` is injected rather than read from the clock
// so the timestamp (and therefore the signature) is deterministic in tests.
function deliveryHeaders(webhook, payload, { secret, now }) {
    const body = JSON.stringify(payload);
    const headers = {
        'content-type': 'application/json',
        'user-agent': 'mailcow-rest-api/outbound-webhook',
        ...(webhook.headers || {})
    };
    if (secret) {
        // Timestamp inside the signed content so a captured request cannot be
        // replayed forever — the receiver can reject anything outside its
        // tolerance window. Only the V2 header is sent: emitting a body-only
        // signature alongside it would hand an attacker the replay back,
        // since stripping the V2 headers would still validate.
        const timestamp = String(Math.floor(now() / 1000));
        headers['x-webhook-timestamp'] = timestamp;
        headers['x-webhook-signature-v2'] = sign(secret, `${timestamp}.${body}`);
    }
    return { body, headers };
}

// POST one payload to a webhook and report what the receiver said.
//
// Never throws for a receiver-side failure — a 500 from the subscriber is a
// successful test, and the whole point is to show the user the real reply.
// It throws only for the two things the caller cannot render usefully:
// a destination the SSRF guard refuses (no request was made), and a
// transport failure (we never got an answer at all).
//
// Returns { ok, status, elapsedMs, reply, permanent? }.
async function deliverOutbound({
    webhook,
    payload,
    secret,
    now = () => Date.now(),
    timeoutMs = 15_000,
    requestImpl = request
}) {
    const { body, headers } = deliveryHeaders(webhook, payload, { secret, now });
    const started = now();
    // The URL was checked at creation, but that is not enough: the operator
    // of a public-looking hostname can flip its DNS to a private address
    // afterwards (rebinding) and every poll would POST mailbox contents to an
    // internal service. Re-resolve and pin the connection to the checked
    // address on every delivery. A test send gets the same treatment — it is
    // an unauthenticated-looking POST from our IP to a URL the user chose,
    // so the rebinding window is exactly as dangerous there.
    let dispatcher;
    if (requestImpl === request) {
        try {
            dispatcher = (await createPinnedDispatcher(webhook.url)) || undefined;
        } catch (err) {
            // Only a genuinely disallowed destination is permanent. A resolver
            // blip (EAI_AGAIN, SERVFAIL) throws here too, and treating that
            // as permanent abandoned mail after a single attempt — so
            // propagate the guard's own verdict instead of assuming.
            const blocked = new Error(`Webhook URL is not allowed: ${err.message}`);
            blocked.permanent = err.permanent === true;
            throw blocked;
        }
    }
    try {
        const res = await requestImpl(webhook.url, {
            method: 'POST',
            headers,
            body,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            dispatcher
        });
        // Cap the reply capture — a hostile or broken endpoint could stream an
        // unbounded body and buffering it all would be a memory DoS on us.
        let text = '';
        let replyTruncated = false;
        try {
            for await (const chunk of res.body) {
                if (text.length >= REPLY_CAP) { replyTruncated = true; break; }
                text += chunk.toString('utf8');
            }
            if (text.length > REPLY_CAP) { text = text.slice(0, REPLY_CAP); replyTruncated = true; }
        } catch { /* a truncated reply is still a reply */ }
        const elapsedMs = now() - started;
        return {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            elapsedMs,
            reply: text,
            // Whether the 300-char cap cut the reply, or the body ended after
            // one chunk that was already over it. The UI says so rather than
            // implying a short response was the whole story.
            replyTruncated
        };
    } finally {
        // Each delivery builds its own Agent, which owns a connection pool and
        // keep-alive timers. Without this, repeated sends accumulate one pool
        // each.
        if (dispatcher && typeof dispatcher.close === 'function') {
            await dispatcher.close().catch(() => {});
        }
    }
}

module.exports = {
    deliverOutbound,
    deliveryHeaders,
    sign
};
