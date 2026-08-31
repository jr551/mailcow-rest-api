'use strict';

// The public iCal share token granted read + write on the WHOLE calendar,
// and it was stamped into every event's DESCRIPTION and LOCATION — so any
// attendee of a single event received full access to every event on the
// calendar. The edit routes also took the target uid as a plain path
// parameter, with nothing binding it to the event the link was published on.
//
// Edit links now carry a per-event grant: the token record's public id plus
// an HMAC over exactly one uid, signed with a key that is not the feed
// token.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { IcalTokenStore } = require('../../src/ical-token-store');

function tmpStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ical-grant-'));
    return { store: new IcalTokenStore(path.join(dir, 'ical-tokens.json')), dir };
}

// Mirrors the helpers in routes/calendar.js.
function makeEventGrant(rec, uid) {
    const uidPart = Buffer.from(String(uid), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', rec.editKey)
        .update(`${rec.id}:${uid}`)
        .digest('base64url')
        .slice(0, 27);
    return `${rec.id}.${uidPart}.${sig}`;
}

function readEventGrant(store, grant) {
    if (typeof grant !== 'string') return null;
    const parts = grant.split('.');
    if (parts.length !== 3) return null;
    const [id, uidPart, sig] = parts;
    const rec = store.getById(id);
    if (!rec || !rec.editKey) return null;
    let uid;
    try { uid = Buffer.from(uidPart, 'base64url').toString('utf8'); } catch { return null; }
    if (!uid) return null;
    const expected = crypto.createHmac('sha256', rec.editKey)
        .update(`${id}:${uid}`)
        .digest('base64url')
        .slice(0, 27);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { rec, uid };
}

test('issued tokens get a public id and a signing key distinct from the token', () => {
    const { store, dir } = tmpStore();
    try {
        const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
        const rec = store.get(token);
        assert.ok(rec.id, 'has a public edit id');
        assert.ok(rec.editKey, 'has a signing key');
        assert.notEqual(rec.editKey, token, 'the signing key is not the feed token');
        assert.notEqual(rec.id, token, 'the public id is not the feed token');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a grant round-trips to exactly the uid it was issued for', () => {
    const { store, dir } = tmpStore();
    try {
        const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
        const rec = store.get(token);
        const grant = makeEventGrant(rec, 'event-one@example.com');

        const claim = readEventGrant(store, grant);
        assert.ok(claim);
        assert.equal(claim.uid, 'event-one@example.com');
        assert.equal(claim.rec.user, 'u@x.com');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a grant for one event cannot be retargeted at another', () => {
    const { store, dir } = tmpStore();
    try {
        const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
        const rec = store.get(token);
        const grant = makeEventGrant(rec, 'invited-event@example.com');
        const [id, , sig] = grant.split('.');

        // Swap in the uid of an event the holder was never invited to,
        // keeping the signature — the old route would have honoured this.
        const otherUid = Buffer.from('private-event@example.com').toString('base64url');
        assert.equal(readEventGrant(store, `${id}.${otherUid}.${sig}`), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the feed token is not usable as a grant', () => {
    const { store, dir } = tmpStore();
    try {
        const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
        const uid = Buffer.from('event-one@example.com').toString('base64url');
        // Whole token, or token-as-id: neither authorises an edit.
        assert.equal(readEventGrant(store, token), null);
        assert.equal(readEventGrant(store, `${token}.${uid}.abc`), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grants from one calendar record do not validate against another', () => {
    const { store, dir } = tmpStore();
    try {
        const a = store.get(store.issue({ user: 'a@x.com', pass: 'p', calendar: 'work' }).token);
        const b = store.get(store.issue({ user: 'b@x.com', pass: 'p', calendar: 'home' }).token);

        const grantA = makeEventGrant(a, 'shared-uid@example.com');
        const [, uidPart, sigA] = grantA.split('.');

        // b's id with a's signature must not validate.
        assert.equal(readEventGrant(store, `${b.id}.${uidPart}.${sigA}`), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed grants are rejected without throwing', () => {
    const { store, dir } = tmpStore();
    try {
        store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
        for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '..', 'x'.repeat(500), null, undefined, 42, {}]) {
            assert.equal(readEventGrant(store, bad), null, `rejected: ${String(bad)}`);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing records are migrated with an id and signing key on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ical-migrate-'));
    try {
        const file = path.join(dir, 'ical-tokens.json');
        // A record as written by the previous version: no id, no editKey.
        fs.writeFileSync(file, JSON.stringify({
            ['a'.repeat(64)]: { user: 'old@x.com', pass: 'p', calendar: 'personal', createdAt: 1, expiresAt: null }
        }));

        const store = new IcalTokenStore(file);
        const rec = store.get('a'.repeat(64));
        assert.ok(rec.id, 'migrated record has an id');
        assert.ok(rec.editKey, 'migrated record has a signing key');
        assert.ok(store.getById(rec.id), 'and is findable by it');

        // The migration is persisted, not just in memory.
        const reloaded = new IcalTokenStore(file).get('a'.repeat(64));
        assert.equal(reloaded.id, rec.id);
        assert.equal(reloaded.editKey, rec.editKey);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('getById refuses an expired record', () => {
    const { store, dir } = tmpStore();
    try {
        // Issue with a real TTL and expire the record by hand. A 1ms ttlMs
        // raced the very next line — on a loaded runner the record was already
        // expired, get() returned null, and the test died on rec.id instead of
        // testing getById at all.
        const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal', ttlMs: 60_000 });
        const rec = store.get(token);
        const id = rec.id;
        rec.expiresAt = Date.now() - 1000;
        assert.equal(store.getById(id), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
