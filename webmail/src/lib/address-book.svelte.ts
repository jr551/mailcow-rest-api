// The address book: who you write to, and who you have written to.
//
// TWO LAYERS. The book of record lives on the server, as vCard messages in
// a hidden IMAP folder (src/address-book-store.js), because an address book
// is the one setting a user expects to follow them between devices and to
// survive clearing a browser profile. The previous implementation kept
// everything in localStorage, which satisfied neither.
//
// localStorage IS STILL HERE, as a fallback, and that is a decision rather
// than leftover scaffolding:
//
//   * The IMAP path can be genuinely unavailable — the server may predate
//     this client, the mailbox may deny CREATE, the network may be down at
//     first paint. The only acceptable behaviour then is to keep working: an
//     address book that empties itself when a folder cannot be created is
//     worse than one that lives in the browser.
//   * Harvesting is passive and continuous — every rendered envelope bumps a
//     counter — so the in-memory state is always the live truth and the
//     server is synced on a debounce rather than per envelope.
//
// IDENTITY IS `uid`, NEVER THE ADDRESS. The server mints it and preserves it
// across an address correction, so a typo fix edits one person rather than
// deleting one and creating another. A contact that exists only in the local
// layer has no server identity yet, which is why it reaches the folder
// through the by-address import rather than an update.
//
// CONTACTS ARE INDEXED BY LOWERCASED ADDRESS LOCALLY, for a different
// reason, and the distinction is load-bearing: the client needs a fast
// "have I seen this participant before" test on the hot path of rendering
// mail, and an envelope carries an address. `uid` is what an EDIT is
// addressed to. Conflating the two is the bug this design exists to avoid.

import {
    listContacts,
    createContact,
    updateContact,
    deleteContact,
    importContacts,
    type Contact
} from './contacts';
import { untrack } from 'svelte';
import { authState, getSession } from './auth.svelte';

export type { Contact };

/** Same cap the server enforces, so the layers cannot disagree about what
 *  "full" means and the client never queues an impossible write. */
const MAX_ENTRIES = 500;

/** Fallback key prefix; the book is bucketed per signed-in user
 *  (`<prefix>.<user>`) so one account's correspondents never reach another's
 *  mailbox. The bare prefix and v1 are the pre-per-user global keys: v1 held a
 *  shape with no `uid`, and both are read once (see loadLocal) rather than
 *  discarded, because those contacts were harvested from the user's own mail. */
const STORAGE_KEY = 'webmail.address-book.v2';
const LEGACY_STORAGE_KEY = 'webmail.address-book.v1';

function userKey(user: string): string {
    return `${STORAGE_KEY}.${encodeURIComponent(user)}`;
}

export type AddressBookStore = 'imap' | 'local' | 'unknown';

/** Result of a user edit. A discriminated union so callers must handle the
 *  failure case rather than discovering it as an undefined contact. */
export type EditResult = { ok: true } | { ok: false; error: string };

// ── local fallback ──

function isContact(value: unknown): value is Contact {
    if (!value || typeof value !== 'object') return false;
    const c = value as Record<string, unknown>;
    if (typeof c.address !== 'string' || !c.address.includes('@')) return false;
    return typeof c.name === 'string' || c.name === null;
}

function readKey(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}

function loadLocal(user: string | null): { contacts: Contact[]; legacy: boolean } {
    if (!user) return { contacts: [], legacy: false };
    const own = readKey(userKey(user));
    // The pre-per-user global book is adopted only when a single account is
    // signed in, i.e. when it can only be that account's. With several
    // sessions its owner is unknowable, and guessing would hand one user's
    // correspondents to another.
    const adopt = own === null && authState.sessions.length === 1;
    const raw = own ?? (adopt ? readKey(STORAGE_KEY) : null);

    if (raw) {
        try {
            const p = JSON.parse(raw) as { contacts?: unknown };
            const rows = Array.isArray(p?.contacts) ? p.contacts.filter(isContact) : [];
            return {
                // A v2 record should always carry a uid; mint one if a
                // half-written entry does not, so an edit can still address it.
                contacts: rows.map((c, i) => ({ ...c, uid: c.uid || `local-${i}` })),
                legacy: false
            };
        } catch { /* corrupt — fall through */ }
    }

    const legacyRaw = adopt ? readKey(LEGACY_STORAGE_KEY) : null;
    if (!legacyRaw) return { contacts: [], legacy: false };
    try {
        const p = JSON.parse(legacyRaw) as { contacts?: unknown };
        const rows = Array.isArray(p?.contacts) ? p.contacts.filter(isContact) : [];
        return {
            contacts: rows.map((c, i) => ({
                address: c.address,
                name: c.name ?? null,
                lastSeen: Number(c.lastSeen) || 0,
                count: Number(c.count) || 0,
                uid: `local-${i}`
            })),
            legacy: true
        };
    } catch { return { contacts: [], legacy: false }; }
}

