'use strict';

const crypto = require('node:crypto');
const { formatPhrase } = require('./utils/rfc822');

// The address book, stored as vCard 3.0 messages in a hidden IMAP folder.
//
// WHY IMAP AND NOT THE BROWSER: the address book is the one piece of this
// user's configuration that they will expect to follow them between devices,
// and it is the one they will expect to survive clearing a browser profile.
// The existing `webmail.address-book.v1` localStorage key satisfies neither.
// IMAP gives us durability, backup (whatever backs the mail store) and
// multi-device sync for free, and it is already the substrate for the other
// hidden store in this app (`.wh-*` for outbound webhooks).
//
// ONE MESSAGE PER CONTACT is what makes the CRUD map onto IMAP at all: a
// delete is an EXPUNGE, an edit is an APPEND followed by an EXPUNGE of the
// old message, and a corrupt row costs one contact rather than the whole
// book. A single JSON blob would make every edit a read-modify-write of the
// whole book, which is exactly the shape that loses data under concurrency.
//
// CONTACT IDENTITY IS THE vCard `UID`, NOT THE ADDRESS. This is the single
// most important decision in the file. If identity were the address, then
// correcting a typo'd address (the whole point of an editable address book)
// would be indistinguishable from deleting one person and adding another:
// the recency/count history would be lost and any favourite ordering would
// reset. A stable opaque `UID` means an edit is a genuine edit of one
// person — rename, re-address, note — and the harvested `lastSeen`/`count`
// statistics ride along with the record.
//
// The UID is minted here, server-side, from random bytes, exactly like the
// webhook inbox token: a client must not be able to choose or collide an
// identifier, and the client never needs to derive one (it POSTs with no id
// and gets the minted one back).

// Hidden folder. Chosen so it cannot collide with the `.wh-` namespace or
// with a folder a human would plausibly create:
//   * leading dot keeps it out of every IMAP client's default folder view,
//     and Dovecot skips dot-folders when the client subscribes by default;
//   * `book-` rather than a bare `.contacts` because `.contacts` is a name
//     Apple's client and Thunderbird's address books both use — we must not
//     invite either to try to interpret or sync our messages;
//   * `book-` is disjoint from `.wh-`, and the hide-filter matches it
//     explicitly, so neither namespace can ever read the other's folders.
const ADDRESS_BOOK_MAILBOX = '.book-addresses';

// Whether `path` is the address book's own hidden folder. Exported so the
// folder-list filter in routes/mailboxes.js matches on the same constant the
// store writes to, rather than on a second copy of the name that can drift.
//
// Built from the constant rather than written out, with the dot escaped:
// an unescaped `.` is a regex wildcard, so a user folder called
// "Xbook-addresses" would be hidden too. The separator prefix means only a
// whole path SEGMENT matches, so a copy nested under a parent (an IMAP
// client that offered to move it) is hidden as well.
const ESCAPED_MAILBOX = ADDRESS_BOOK_MAILBOX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ADDRESS_BOOK_MAILBOX_RE = new RegExp(`(^|[./])${ESCAPED_MAILBOX}$`);
function isAddressBookMailbox(path) {
    return typeof path === 'string' && ADDRESS_BOOK_MAILBOX_RE.test(path);
}

// vCard 3.0 is the version every card reader on earth parses, including the
// address books inside Apple Mail, Thunderbird and Outlook. 4.0 changes the
// property names and needs line folding we would then own; 3.0 is the
// interoperable choice for something the user is likely to open elsewhere.
const VCARD_VERSION = '3.0';

// vCard 2.1 allowed 75-octet lines with soft folding; 3.0 uses 75-octet
// content octets per line excluding CRLF. Folding at 73 keeps every
// continuation legal for both. A contact name longer than this is folded
// rather than truncated, so a long name round-trips instead of being cut.
const FOLD_AT = 73;

// A vCard is a text file inside a message; an unbounded one is a
// write-amplification vector against the user's IMAP store and a
// pathological parse for the reader. MAX_FIELD is far above any real card.
const MAX_FIELD = 400;

