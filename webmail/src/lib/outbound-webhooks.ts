// Outbound webhooks — email leaves the mailbox and POSTs to a URL you name.
//
// The inverse of the inbound "webhook inbox" feature in api.ts: there, a
// service POSTs to you and the payload becomes an email. Here, a Sieve
// `webhook` action fires when a message matches a rule and the server
// forwards the message on to the subscriber's URL.
//
// Every webhook owns a hidden IMAP mailbox named `.wh-<id>`, which is what
// the server's delivery worker watches; the UI never shows that folder, it
// just needs the `id` to build rule actions.
//
// SEPARATE MODULE ON PURPOSE: this wraps a server feature that is landing in
// parallel, so the assumed request/response field names are isolated here
// rather than smeared through Settings.svelte. If the server settles on
// different names, this file is the only thing that changes.

import { apiUrl, ApiError } from './api';
import { bearerHeader, getSession, tryRenewSession } from './auth.svelte';

/* Field names assumed of the server:
 *   GET    /v1/me/outbound-webhooks  -> { webhooks: OutboundWebhook[], limit: number }
 *   POST   /v1/me/outbound-webhooks  <- { label, url, keep, prepend } -> OutboundWebhook
 *   PATCH  /v1/me/outbound-webhooks/:id <- { label?, keep?, prepend? } -> OutboundWebhook
 *   DELETE /v1/me/outbound-webhooks/:id -> 204
 *   POST   /v1/me/outbound-webhooks/:id/test -> TestSendResult
 */
export interface OutboundWebhook {
    id: string;
    label: string;
    /** The subscriber URL. Always returned — unlike inbound tokens, this
     *  isn't a credential, it's the thing you'd paste into another service. */
    url: string;
    /** Keep the source message in the mailbox (adds `:copy` to the
     *  server's implicit fileinto). */
    keep: boolean;
    /** Free text placed above the quoted original in the forwarded body.
     *  The point of an outbound webhook is usually to hand mail to an agent
     *  that has no other context, so this is where you explain what it is
     *  looking at. Empty means the original is forwarded unquoted. */
    prepend: string;
    createdAt?: number | null;
    lastUsedAt?: number | null;
    /** Hidden IMAP folder the mail rule delivers into, `.wh-<id>`. The
     *  server derives it from the id and always returns it. It is internal
     *  plumbing the forwarder polls, not a folder the user manages. */
    mailbox: string;
    /** Custom request headers as name → masked value ('•••'). The server
     *  stores the real values encrypted and never returns them, so the map
     *  is only good for showing which headers exist. */
    headers?: Record<string, string>;
    /** Returned ONLY by POST (creation); the server never lists it again.
     *  It is what the receiver uses to verify x-webhook-signature-v2, so the
     *  UI has to show it once or the user can never verify a delivery. */
    secret?: string;
}

/** What the subscriber actually said to a test delivery. Nothing about the
 *  webhook's own credentials appears here: the server signs on its own side
 *  and reports only the receiver's answer, so a screenshot of this result is
 *  safe to share. */
export interface TestSendResult {
    /** True when the receiver answered 2xx. A 4xx/5xx is still a *successful
     *  test* — the request arrived and the receiver rejected it on its own
     *  terms, which is exactly the information the user asked for. */
    ok: boolean;
    status: number;
    elapsedMs: number;
    /** First 300 characters of the receiver's response body. */
    reply: string;
    /** True when the 300-char cap cut a longer reply. */
    truncated: boolean;
    sentAt: string;
}

export interface OutboundWebhookInput {
    label: string;
    url: string;
    keep?: boolean;
    prepend?: string;
    /** Extra headers sent with every delivery POST (e.g. Authorization).
     *  Write-only: once stored the server masks the values forever. */
    headers?: Record<string, string>;
}

async function request<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
    const headers: Record<string, string> = {};
    const s = getSession();
    if (s) headers['authorization'] = bearerHeader(s);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(apiUrl(url), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    // Same silent re-mint as api.ts: an expired token shouldn't bounce the
    // user out of a panel they opened on purpose.
    if (res.status === 401 && !retried) {
        if (await tryRenewSession()) return request<T>(method, url, body, true);
    }
    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
            const j = await res.json();
            detail = j?.detail || j?.title || j?.message || detail;
        } catch { /* not JSON */ }
        throw new ApiError({ type: 'about:blank', status: res.status, title: 'Outbound webhook request failed', detail });
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json() as Promise<T>;
    return res.text() as unknown as Promise<T>;
}

export async function listOutboundWebhooks(): Promise<{ webhooks: OutboundWebhook[]; limit: number }> {
    return request('GET', '/v1/me/outbound-webhooks');
}

export async function createOutboundWebhook(input: OutboundWebhookInput): Promise<OutboundWebhook> {
    return request('POST', '/v1/me/outbound-webhooks', {
        label: input.label,
        url: input.url,
        keep: !!input.keep,
        prepend: input.prepend ?? '',
        // Only send the field when it carries something; the server treats
        // an absent key as "no custom headers".
        ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {})
    });
}

export async function updateOutboundWebhook(
    id: string,
    patch: { label?: string; keep?: boolean; prepend?: string; headers?: Record<string, string> }
): Promise<OutboundWebhook> {
    return request('PATCH', `/v1/me/outbound-webhooks/${encodeURIComponent(id)}`, patch);
}

export async function deleteOutboundWebhook(id: string): Promise<void> {
    return request('DELETE', `/v1/me/outbound-webhooks/${encodeURIComponent(id)}`);
}


/**
 * Ask the server to POST a synthetic payload to this webhook and report the
 * receiver's reply. The server runs the same delivery code the background
 * worker does, so this verifies the URL, the custom headers and the signature
 * in one go — without sending any real mail and without the browser ever
 * seeing the signing secret.
 *
 * A non-2xx from the receiver resolves normally with `ok: false`; only a
 * failure to reach the receiver at all rejects (ApiError, status 502).
 */
export async function testOutboundWebhook(id: string): Promise<TestSendResult> {
    return request('POST', `/v1/me/outbound-webhooks/${encodeURIComponent(id)}/test`);
}
/** True when the server doesn't expose the feature at all, so the panel can
 *  stay hidden instead of showing a permanent error. */
export function isOutboundWebhooksUnavailable(err: unknown): boolean {
    return err instanceof ApiError && (err.status === 404 || err.status === 501);
}