function dropGlobalKeys() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch { /* storage disabled */ }
}

function saveLocal(user: string | null, contacts: Contact[], fromLegacy: boolean) {
    if (!user) return;
    try {
        // Trim the way the server does — least recently seen first — so the
        // layers shed the same records and a sync cannot resurrect a contact
        // the other layer already dropped.
        const trimmed = contacts.length > MAX_ENTRIES
            ? [...contacts].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_ENTRIES)
            : contacts;
        localStorage.setItem(userKey(user), JSON.stringify({ contacts: trimmed, fromLegacy }));
    } catch { /* quota or storage disabled — the in-memory book still works */ }
}

// ── state ──

/** The signed-in user the in-memory book belongs to. */
let owner: string | null = getSession()?.user ?? null;
/** Bumped whenever `owner` changes, so work started for one user can tell it
 *  went stale and must not write into the next user's book. */
let epoch = 0;

const initial = loadLocal(owner);
if (owner) dropGlobalKeys();

const _state = $state<{
    contacts: Contact[];
    /** 'imap' once a server read has succeeded; 'local' while falling back.
     *  'unknown' is the brief unverified window before the first read. */
    store: AddressBookStore;
    /** Set only when the IMAP path is unusable. Settings surfaces it
     *  verbatim: a silent fallback would leave the user believing their
     *  contacts are synced when they are not. */
    error: string | null;
    loading: boolean;
}>({
    contacts: initial.contacts,
    store: 'unknown',
    error: null,
    loading: false
});

export const addressBook = _state;

/** Lowercased address -> contact. The hot-path index for harvesting. */
const lookup = new Map<string, Contact>();

function reindex() {
    lookup.clear();
    for (const c of _state.contacts) lookup.set(c.address.toLowerCase(), c);
}

/**
 * Insert or replace, keeping the array and the address index in step.
 *
 * `$state` arrays are proxied, so an in-place write does not notify anything
 * keyed differently, and the two representations would drift. Every
 * mutation goes through here.
 */
function upsertLocal(contact: Contact) {
    // Match on UID FIRST. That is the identity of a contact, and it is what
    // makes an address correction an edit rather than a second person: an
    // edit carries the same uid with a new address, so the row is found at
    // its existing position and replaced in place. Keying on address alone
    // would append a new row and leave the old one behind — the exact bug
    // the uid design exists to prevent.
    const byUid = _state.contacts.findIndex((c) => c.uid === contact.uid);
    const key = contact.address.toLowerCase();
    if (byUid >= 0) {
        const previous = _state.contacts[byUid];
        if (previous.address.toLowerCase() !== key) lookup.delete(previous.address.toLowerCase());
        _state.contacts[byUid] = contact;
    } else {
        // No uid match. Fall back to the address index, which is how a
        // contact that the server knows under a different uid, or one that
        // arrived from a card we did not write, lands on the existing row.
        const existing = lookup.get(key);
        if (existing) {
            const idx = _state.contacts.findIndex((c) => c.uid === existing.uid);
            if (idx >= 0) _state.contacts[idx] = contact;
            else _state.contacts.push(contact);
        } else {
            _state.contacts.push(contact);
        }
    }
    lookup.set(key, contact);
}

function removeLocal(uid: string) {
    const idx = _state.contacts.findIndex((c) => c.uid === uid);
    if (idx < 0) return;
    const [gone] = _state.contacts.splice(idx, 1);
    lookup.delete(gone.address.toLowerCase());
}

/** A uid the server has never seen. Such a record must be created or
 *  imported, never updated — an update would 404. */