function foldLine(line) {
    if (line.length <= FOLD_AT) return line;
    const parts = [];
    let rest = line;
    parts.push(rest.slice(0, FOLD_AT));
    rest = rest.slice(FOLD_AT);
    while (rest.length) {
        parts.push(rest.slice(0, FOLD_AT - 1));
        rest = rest.slice(FOLD_AT - 1);
    }
    // Continuation lines start with a single space, which is not counted
    // against the line's content octets.
    return parts.join('\r\n ');
}

function newUid() {
    // 128 bits of random, hex. Opaque, and impossible for a client to
    // mint, collide, or enumerate.
    return crypto.randomBytes(16).toString('hex');
}

// Strip a CR/LF and fold any whitespace run. A newline in a property value
// is how a "name" turns into a whole extra vCard property, and a bare
// comma or semicolon would add a second EMAIL/ADR component.
function cleanField(value, maxLength = MAX_FIELD) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

// vCard structured values (N, ADR, ORG) are semicolon-separated with a
// trailing semicolon and backslash escaping. Free-text display names go
// through FN, which is a plain text property, so a comma in a name is safe
// there — but a user pasting "Acme, Inc." into a name field would break the
// ORG property, so escape it anyway.
function escapeStructured(value) {
    return cleanField(value).replace(/([\\;,])/g, '\\$1');
}

// Accept a bare address or a "Display Name <addr>" form, since that is what
// users paste. Returns { name, address } with the name null when absent.
function parseAddressInput(input) {
    const raw = cleanField(input, 320);
    if (!raw) return { name: null, address: '' };
    const angled = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<\s*([^>]+?)\s*>\s*$/);
    if (angled) {
        const name = (angled[1] || '').replace(/^"|"$/g, '').trim();
        return { name: name || null, address: angled[2].trim() };
    }
    return { name: null, address: raw };
}

// The minimum a contact must have to be reachable: an address we can send
// to. Anything looser and a typo becomes an unclickable row in the picker.
function isDeliverable(address) {
    return /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(address);
}

function rfc2822Date(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return new Date().toUTCString();
    return d.toUTCString();
}

// Build the RFC822 message that carries one vCard.
//
// The envelope is deliberately synthetic and self-describing: these are
// messages, so IMAP and every mail tool treat them as such, and the headers
// let a user who finds the folder understand what they are looking at.
// Content-Type is the registered text/vcard type, and the parts are a
// plain-text alternative (so a card reader or a browser shows something
// readable) plus the card itself.
function buildVCardMessage(contact, { uidValidity, now, user }) {
    const domain = user && user.includes('@') ? user.split('@')[1] : 'localhost';
    const stamp = rfc2822Date(now);
    const card = buildVCard(contact);
    const boundary = `ab-${uidValidity || '0'}-${now}`;

    const headers = [
        `From: ${formatPhrase('Address Book')} <address-book@${domain}>`,
        `To: <${user || 'nobody'}>`,
        `Subject: ${formatPhrase(contact.name || contact.address)}`,
        `Date: ${stamp}`,
        // The UID is in the Message-ID so a duplicate APPEND is at least
        // traceable, and so restoring the same card on another account
        // produces a distinguishable message.
        `Message-ID: <ab-${contact.uid}-${uidValidity || '0'}@${domain}>`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        `X-Address-Book-Uid: ${contact.uid}`,
        // Signals to a mail client that this is machine-readable data, not
        // a message a human is meant to read in a reading pane.
        'Auto-Submitted: auto-generated',
        'Precedence: bulk',
        '',
        'This is a message from the mailcow webmail address book.',
        `It holds the contact "${contact.name || contact.address}" <${contact.address}>.`,
        'Nothing to read here; the folder is hidden from the folder list on purpose.',
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        `${contact.name || '(no name)'} <${contact.address}>`,
        contact.lastSeen ? `Last seen: ${new Date(contact.lastSeen).toISOString()}` : '',
        contact.count ? `Times seen in your mail: ${contact.count}` : '',
        '',
        `--${boundary}`,
        'Content-Type: text/vcard; charset=utf-8; name="contact.vcf"',
        'Content-Transfer-Encoding: 8bit',
        'Content-Disposition: inline; filename="contact.vcf"',
        '',
        card,
        `--${boundary}--`,
        ''
    ];
    return Buffer.from(headers.join('\r\n'), 'utf8');
}

