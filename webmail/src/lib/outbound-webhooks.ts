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
}

export interface OutboundWebhookInput {
    label: string;
    url: string;
    keep?: boolean;
    prepend?: string;
}

async function request<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
    const headers: Record<string, string> = {};
    const s = getSession();
    if (s) Object.assign(headers, bearerHeader(s) as Record<string, string>);
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
        throw new ApiError({ status: res.status, title: 'Outbound webhook request failed', detail });
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
        prepend: input.prepend ?? ''
    });
}

export async function updateOutboundWebhook(
    id: string,
    patch: { label?: string; keep?: boolean; prepend?: string }
): Promise<OutboundWebhook> {
    return request('PATCH', `/v1/me/outbound-webhooks/${encodeURIComponent(id)}`, patch);
}

export async function deleteOutboundWebhook(id: string): Promise<void> {
    return request('DELETE', `/v1/me/outbound-webhooks/${encodeURIComponent(id)}`);
}

/** True when the server doesn't expose the feature at all, so the panel can
 *  stay hidden instead of showing a permanent error. */
export function isOutboundWebhooksUnavailable(err: unknown): boolean {
    return err instanceof ApiError && (err.status === 404 || err.status === 501);
}