function isLocalOnly(uid: string): boolean {
    return uid.startsWith('local-');
}

let fromLegacy = initial.legacy;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
    clearTimeout(saveTimer as ReturnType<typeof setTimeout>);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveLocal(owner, _state.contacts, fromLegacy);
    }, 1500);
}

/** Re-point the book at the active user: persist the outgoing book under its
 *  own key, then replace everything user-scoped (contacts, index, queues). */
function switchOwner(next: string | null) {
    if (next === owner) return;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        saveLocal(owner, _state.contacts, fromLegacy);
    }
    epoch++;
    owner = next;
    pendingUpdate.clear();
    pendingDelete.clear();
    const local = loadLocal(next);
    if (next) dropGlobalKeys();
    fromLegacy = local.legacy;
    _state.contacts = local.contacts;
    _state.store = 'unknown';
    _state.error = null;
    _state.loading = false;
    reindex();
}

function syncOwner() {
    switchOwner(getSession()?.user ?? null);
}

/** The server derives these; sending them back is how a client-supplied
 *  count cannot masquerade as a harvested one. */
function toDraft(c: Contact) {
    return {
        address: c.address,
        name: c.name,
        note: c.note ?? null,
        lastSeen: c.lastSeen,
        count: c.count
    };
}

/**
 * Switch to the local layer and record why.
 *
 * The message is kept verbatim and shown in Settings. A fallback that
 * announces itself is a degraded feature; one that hides itself misreports
 * where the user's data is.
 */
function degrade(err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    if (_state.store === 'local' && _state.error === detail) return;
    _state.store = 'local';
    _state.error = detail;
    // The local layer is the fallback's whole job, so make sure it holds
    // everything currently on screen before we stop trusting the server.
    scheduleSave();
}

/**
 * Push queued writes to the folder, one at a time.
 *
 * Serialised through a single promise chain. Two concurrent edits to one
 * contact would race, and the earlier write's delete could expunge the
 * later write's card — a contact vanishing because the user clicked Save
 * twice. Sequential, the second edit simply rewrites the first's result.
 */
let pushChain: Promise<void> = Promise.resolve();

/** Server uid -> contact awaiting an update. */
const pendingUpdate = new Map<string, Contact>();
/** Server uids awaiting an expunge. */
const pendingDelete = new Set<string>();

function enqueue(contact: Contact) {
    if (_state.store !== 'imap') return;
    if (isLocalOnly(contact.uid)) return; // handled by import, not update
    pendingDelete.delete(contact.uid);
    pendingUpdate.set(contact.uid, contact);
    void flush();
}

function enqueueDelete(uid: string) {
    if (_state.store !== 'imap' || isLocalOnly(uid)) return;
    pendingUpdate.delete(uid);
    pendingDelete.add(uid);
    void flush();
}

function flush(): Promise<void> {
    pushChain = pushChain.then(async () => {
        const at = epoch;
        while (at === epoch && (pendingUpdate.size || pendingDelete.size)) {
            const uid = pendingUpdate.keys().next().value as string | undefined;
            if (uid === undefined) {
                const batch = [...pendingDelete];
                pendingDelete.clear();
                for (const d of batch) {
                    try {
                        await deleteContact(d);
                    } catch (err) {
                        // Re-arm rather than drop the intent: a delete that
                        // failed silently would resurrect a contact the user
                        // believes they removed, on the next reload.
                        if (at === epoch) pendingDelete.add(d);
                        throw err;
                    }
                }
                continue;
            }
            const contact = pendingUpdate.get(uid);
            pendingUpdate.delete(uid);
            if (!contact) continue;
            try {
                await updateContact(uid, toDraft(contact));
            } catch (err) {
                if (at === epoch) {
                    pendingUpdate.set(uid, contact);
                    degrade(err);
                }
                throw err;
            }
        }
    }).catch(() => { /* degrade() already recorded the reason */ });
    return pushChain;
}

/**
 * Load the book of record and reconcile the local layer into it.
 *
 * Merging, not replacing, is the whole point: a contact harvested while the
 * server path was down exists only locally, and a blind replace would drop
 * it. The server is authoritative for any address it knows (its identity);
 * the local layer supplies whatever it alone has seen.
 */
