'use strict';

const { withClient, withMailbox } = require('../imap');
const { badRequest, notFound } = require('../errors');
const { problemSchema } = require('../schemas');
const {
    ADDRESS_BOOK_MAILBOX,
    MAX_CONTACTS,
    newUid,
    buildVCardMessage,
    extractVCard,
    normalizeContact,
    trimToCap
} = require('../address-book-store');

// The address book: contacts stored as vCard messages in a hidden IMAP
// folder. See src/address-book-store.js for the storage design; this file is
// the HTTP surface over it.
//
// Every route returns a plain contact object and never exposes a file path,
// because the folder is an implementation detail the client must not depend
// on or be surprised by.

// A UID is opaque and server-minted; anything else in this position is a
// malformed request, not a lookup that might match something.
const UID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function assertUid(uid) {
    if (typeof uid !== 'string' || !UID_RE.test(uid)) throw badRequest('Malformed contact id');
    return uid;
}

// The folder has to exist before anything can be read or written.
//
// The existence probe is an EXAMINE (a read-only lock) rather than a CREATE
// because calling CREATE on every list would put a pointless write command
// on the IMAP session for the common case where the folder is already there.
// The probe lock MUST be released before returning — a second, real lock on
// the same mailbox from the same client is a protocol error on some servers,
// so it cannot simply be left held.
async function ensureBookFolder(client) {
    try {
        const probe = await client.getMailboxLock(ADDRESS_BOOK_MAILBOX, { readonly: true });
        try { probe.release(); } catch { /* already gone */ }
        return;
    } catch (err) {
        const code = err && (err.serverResponseCode || err.code);
        const missing = code === 'NONEXISTENT' || code === 'TRYCREATE' ||
            /nonexistent|does ?n[o']?t exist|no such (mailbox|folder)/i.test(String(err && err.message));
        // A permission failure or a dead connection is NOT something to paper
        // over by attempting a CREATE. Let it propagate: the client then
        // falls back to its local book and says so, instead of silently
        // getting an empty one.
        if (!missing) throw err;
    }
    try {
        const res = await client.mailboxCreate(ADDRESS_BOOK_MAILBOX);
        // imapflow reports "already there" as a resolved {created:false} on
        // some servers and as a thrown ALREADYEXISTS on others; both mean
        // the folder exists, which is the only thing this function promises.
        if (res && res.created === false) return;
    } catch (err) {
        if (!/already exists/i.test(String((err && err.message) || err))) throw err;
    }
}

// Read the whole book in ONE round trip, returning each contact together
// with the IMAP UID of the message that carries it.
//
// This is a deliberate departure from the webhook forwarder, which seeks a
// single message by UID because it is polling a queue. Here the folder holds
// at most MAX_CONTACTS small text messages, and an edit has to find the
// message carrying a given vCard UID. Locating it with IMAP `SEARCH HEADER`
// would depend on each server's substring semantics for Message-ID, whereas
// one `FETCH 1:*` of the source is exact and server-independent. The cap is
// also a read bound: a folder someone has stuffed with unrelated mail cannot
// turn a list request into an unbounded fetch.
async function readBook(client) {
    const seen = new Map(); // vCard uid -> { contact, msgUid }
    const range = `1:${MAX_CONTACTS}`;
    for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
        const contact = extractVCard(msg);
        if (!contact) continue;
        // LAST occurrence wins, and that is load-bearing rather than
        // arbitrary. An edit appends the corrected card and then expunges
        // the old one, so the window between those two commands can contain
        // two messages with the same vCard UID. FETCH returns ascending
        // UID order, so the last one seen is the newly appended card — the
        // one the user just saved. First-wins would resurrect the pre-edit
        // card and appear to silently undo the edit.
        seen.set(contact.uid, { contact, msgUid: msg.uid });
    }
    const contacts = trimToCap([...seen.values()].map((e) => e.contact));
    // Build the uid->message map from the SURVIVING set, so a lookup can
    // never resolve to a message for a contact that was trimmed away.
    const kept = new Set(contacts.map((c) => c.uid));
    const byUid = new Map();
    for (const [uid, entry] of seen) {
        if (kept.has(uid)) byUid.set(uid, entry.msgUid);
    }
    return { contacts, byUid };
}

const contactSchema = {
    type: 'object',
    properties: {
        uid: { type: 'string' },
        address: { type: 'string' },
        name: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
        lastSeen: { type: 'integer' },
        count: { type: 'integer' }
    }
};