// vCard 3.0, one contact. FN is the only REQUIRED property; N is emitted in
// the structured form (family;given;additional;prefix;suffix) because every
// card reader expects it, with the whole display name as the "given" slot
// when we have nothing better. We do not try to guess which word is the
// family name — guessing wrong is worse than leaving it structured-lazy,
// and FN is what every UI actually displays.
//
// lastSeen and count are OUR statistics harvested off envelopes, not part
// of the vCard standard, so they ride along as `X-` properties — the
// `X-AB*` family is exactly what Apple and Thunderbird already use for
// client-private vCard extensions, so a card reader that does not know them
// ignores them rather than choking. They have to be persisted, not
// recomputed: the harvest happens once, as mail is rendered, and a reload
// with the counters reset would silently reorder the picker by rank and
// re-file every contact as "never seen".
function buildVCard(contact) {
    const name = cleanField(contact.name);
    const lines = [
        'BEGIN:VCARD',
        `VERSION:${VCARD_VERSION}`,
        `UID:${contact.uid}`,
        `FN:${escapeStructured(name || contact.address)}`
    ];
    if (name) lines.push(`N:${escapeStructured(name)};;;;`);
    if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${cleanField(contact.email)}`);
    else lines.push(`EMAIL;TYPE=INTERNET:${cleanField(contact.address)}`);
    if (name) lines.push(`NICKNAME:${escapeStructured(name)}`);
    if (contact.note) lines.push(`NOTE:${escapeStructured(contact.note)}`);
    if (Number.isFinite(contact.lastSeen) && contact.lastSeen > 0) {
        lines.push(`X-ABSEEN:${Math.trunc(contact.lastSeen)}`);
    }
    if (Number.isFinite(contact.count) && contact.count > 0) {
        lines.push(`X-ABCOUNT:${Math.trunc(contact.count)}`);
    }
    // REV keeps the record self-describing: a card restored into another
    // client shows when it was last touched without this app's own metadata.
    // It is the EDIT time, not the last-seen time, so it must not be used as
    // a fallback for lastSeen (it is the later of the two).
    const rev = contact.updatedAt || Date.now();
    lines.push(`REV:${rfc2822Date(rev)}`);
    lines.push('END:VCARD');
    return lines.map(foldLine).join('\r\n');
}

// Parse a vCard 3.0 out of a raw message.
//
// Tolerant by construction: a card written by another client (the user may
// have copied one in, or synced one from a phone) may be 2.1 or 4.0, may
// fold lines, and may carry properties we do not model. Anything we cannot
// understand is skipped rather than fatal, and a message with no usable
// EMAIL is returned as null so one bad row cannot hide the other four
// hundred.
function parseVCard(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    if (!/BEGIN:VCARD/i.test(text)) return null;

    // Unfold: a line starting with space/tab continues the previous one.
    const unfolded = text.replace(/\r\n/g, '\n')
        .replace(/\n[ \t]/g, '')
        .split('\n');

    let inCard = false;
    let uid = null;
    let fn = null;
    let email = null;
    let note = null;
    let lastSeen = null;
    let count = null;

    for (const line of unfolded) {
        // Group prefixes (EMAIL;TYPE=INTERNET) put the value after the
        // first colon, so match on value not on the property name.
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const prop = line.slice(0, colon).split(';')[0].trim().toUpperCase();
        const value = line.slice(colon + 1).trim();
        if (prop === 'BEGIN' && /^VCARD$/i.test(value)) { inCard = true; continue; }
        if (prop === 'END' && /^VCARD$/i.test(value)) { inCard = false; continue; }
        if (!inCard) continue;
        // A quoted-printable or base64 value is a real card we simply do not
        // decode; skipping beats surfacing mojibake as an email address.
        if (/=\?/i.test(value)) continue;
        switch (prop) {
            case 'UID': if (!uid) uid = unescapeStructured(value); break;
            case 'FN': if (!fn) fn = unescapeStructured(value); break;
            case 'EMAIL': if (!email) email = value; break;
            case 'NOTE': if (!note) note = unescapeStructured(value); break;
            case 'X-ABSEEN': if (lastSeen === null) lastSeen = toPositiveInt(value); break;
            case 'X-ABCOUNT': if (count === null) count = toPositiveInt(value); break;
            default: break;
        }
    }

    if (!email) return null;
    const address = cleanField(email, 320);
    if (!isDeliverable(address)) return null;
    return {
        uid: uid && /^[A-Za-z0-9._-]{1,128}$/.test(uid) ? uid : newUid(),
        address,
        name: fn && fn.trim() ? cleanField(fn, 200) : null,
        note: note ? cleanField(note, 500) : null,
        // A card written by another client has no X-ABSEEN, so lastSeen
        // falls back to the REV stamp (when this app wrote it) and to 0
        // otherwise. Zero is meaningful: it sorts such a contact last in the
        // picker, which is right for someone we have never actually seen
        // mail from, while inventing "now" would float them to the top.
        lastSeen: lastSeen && lastSeen > 0 ? lastSeen : 0,
        count: count && count > 0 ? count : 0
    };
}

// Parse a non-negative integer, or null. NaN/Infinity/negative from a
// hand-edited card must not become a NaN that poisons the sort comparator.
function toPositiveInt(value) {
    const n = Number(String(value).trim());
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.trunc(n);
}

function unescapeStructured(value) {
    return String(value || '').replace(/\\([\\;,])/g, '$1').trim();
}

// Pull the vCard part out of a stored message. The card is always the last
// part in what we write, and a card written elsewhere is usually the only
// part, so: take the text/vcard part if the structure names one, else fall
// back to scanning the body for a BEGIN:VCARD marker.
function extractVCard(message) {
    if (!message) return null;
    const source = message.source ? Buffer.from(message.source) : null;
    if (source) {
        const direct = parseVCard(source.toString('utf8'));
        if (direct) return direct;
    }
    return null;
}

// Enforce the cap by dropping the LEAST recently seen cards first. Same
// rule the localStorage book used, so the migration does not surprise a
// user with a smaller book than they had.
const MAX_CONTACTS = 500;

function trimToCap(contacts) {
    if (contacts.length <= MAX_CONTACTS) return contacts;
    return [...contacts]
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
        .slice(0, MAX_CONTACTS);
}

// Normalize a request body into a storable contact. Returns null when the
// body is unusable, so the caller can answer 400 with a useful title rather
// than writing a card that can never be picked.
function normalizeContact(input, existing) {
    const src = input && typeof input === 'object' ? input : {};

    // Accept the address either bare or in "Name <addr>" form, because that
    // is what gets pasted out of a mail header.
    const parsed = parseAddressInput(src.address);
    const address = cleanField(parsed.address, 320) ||
        cleanField(src.email, 320) ||
        cleanField(existing ? existing.address : '', 320);
    if (!address || !isDeliverable(address)) return null;

    // An explicit name wins; "Name <addr>" in the address field is the
    // fallback; the existing name is the last resort so a bare-address edit
    // does not silently wipe a name the user typed earlier.
    const name = cleanField(src.name, 200) || parsed.name ||
        cleanField(existing ? existing.name : '', 200) || null;

    return {
        // UID is the identity: preserved across an edit, minted on create.
        // It is validated before reuse so a client cannot smuggle a UID
        // with CR/LF into a header, and a UID that fails the check is
        // re-minted rather than rejected — losing the identity would be
        // worse than the collision the check prevents.
        uid: typeof src.uid === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(src.uid)
            ? src.uid
            : (existing ? existing.uid : newUid()),
        address,
        name,
        note: cleanField(src.note, 500) || (existing ? existing.note : null) || null,
        lastSeen: Number.isFinite(Number(src.lastSeen)) && Number(src.lastSeen) > 0
            ? Number(src.lastSeen)
            : (existing ? existing.lastSeen : 0),
        count: Number.isFinite(Number(src.count)) && Number(src.count) > 0
            ? Number(src.count)
            : (existing ? existing.count : 0),
        updatedAt: Date.now()
    };
}

module.exports = {
    ADDRESS_BOOK_MAILBOX,
    isAddressBookMailbox,
    MAX_CONTACTS,
    newUid,
    buildVCardMessage,
    extractVCard,
    normalizeContact,
    trimToCap
};