export async function loadAddressBook(): Promise<void> {
    syncOwner();
    if (!owner || _state.loading) return;
    const at = epoch;
    _state.loading = true;
    try {
        const book = await listContacts();
        if (at !== epoch) return;
        const serverByAddress = new Map(book.contacts.map((c) => [c.address.toLowerCase(), c]));
        const merged: Contact[] = [...book.contacts];
        const onlyLocal: Contact[] = [];

        for (const local of _state.contacts) {
            const key = local.address.toLowerCase();
            const server = serverByAddress.get(key);
            if (!server) {
                // Unknown to the server: keep it on screen and queue it for
                // the by-address import, which de-duplicates server-side.
                merged.push(local);
                onlyLocal.push(local);
                continue;
            }
            const at = merged.findIndex((m) => m.uid === server.uid);
            // Both layers have this address. The server's identity wins; its
            // name is only improved if empty, and the harvest counters take
            // the newer of the two, because the local layer has been
            // counting while the server has not heard from us.
            merged[at] = {
                ...server,
                name: server.name || local.name,
                lastSeen: Math.max(server.lastSeen || 0, local.lastSeen || 0),
                count: Math.max(server.count || 0, local.count || 0)
            };
            if (server.uid !== local.uid && at >= 0) {
                // The local record was a placeholder identity and the server
                // just handed us the real one, so drop the placeholder and
                // re-key the address index onto the server's record.
                removeLocal(local.uid);
            }
        }

        _state.contacts = merged;
        _state.store = 'imap';
        _state.error = null;
        reindex();

        if (onlyLocal.length) {
            // The import is an upsert on address, so this is idempotent and
            // cannot duplicate a person the folder already had.
            await importContacts(onlyLocal.map(toDraft));
            const refreshed = await listContacts();
            if (at !== epoch) return;
            _state.contacts = refreshed.contacts;
            reindex();
        }

        fromLegacy = false;
        scheduleSave();
        await flush();
    } catch (err) {
        if (at === epoch) degrade(err);
    } finally {
        if (at === epoch) _state.loading = false;
    }
}

// ── harvest ──

/**
 * Record one (address, name) pairing off a rendered envelope.
 *
 * The hot path — called for every from/to/cc of every message — so it stays
 * allocation-light and never throws. On the IMAP path the counters stay in
 * memory and are pushed on a debounce: a 200-message sweep would otherwise
 * be 600 network round trips.
 */
export function recordContact(address: string | null | undefined, name?: string | null): void {
    if (!address) return;
    syncOwner();
    if (!owner) return;
    const a = address.trim();
    // Cheap shape check: no dot in the domain means group syntax or a
    // parsing artefact, not a person worth remembering.
    if (!a.includes('@') || !a.includes('.')) return;
    const key = a.toLowerCase();
    const existing = lookup.get(key);
    const now = Date.now();

    const next: Contact = existing
        ? {
            ...existing,
            // Never let a nameless envelope overwrite a known name — a
            // from-address with no display name is the common case and
            // would wipe a name the user typed in Settings.
            name: existing.name || (name?.trim() || null),
            lastSeen: now,
            count: existing.count + 1
        }
        : {
            address: a,
            name: name?.trim() || null,
            lastSeen: now,
            count: 1,
            // Unknown to the server until the next import, so a local uid.
            uid: `local-${key}`
        };

    upsertLocal(next);
    scheduleSave();
    enqueue(next);
}

/** Bulk-record envelope participants (from/to/cc). */
export function recordEnvelope(parts: { name: string | null; address: string | null }[] | undefined): void {
    if (!parts) return;
    for (const p of parts) recordContact(p.address, p.name);
}

// ── user edits ──

/** Add a contact typed by hand. */
export function addContact(input: {
    address: string;
    name?: string | null;
    note?: string | null;
}): EditResult {
    syncOwner();
    const address = input.address.trim();
    if (!address.includes('@') || !address.includes('.')) {
        return { ok: false, error: 'That does not look like an email address' };
    }
    if (lookup.has(address.toLowerCase())) {
        return { ok: false, error: 'That address is already in your contacts' };
    }
    const contact: Contact = {
        address,
        name: input.name?.trim() || null,
        note: input.note?.trim() || null,
        lastSeen: 0,
        count: 0,
        // A local identity until the server mints one. Derived from the
        // address rather than random, so a contact already harvested from
        // mail and then saved by hand resolves to the SAME record instead of
        // appearing twice.
        uid: `local-${address.toLowerCase()}`
    };
    upsertLocal(contact);
    scheduleSave();
    if (_state.store === 'imap') void pushNew(contact);
    return { ok: true };
}