const contactBodySchema = {
    type: 'object',
    properties: {
        address: { type: 'string', maxLength: 320 },
        name: { type: 'string', maxLength: 200 },
        note: { type: 'string', maxLength: 500 },
        lastSeen: { type: 'integer', minimum: 0 },
        count: { type: 'integer', minimum: 0 }
    }
};

function appendCard(client, creds, contact) {
    return client.append(
        ADDRESS_BOOK_MAILBOX,
        buildVCardMessage(contact, {
            uidValidity: client.mailbox && client.mailbox.uidValidity,
            now: Date.now(),
            user: creds.user
        }),
        ['\\Seen']
    );
}

module.exports = async function addressBookRoutes(app, { pool } = {}) {
    if (!pool) {
        // Not fatal: the rest of the API is unaffected and the client falls
        // back to its local book. Registering no routes at all means the
        // client's calls 404, which it already handles as "IMAP store
        // unavailable" — the same path as a permission failure.
        app.log?.warn?.('address-book routes registered without an IMAP pool; contacts disabled');
        return;
    }

    app.get('/v1/me/contacts', {
        schema: {
            tags: ['contacts'],
            summary: 'List address-book contacts',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        contacts: { type: 'array', items: contactSchema },
                        folder: { type: 'string' }
                    }
                },
                401: problemSchema,
                502: problemSchema
            }
        }
    }, async (req) => withClient(pool, req.creds, async (client) => {
        await ensureBookFolder(client);
        const { contacts } = await withMailbox(client, ADDRESS_BOOK_MAILBOX, true,
            () => readBook(client));
        return { contacts, folder: ADDRESS_BOOK_MAILBOX };
    }));

    app.post('/v1/me/contacts', {
        schema: {
            tags: ['contacts'],
            summary: 'Create an address-book contact',
            body: contactBodySchema,
            response: { 201: contactSchema, 400: problemSchema, 409: problemSchema }
        }
    }, async (req, reply) => {
        const contact = normalizeContact(req.body, null);
        if (!contact) throw badRequest('A deliverable email address is required');

        return withClient(pool, req.creds, async (client) => {
            await ensureBookFolder(client);
            return withMailbox(client, ADDRESS_BOOK_MAILBOX, false, async () => {
                const { contacts, byUid } = await readBook(client);
                // A create landing on an existing UID is a replayed stale
                // response, not a user conflict: the UID is 128 random bits
                // from the server, so the client cannot have chosen it.
                // Re-minting keeps the create succeeding, which is what the
                // user asked for; a 409 here would be unactionable.
                if (byUid.has(contact.uid)) contact.uid = newUid();
                if (contacts.length >= MAX_CONTACTS) {
                    throw badRequest(
                        `Address book is full (${MAX_CONTACTS} contacts). Delete one and try again.`);
                }
                await appendCard(client, req.creds, contact);
                reply.code(201);
                return contact;
            });
        });
    });

    app.patch('/v1/me/contacts/:uid', {
        schema: {
            tags: ['contacts'],
            summary: 'Edit a contact. Identity is the vCard UID, so an address can be corrected in place.',
            params: {
                type: 'object',
                properties: { uid: { type: 'string', maxLength: 128 } },
                required: ['uid']
            },
            body: contactBodySchema,
            response: { 200: contactSchema, 400: problemSchema, 404: problemSchema }
        }
    }, async (req) => {
        const uid = assertUid(String(req.params.uid));

        return withClient(pool, req.creds, async (client) => {
            await ensureBookFolder(client);
            return withMailbox(client, ADDRESS_BOOK_MAILBOX, false, async () => {
                const { contacts, byUid } = await readBook(client);
                const existing = contacts.find((c) => c.uid === uid);
                if (!existing) throw notFound('Contact not found');

                const next = normalizeContact(req.body, existing);
                if (!next) throw badRequest('A deliverable email address is required');
                // Identity is immutable across an edit. normalizeContact
                // already preserves it; asserting here as well means a
                // client cannot smuggle a different `uid` into the body and
                // move a contact's identity, orphaning the harvested
                // lastSeen/count history attached to it.
                next.uid = existing.uid;

                // APPEND BEFORE EXPUNGE, in that order, deliberately. A card
                // is a whole message, so an edit is a new message and the
                // old one has to go. Deleting first would open a window in
                // which a crash loses the contact outright; appending first
                // leaves at worst a duplicate, and readBook's last-wins rule
                // resolves it in favour of the card just written.
                await appendCard(client, req.creds, next);
                await client.messageDelete(String(byUid.get(uid)), { uid: true });
                return next;
            });
        });
    });

    app.delete('/v1/me/contacts/:uid', {
        schema: {
            tags: ['contacts'],
            summary: 'Delete a contact',
            params: {
                type: 'object',
                properties: { uid: { type: 'string', maxLength: 128 } },
                required: ['uid']
            },
            response: { 204: { type: 'null' }, 400: problemSchema, 404: problemSchema }
        }
    }, async (req, reply) => {
        const uid = assertUid(String(req.params.uid));

        await withClient(pool, req.creds, async (client) => {
            await ensureBookFolder(client);
            return withMailbox(client, ADDRESS_BOOK_MAILBOX, false, async () => {
                const { byUid } = await readBook(client);
                const messageUid = byUid.get(uid);
                if (messageUid === undefined) throw notFound('Contact not found');
                // UID EXPUNGE (imapflow's messageDelete with {uid:true}),
                // not a sequence delete: sequence numbers shift the moment
                // anything else in this folder changes, and deleting by
                // sequence would remove the wrong contact.
                await client.messageDelete(String(messageUid), { uid: true });
                reply.code(204).send();
            });
        });
    });

    // Bulk upsert. This is how a book captured while the IMAP path was
    // unavailable gets back into the folder once it works, and how a user
    // who already had a localStorage book is migrated without losing
    // anything. It is an upsert rather than a replace on purpose: the
    // client is handing us a book that may overlap whatever is already
    // there, and a replace would delete contacts the client never knew
    // about — including ones another device added while this one was in
    // fallback.
    app.post('/v1/me/contacts/import', {
        schema: {
            tags: ['contacts'],
            summary: 'Merge contacts captured while the IMAP store was unavailable',
            body: {
                type: 'object',
                required: ['contacts'],
                properties: {
                    contacts: {
                        type: 'array',
                        maxItems: MAX_CONTACTS,
                        items: {
                            type: 'object',
                            properties: {
                                uid: { type: 'string', maxLength: 128 },
                                address: { type: 'string', maxLength: 320 },
                                name: { type: 'string', maxLength: 200 },
                                note: { type: 'string', maxLength: 500 },
                                lastSeen: { type: 'integer', minimum: 0 },
                                count: { type: 'integer', minimum: 0 }
                            }
                        }
                    }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        imported: { type: 'integer' },
                        skipped: { type: 'integer' },
                        folder: { type: 'string' }
                    }
                },
                502: problemSchema
            }
        }
    }, async (req) => withClient(pool, req.creds, async (client) => {
        await ensureBookFolder(client);
        return withMailbox(client, ADDRESS_BOOK_MAILBOX, false, async () => {
            const { contacts, byUid } = await readBook(client);
            const byAddress = new Map(contacts.map((c) => [c.address.toLowerCase(), c]));
            const byUidContact = new Map(contacts.map((c) => [c.uid, c]));

            let imported = 0;
            let skipped = 0;
            let size = contacts.length;

            for (const raw of req.body.contacts) {
                const contact = normalizeContact(raw, null);
                // An unusable row is skipped, never fatal. This route exists
                // for the case where the data came from a degraded path, and
                // failing the batch would strand every good row alongside
                // the one bad one.
                if (!contact) { skipped += 1; continue; }

                // Match on UID first, then on address. Matching by address
                // is what makes the import idempotent: re-running it after a
                // partial failure must not duplicate people, and a client
                // whose offline book has a locally-minted UID still lands on
                // the server's copy of the same person.
                const target = byUidContact.get(contact.uid) ||
                    byAddress.get(contact.address.toLowerCase());
                if (target) {
                    // Only rewrite when the client actually knows something
                    // the folder does not — a name typed while the folder
                    // was unreachable. Rewriting unconditionally would
                    // stamp a fresh REV on every sync and churn the folder.
                    if (contact.name && !target.name) {
                        const merged = { ...target, name: contact.name, updatedAt: Date.now() };
                        await appendCard(client, req.creds, merged);
                        await client.messageDelete(String(byUid.get(target.uid)), { uid: true });
                        byAddress.set(merged.address.toLowerCase(), merged);
                        imported += 1;
                    }
                    continue;
                }
                if (size >= MAX_CONTACTS) { skipped += 1; continue; }
                // Always mint a fresh server UID: the client's offline UID
                // is not a credential we want to adopt into a header.
                const fresh = { ...contact, uid: newUid() };
                await appendCard(client, req.creds, fresh);
                byAddress.set(fresh.address.toLowerCase(), fresh);
                byUidContact.set(fresh.uid, fresh);
                size += 1;
                imported += 1;
            }
            return { imported, skipped, folder: ADDRESS_BOOK_MAILBOX };
        });
    }));
};
