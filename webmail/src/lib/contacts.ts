// Address-book API client.
//
// Thin wrapper over the /v1/me/contacts routes in src/routes/address-book.js.
// Separate module for the same reason outbound-webhooks.ts is: the storage
// detail (a hidden IMAP folder of vCards) must not leak into the components,
// so the only thing they ever see is a Contact with a stable `uid`.
//
// IDENTITY IS `uid`, NOT `address`. The server mints it and keeps it across
// an address correction, so `PATCH /contacts/:uid` edits one person rather
// than deleting one and creating another. Anything that keys a contact by
// its address text is re-implementing the bug this design exists to avoid.

import { apiUrl, ApiError } from './api';
import { bearerHeader, getSession, tryRenewSession } from './auth.svelte';

export interface Contact {
    /** Server-minted, stable across address changes. The only valid key. */
    uid: string;
    address: string;
    name: string | null;
    note?: string | null;
    /** Epoch ms of the last envelope we harvested this address from, or 0
     *  for a contact typed by hand that has never been seen in mail. */
    lastSeen: number;
    /** How many envelopes this address has appeared on. Ranks the picker. */
    count: number;
}

// Local request helper, matching outbound-webhooks.ts: api.ts's `request` is
// private, and duplicating its 401-retry is the established shape for a
// settings-facing module rather than exporting it.
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
    if (res.status === 401 && !retried) {
        if (await tryRenewSession()) return request<T>(method, url, body, true);
    }
    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
            const j = await res.json();
            detail = j?.detail || j?.title || j?.message || detail;
        } catch { /* not JSON */ }
        throw new ApiError({ type: 'about:blank', status: res.status, title: 'Contact request failed', detail });
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json() as Promise<T>;
    return res.text() as unknown as Promise<T>;
}
export interface ContactDraft {
    address: string;
    name?: string | null;
    note?: string | null;
    lastSeen?: number;
    count?: number;
}

export interface ContactBook {
    contacts: Contact[];
    /** The hidden IMAP folder holding the cards. Display-only; the client
     *  must not depend on its name, since it is a server implementation
     *  detail and only exists so the user can see where their data lives. */
    folder: string;
}

/**
 * Whether a folder is webmail's own bookkeeping rather than the user's mail.
 *
 * The server hides these from /v1/mailboxes, but the Sidebar ALSO filters
 * locally (for `.storage_webmailsettings`, and to be robust to a cached
 * mailbox list from before the server-side filter existed), so the client
 * needs the same predicate. Kept here next to the folder name so the two
 * stay together; the server's copy lives in src/address-book-store.js.
 */
const HIDDEN_FOLDER_RE = /(^|[./])\.(book-addresses|storage_)/;
export function isHiddenWebmailFolder(path: string): boolean {
    return HIDDEN_FOLDER_RE.test(String(path || ''));
}

export async function listContacts(): Promise<ContactBook> {
    return request<ContactBook>('GET', '/v1/me/contacts');
}

export async function createContact(draft: ContactDraft): Promise<Contact> {
    return request<Contact>('POST', '/v1/me/contacts', draft);
}

/** Edit in place. `uid` identifies the person; `address` may change freely. */
export async function updateContact(uid: string, draft: Partial<ContactDraft>): Promise<Contact> {
    return request<Contact>('PATCH', `/v1/me/contacts/${encodeURIComponent(uid)}`, draft);
}

export async function deleteContact(uid: string): Promise<void> {
    return request<void>('DELETE', `/v1/me/contacts/${encodeURIComponent(uid)}`);
}

/**
 * Merge a book captured elsewhere into the folder.
 *
 * The server upserts on uid-then-address, so this is safe to re-run and does
 * not clobber contacts added by another device. Used to migrate the old
 * localStorage book and to catch a fallback book up once IMAP recovers.
 */
export async function importContacts(contacts: ContactDraft[]): Promise<{
    imported: number;
    skipped: number;
    folder: string;
}> {
    return request('POST', '/v1/me/contacts/import', { contacts });
}