/**
 * Persist a newly added contact, adopting the server's identity.
 *
 * Deliberately NOT awaited by addContact. The row is already on screen and
 * the form has already reset, so the user is unblocked; awaiting here is
 * what made the form appear stuck, and a second Save then looked like a
 * duplicate-address error. On failure the contact simply stays in the local
 * layer, which is exactly the fallback this store is built around.
 */
async function pushNew(contact: Contact): Promise<void> {
    const at = epoch;
    try {
        const created = await createContact(toDraft(contact));
        if (at !== epoch) return;
        // Adopt the server uid so a later edit addresses the real card. The
        // placeholder is removed first because upsertLocal matches on uid:
        // inserting the new record without dropping the old would leave two.
        removeLocal(contact.uid);
        upsertLocal(created);
        scheduleSave();
    } catch (err) { if (at === epoch) degrade(err); }
}

/**
 * Edit a contact, addressed by `uid`.
 *
 * Optimistic: the row updates immediately and the server's version is
 * reconciled after. Waiting on a round trip per commit makes the Settings
 * form feel broken on a slow link, and reconciliation is cheap because the
 * server echoes the stored record back.
 */
export async function editContact(
    uid: string,
    patch: { address?: string; name?: string | null; note?: string | null }
): Promise<EditResult> {
    syncOwner();
    const at = epoch;
    const existing = _state.contacts.find((c) => c.uid === uid);
    if (!existing) return { ok: false, error: 'That contact no longer exists' };
    if (patch.address !== undefined) {
        const a = patch.address.trim();
        if (!a.includes('@') || !a.includes('.')) {
            return { ok: false, error: 'That does not look like an email address' };
        }
        const clash = lookup.get(a.toLowerCase());
        if (clash && clash.uid !== uid) {
            return { ok: false, error: 'Another contact already uses that address' };
        }
    }

    const next: Contact = { ...existing, ...patch };
    next.name = patch.name !== undefined ? (patch.name?.trim() || null) : existing.name;
    next.note = patch.note !== undefined ? (patch.note?.trim() || null) : (existing.note ?? null);

    // The index is keyed by address, so a change of address must move the
    // key rather than leave a stale one for the harvest to match.
    if (next.address.toLowerCase() !== existing.address.toLowerCase()) {
        lookup.delete(existing.address.toLowerCase());
    }
    upsertLocal(next);
    scheduleSave();
    enqueue(next);
    if (_state.store === 'imap' && !isLocalOnly(uid)) {
        try {
            const saved = await updateContact(uid, toDraft(next));
            if (at !== epoch) return { ok: true };
            // Adopt the server's normalisation, but do not lose harvest
            // counters that ticked while the request was in flight.
            saved.lastSeen = Math.max(saved.lastSeen || 0, next.lastSeen || 0);
            saved.count = Math.max(saved.count || 0, next.count || 0);
            const idx = _state.contacts.findIndex((c) => c.uid === uid);
            if (idx >= 0) _state.contacts[idx] = saved;
            lookup.set(saved.address.toLowerCase(), saved);
            scheduleSave();
        } catch (err) { if (at === epoch) degrade(err); }
    }
    return { ok: true };
}

export async function removeContact(uid: string): Promise<void> {
    syncOwner();
    const at = epoch;
    removeLocal(uid);
    scheduleSave();
    if (_state.store === 'imap' && !isLocalOnly(uid)) {
        try {
            await deleteContact(uid);
        } catch (err) {
            if (at === epoch) {
                pendingDelete.add(uid);
                degrade(err);
            }
        }
    }
}

// ── queries ──

