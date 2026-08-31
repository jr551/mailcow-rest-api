// Local address book — populated by harvesting envelopes off every
// message we render. Drives To/Cc/Bcc autocomplete in Compose.
//
// Lives in localStorage. No server round-trip; no privacy leak. Capped
// at MAX_ENTRIES with LRU-by-lastSeen eviction.

const STORAGE_KEY = 'webmail.address-book.v1';
const MAX_ENTRIES = 500;

export interface Contact {
    address: string;
    name: string | null;
    lastSeen: number;
    count: number;
}

interface Persist { contacts: Contact[] }

function load(): Contact[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const p = JSON.parse(raw) as Persist;
        return Array.isArray(p?.contacts) ? p.contacts : [];
    } catch { return []; }
}

function save(contacts: Contact[]) {
    try {
        let trimmed = contacts;
        if (trimmed.length > MAX_ENTRIES) {
            trimmed = [...contacts].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_ENTRIES);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ contacts: trimmed }));
    } catch { /* quota / disabled */ }
}

const _state = $state<{ contacts: Contact[] }>({ contacts: load() });
export const addressBook = _state;

const lookup = new Map<string, Contact>();
for (const c of _state.contacts) lookup.set(c.address.toLowerCase(), c);

let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
    if (dirtyTimer) clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => {
        save(_state.contacts);
        dirtyTimer = null;
    }, 1500);
}

/** Record a single (address, name) pairing. Updates lastSeen + count. */
export function recordContact(address: string | null | undefined, name?: string | null) {
    if (!address) return;
    const a = address.trim();
    if (!a || !a.includes('@')) return;
    const key = a.toLowerCase();
    const existing = lookup.get(key);
    const now = Date.now();
    const next: Contact = existing
        ? {
            ...existing,
            name: existing.name || (name?.trim() || null),
            lastSeen: now,
            count: existing.count + 1
        }
        : {
            address: a,
            name: name?.trim() || null,
            lastSeen: now,
            count: 1
        };
    lookup.set(key, next);
    if (existing) {
        const idx = _state.contacts.findIndex((c) => c.address.toLowerCase() === key);
        if (idx >= 0) _state.contacts[idx] = next;
    } else {
        _state.contacts.push(next);
    }
    scheduleSave();
}

/** Bulk-record a list of envelope participants (from/to/cc). */
export function recordEnvelope(parts: { name: string | null; address: string | null }[] | undefined) {
    if (!parts) return;
    for (const p of parts) recordContact(p.address, p.name);
}

/** Best matches for an autocomplete prefix; sorted by count then recency. */
export function searchContacts(prefix: string, limit = 8): Contact[] {
    const q = prefix.trim().toLowerCase();
    if (!q) {
        return [..._state.contacts]
            .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
            .slice(0, limit);
    }
    const matches = _state.contacts.filter((c) =>
        c.address.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q));
    matches.sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
    return matches.slice(0, limit);
}

export function clearAddressBook() {
    _state.contacts = [];
    lookup.clear();
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
}