/**
 * Rank matches for an autocomplete prefix.
 *
 * Saved contacts and people merely seen in past mail are ONE ranked list,
 * not two groups. The user asked for both together; a grouped list makes
 * the common case (one list, best match first) slower to use, and an
 * address harvested from mail is just as valid a recipient.
 *
 * Ranking, in order:
 *   1. an address that STARTS with what was typed — the thing being typed
 *      is almost always an address;
 *   2. a name that starts with it, so "ada" finds "Ada Lovelace <ada@…>";
 *   3. a name that merely contains it, then an address that does;
 *   4. and within a tier, a contact we KNOW a name for outranks a bare
 *      address. Without that, the user's own harvested address — which has
 *      no display name but a high mention count — outranks a contact they
 *      deliberately saved with one, and a saved contact can be pushed off
 *      an 8-row list by strangers. Naming somebody is a stronger signal of
 *      intent than how often mail happened to mention them.
 *
 * Count and recency remain the final tiebreaks, so among equally-named or
 * equally-bare matches the people you actually correspond with come first.
 */
export function searchContacts(prefix: string, limit = 8): Contact[] {
    const q = prefix.trim().toLowerCase();
    if (!q) {
        return [..._state.contacts]
            .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
            .slice(0, limit);
    }
    const scored: { contact: Contact; score: number }[] = [];
    for (const c of _state.contacts) {
        const addr = c.address.toLowerCase();
        const name = (c.name || '').toLowerCase();
        let score = -1;
        if (addr.startsWith(q)) score = 400;
        else if (name.startsWith(q)) score = 300;
        else if (name.includes(q)) score = 200;
        else if (addr.includes(q)) score = 100;
        if (score < 0) continue;
        // A known display name is a deliberate choice by the user, so it
        // outranks a bare address in the same tier.
        if (c.name) score += 50;
        scored.push({ contact: c, score });
    }
    scored.sort((a, b) =>
        b.score - a.score ||
        b.contact.count - a.contact.count ||
        b.contact.lastSeen - a.contact.lastSeen
    );
    return scored.slice(0, limit).map((s) => s.contact);
}

/** Friendly name for an address, or '' — what a recipient pill shows. */
export function contactNameFor(address: string): string {
    return lookup.get(address.toLowerCase())?.name || '';
}

/** Every contact, name-sorted, for the editable list in Settings. */
function allContacts(): Contact[] {
    return [..._state.contacts].sort((a, b) =>
        (a.name || a.address).localeCompare(b.name || b.address)
    );
}

/** Case-insensitive filter over name, address and note. */
export function filterContacts(query: string): Contact[] {
    const q = query.trim().toLowerCase();
    if (!q) return allContacts();
    return allContacts().filter((c) =>
        c.address.toLowerCase().includes(q) ||
        (c.name || '').toLowerCase().includes(q) ||
        (c.note || '').toLowerCase().includes(q)
    );
}

/**
 * Remove one contact from both layers.
 *
 * There is deliberately no "clear everything" that touches the server: the
 * server exposes per-contact CRUD only, and a bulk nuke is a foot-gun that
 * would also throw away contacts added from another device.
 */
export async function clearAddressBook(): Promise<void> {
    syncOwner();
    const at = epoch;
    const targets = _state.contacts.filter((c) => !isLocalOnly(c.uid));
    _state.contacts = [];
    lookup.clear();
    pendingUpdate.clear();
    pendingDelete.clear();
    try {
        if (owner) localStorage.removeItem(userKey(owner));
    } catch { /* storage disabled */ }
    dropGlobalKeys();
    for (const c of targets) {
        try {
            await deleteContact(c.uid);
        } catch (err) {
            if (at !== epoch) return;
            pendingDelete.add(c.uid);
            degrade(err);
        }
    }
}

// ── account changes ──

// The book is per user. When the active account changes, or one is signed
// out, drop the previous user's in-memory book and queues so none of it can be
// merged or imported into the next account's mailbox, and delete the local
// copy of any account that is no longer signed in.
let knownUsers = new Set<string>();

$effect.root(() => {
    $effect(() => {
        const active = getSession()?.user ?? null;
        const signedIn = new Set(authState.sessions.map((x) => x.user));
        untrack(() => {
            const previous = owner;
            switchOwner(active);
            for (const user of knownUsers) {
                if (signedIn.has(user)) continue;
                try { localStorage.removeItem(userKey(user)); } catch { /* storage disabled */ }
            }
            knownUsers = signedIn;
            if (previous && active && previous !== active) {
                void loadAddressBook();
            }
        });
    });
});
