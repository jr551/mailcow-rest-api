'use strict';

// Regression tests for the calendar / address-book / Drive / B2 pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const sensible = require('@fastify/sensible');
const icsEdit = require('../../src/ics-edit');
const { parseIcal, escapeIcalText, unescapeIcalText, foldLine, CaldavClient } = require('../../src/caldav-client');
const { IcalTokenStore } = require('../../src/ical-token-store');
const { DriveUserStore } = require('../../src/drive-user-store');
const { B2Client } = require('../../src/b2-client');
const { normalizeContact, buildVCardMessage } = require('../../src/address-book-store');
const calendarRoutes = require('../../src/routes/calendar');
const driveRoutes = require('../../src/routes/drive');

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const WITH_ALARM = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:ev1@example.com',
    'DTSTART;TZID=Europe/London:20260601T090000',
    'DTEND;TZID=Europe/London:20260601T100000',
    'SUMMARY:Standup',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'DESCRIPTION:Real description',
    'ATTENDEE;CN=A:mailto:a@example.com',
    'END:VEVENT',
    'END:VCALENDAR'
].join('\r\n');

function eventBlock(text = WITH_ALARM, uid = 'ev1@example.com') {
    return icsEdit.splitEventByUid(icsEdit.unfold(text), uid).vevent;
}

// ── ics-edit: nested components ──

test('readEventFields reads the event DESCRIPTION, not the VALARM one that comes first', () => {
    const f = icsEdit.readEventFields(eventBlock());
    assert.equal(f.description, 'Real description');
});

test('applyEdits on DESCRIPTION leaves the VALARM text alone', () => {
    const out = icsEdit.applyEdits(eventBlock(), { description: 'New text' });
    assert.match(out, /BEGIN:VALARM[\s\S]*DESCRIPTION:Reminder[\s\S]*END:VALARM/);
    assert.match(out, /DESCRIPTION:New text/);
    assert.doesNotMatch(out, /Real description/);
});

test('clearing DESCRIPTION keeps the VALARM description', () => {
    const out = icsEdit.applyEdits(eventBlock(), { description: '' });
    assert.match(out, /DESCRIPTION:Reminder/);
    assert.doesNotMatch(out, /Real description/);
});

test('a new DESCRIPTION is added at event level when the event had none', () => {
    const noDesc = WITH_ALARM.replace('DESCRIPTION:Real description\r\n', '');
    const out = icsEdit.applyEdits(eventBlock(noDesc), { description: 'Added' });
    const lines = out.split('\r\n');
    assert.ok(lines.indexOf('DESCRIPTION:Added') > lines.indexOf('END:VALARM'));
    assert.match(out, /DESCRIPTION:Reminder/);
});

test('parseIcal ignores a VALARM DESCRIPTION', () => {
    const [ev] = parseIcal(WITH_ALARM);
    assert.equal(ev.description, 'Real description');
    assert.equal(ev.summary, 'Standup');
});

// ── ics-edit: TZID / all-day preservation ──

test('applyEdits with no start/end keeps the TZID lines untouched', () => {
    const out = icsEdit.applyEdits(eventBlock(), { summary: 'Renamed' });
    assert.match(out, /DTSTART;TZID=Europe\/London:20260601T090000/);
    assert.match(out, /DTEND;TZID=Europe\/London:20260601T100000/);
});

test('a changed start on a TZID event stays in its zone', () => {
    const out = icsEdit.applyEdits(eventBlock(), { start: '2026-06-01T08:30:00Z' });
    assert.match(out, /DTSTART;TZID=Europe\/London:20260601T083000\r\n/);
});

test('a changed date on an all-day event stays all-day', () => {
    const allDay = [
        'BEGIN:VEVENT', 'UID:d1', 'DTSTART;VALUE=DATE:20260601', 'DTEND;VALUE=DATE:20260602', 'SUMMARY:Away', 'END:VEVENT'
    ].join('\r\n');
    const out = icsEdit.applyEdits(allDay, { start: '2026-06-03T00:00:00Z', end: '2026-06-04T00:00:00Z' });
    assert.match(out, /DTSTART;VALUE=DATE:20260603\r\n/);
    assert.match(out, /DTEND;VALUE=DATE:20260604\r\n/);
});

test('setting DTEND removes a conflicting DURATION', () => {
    const v = ['BEGIN:VEVENT', 'UID:d', 'DTSTART:20260601T090000Z', 'DURATION:PT1H', 'END:VEVENT'].join('\r\n');
    const out = icsEdit.applyEdits(v, { end: '2026-06-01T11:00:00Z' });
    assert.doesNotMatch(out, /DURATION/);
    assert.match(out, /DTEND:20260601T110000Z/);
});

// ── text escaping / folding ──

test('escapeIcalText turns CR, CRLF and LF into \\n and nothing else', () => {
    assert.equal(escapeIcalText('a\r\nb\rc\nd'), 'a\\nb\\nc\\nd');
    assert.ok(!/[\r\n]/.test(escapeIcalText('x\rATTENDEE:mailto:a@b.c')));
});

test('unescapeIcalText does not read an escaped backslash + n as a newline', () => {
    const stored = escapeIcalText('C:\\new');
    assert.equal(unescapeIcalText(stored), 'C:\\new');
    assert.equal(unescapeIcalText('a\\nb\\Nc\;d\\,e'), 'a\nb\nc;d,e');
});

test('parseIcal unfolds bare-LF folded lines', () => {
    const ical = 'BEGIN:VEVENT\nUID:x\nSUMMARY:Hello\n  World\nEND:VEVENT\n';
    assert.equal(parseIcal(ical)[0].summary, 'Hello World');
});

test('foldLine never splits a surrogate pair and keeps lines within 75 octets', () => {
    const line = 'DESCRIPTION:' + 'a'.repeat(62) + '😀'.repeat(20);
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) {
        assert.ok(Buffer.byteLength(part) <= 75);
        assert.ok(!part.includes('\uFFFD'));
    }
    assert.equal(folded.replace(/\r\n /g, ''), line);
});

// ── attendee validation ──

test('readAttendeeEmails keeps plain mailboxes and drops anything else', () => {
    const v = [
        'BEGIN:VEVENT', 'UID:a',
        'ATTENDEE:mailto:ok@example.com',
        'ATTENDEE:mailto:a@example.com, b@evil.test',
        'ATTENDEE:mailto:bad address@example.com',
        'ORGANIZER:mailto:Boss@Example.com',
        'END:VEVENT'
    ].join('\r\n');
    assert.deepEqual(icsEdit.readAttendeeEmails(v).sort(), ['boss@example.com', 'ok@example.com']);
});

// ── stores ──

test('IcalTokenStore.get refuses prototype keys and non-token strings', () => {
    const dir = tmpDir('ical-proto-');
    try {
        const store = new IcalTokenStore(path.join(dir, 't.json'));
        const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'c' });
        for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'x'.repeat(64), '']) {
            assert.equal(store.get(bad), null, bad);
        }
        assert.ok(store.get(token));
        const mode = fs.statSync(path.join(dir, 't.json')).mode & 0o777;
        assert.equal(mode, 0o600);
        assert.deepEqual(fs.readdirSync(dir), ['t.json'], 'no temp file left behind');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DriveUserStore writes owner-only and keeps a corrupt file as .bak', () => {
    const dir = tmpDir('drive-store-');
    const file = path.join(dir, 'users.json');
    const warn = console.warn;
    try {
        const store = new DriveUserStore(file);
        store.set('A@x.com', { bucket: 'b', credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal(new DriveUserStore(file).get('a@x.com').bucket, 'b');

        fs.writeFileSync(file, '{"a@x.com": {"bucket"');
        console.warn = () => {};
        const reloaded = new DriveUserStore(file);
        assert.equal(reloaded.get('a@x.com'), null);
        assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{"a@x.com": {"bucket"');
    } finally {
        console.warn = warn;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── B2 client ──

function withServer(handler, fn) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', async () => {
            try { resolve(await fn(`http://127.0.0.1:${server.address().port}`)); } catch (e) { reject(e); } finally { server.close(); }
        });
    });
}

test('B2 _request rejects a non-JSON 5xx page instead of resolving it', async () => {
    await withServer((req, res) => { res.statusCode = 503; res.end('<html>Service Unavailable</html>'); }, async (base) => {
        const c = new B2Client({ keyId: 'k', applicationKey: 'a' });
        await assert.rejects(c._request(`${base}/x`), (err) => err.statusCode === 503);
    });
});

test('B2 _request rejects a non-JSON 2xx body and resolves a JSON one', async () => {
    await withServer((req, res) => {
        if (req.url === '/json') { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); return; }
        res.end('not json');
    }, async (base) => {
        const c = new B2Client({ keyId: 'k', applicationKey: 'a' });
        await assert.rejects(c._request(`${base}/text`), /non-JSON/);
        assert.deepEqual(await c._request(`${base}/json`), { ok: true });
    });
});

test('B2 _request surfaces the JSON error message and code on 4xx', async () => {
    await withServer((req, res) => { res.statusCode = 400; res.end('{"code":"bad_request","message":"nope"}'); }, async (base) => {
        const c = new B2Client({ keyId: 'k', applicationKey: 'a' });
        await assert.rejects(c._request(`${base}/x`), (err) => err.message === 'nope' && err.code === 'bad_request');
    });
});

test('B2 createKey refuses to mint a key without a bucketId', async () => {
    const c = new B2Client({ keyId: 'k', applicationKey: 'a' });
    let called = false;
    c.authorize = async () => { called = true; return { apiUrl: 'https://api.test', authorizationToken: 't', accountId: 'acct' }; };
    c._request = async () => { called = true; return {}; };
    for (const bad of [undefined, null, '', 42]) {
        await assert.rejects(c.createKey({ keyName: 'n', bucketId: bad }), /bucketId/);
    }
    assert.equal(called, false);
});

// ── Drive provisioning ──

async function driveApp(dir) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.addHook('onRequest', async (req) => {
        req.creds = { user: req.headers['x-user'], pass: 'pw', hash: 'h' };
    });
    await app.register(driveRoutes, {
        s3: {
            enabled: true,
            provider: 'b2',
            b2: { keyId: 'k', applicationKey: 'a' },
            filePath: path.join(dir, 'drive.json'),
            defaultQuotaGb: 1,
            corsOrigins: '',
            users: {}
        },
        logger: { info() {}, warn() {}, error() {} }
    });
    return app;
}

function mockB2() {
    const orig = {};
    const state = { buckets: [], keys: [], listCalls: 0 };
    for (const m of ['listBuckets', 'createBucket', 'createKey', 'getS3Endpoint', 'getBucketUsage']) orig[m] = B2Client.prototype[m];
    B2Client.prototype.listBuckets = async function () {
        state.listCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return { buckets: state.buckets };
    };
    B2Client.prototype.createBucket = async function (name) {
        const b = { bucketName: name, bucketId: `id-${name}` };
        state.buckets.push(b);
        return b;
    };
    B2Client.prototype.createKey = async function (o) {
        state.keys.push(o);
        return { applicationKeyId: `kid-${state.keys.length}`, applicationKey: 'secret' };
    };
    B2Client.prototype.getS3Endpoint = async () => ({ endpoint: 'https://s3.test', region: 'r' });
    B2Client.prototype.getBucketUsage = async () => 0;
    return { state, restore: () => Object.assign(B2Client.prototype, orig) };
}

test('drive: mailboxes whose names sanitise alike get different buckets', async () => {
    const dir = tmpDir('drive-names-');
    const mock = mockB2();
    const app = await driveApp(dir);
    try {
        const users = ['john.doe@example.com', 'john-doe@example.com', 'john_doe@example.com'];
        const buckets = [];
        for (const u of users) {
            const res = await app.inject({ method: 'GET', url: '/v1/drive/config', headers: { 'x-user': u } });
            assert.equal(res.statusCode, 200);
            buckets.push(JSON.parse(res.body).bucket);
        }
        assert.equal(new Set(buckets).size, 3, buckets.join(','));
        for (const b of buckets) assert.match(b, /^[a-z0-9][a-z0-9-]{5,49}$/);
        assert.equal(mock.state.keys.length, 3);
    } finally {
        mock.restore();
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('drive: users on a very long domain do not share a truncated bucket name', async () => {
    const dir = tmpDir('drive-long-');
    const mock = mockB2();
    const app = await driveApp(dir);
    try {
        const domain = 'a-very-long-subdomain-name.some-organisation.example.com';
        const names = [];
        for (const u of [`alice@${domain}`, `bob@${domain}`]) {
            const res = await app.inject({ method: 'GET', url: '/v1/drive/config', headers: { 'x-user': u } });
            names.push(JSON.parse(res.body).bucket);
        }
        assert.notEqual(names[0], names[1]);
        assert.ok(names.every((n) => n.length <= 50));
    } finally {
        mock.restore();
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('drive: concurrent first loads share one provisioning run', async () => {
    const dir = tmpDir('drive-race-');
    const mock = mockB2();
    const app = await driveApp(dir);
    try {
        const headers = { 'x-user': 'new@example.com' };
        const [a, b] = await Promise.all([
            app.inject({ method: 'GET', url: '/v1/drive/config', headers }),
            app.inject({ method: 'GET', url: '/v1/drive/quota', headers })
        ]);
        assert.equal(a.statusCode, 200);
        assert.equal(b.statusCode, 200);
        assert.equal(mock.state.keys.length, 1, 'one key, not one per request');
        assert.equal(mock.state.keys[0].bucketId, `id-${JSON.parse(a.body).bucket}`);
    } finally {
        mock.restore();
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('drive: a bucket response without an id never reaches createKey', async () => {
    const dir = tmpDir('drive-noid-');
    const mock = mockB2();
    B2Client.prototype.createBucket = async () => ({});
    const app = await driveApp(dir);
    try {
        const res = await app.inject({ method: 'GET', url: '/v1/drive/config', headers: { 'x-user': 'x@example.com' } });
        assert.equal(res.statusCode, 502);
        assert.equal(mock.state.keys.length, 0);
    } finally {
        mock.restore();
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── address book ──

test('normalizeContact: an explicit empty note or name clears it, an absent one keeps it', () => {
    const existing = { uid: 'u1', address: 'a@x.com', name: 'Ann', note: 'old', lastSeen: 5, count: 2 };
    const cleared = normalizeContact({ address: 'a@x.com', name: '', note: '' }, existing);
    assert.equal(cleared.note, null);
    assert.equal(cleared.name, null);
    const kept = normalizeContact({ address: 'a@x.com' }, existing);
    assert.equal(kept.note, 'old');
    assert.equal(kept.name, 'Ann');
});

test('normalizeContact: an out-of-range lastSeen cannot break the vCard message', () => {
    const c = normalizeContact({ address: 'a@x.com', lastSeen: 9e15 }, null);
    assert.equal(c.lastSeen, 0);
    const msg = buildVCardMessage({ ...c, lastSeen: 9e15 }, { uidValidity: 1, now: Date.now(), user: 'u@x.com' });
    assert.ok(msg.length > 0);
});

// ── calendar routes ──

function makeEventGrant(rec, uid) {
    const uidPart = Buffer.from(String(uid), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', rec.editKey).update(`${rec.id}:${uid}`).digest('base64url').slice(0, 27);
    return `${rec.id}.${uidPart}.${sig}`;
}

async function calendarApp(dir, smtp = null) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((err, req, reply) => {
        const status = err.statusCode || 500;
        reply.code(status).type('application/problem+json').send(err.problem || { status, detail: err.message });
    });
    await app.register(calendarRoutes, { sogoUrl: 'http://sogo-test/SOGo', dataDir: dir, smtp });
    return app;
}

function patchClient(overrides) {
    const orig = {};
    for (const [k, v] of Object.entries(overrides)) {
        orig[k] = CaldavClient.prototype[k];
        CaldavClient.prototype[k] = v;
    }
    return () => Object.assign(CaldavClient.prototype, orig);
}

test('public feed: prototype-key tokens get a 404 and never reach CalDAV', async () => {
    const dir = tmpDir('cal-proto-');
    let calls = 0;
    const restore = patchClient({ listCalendarData: async () => { calls++; return []; } });
    const app = await calendarApp(dir);
    try {
        for (const t of ['constructor', '__proto__', 'toString']) {
            const res = await app.inject({ method: 'GET', url: `/v1/public/ical/${t}.ics` });
            assert.equal(res.statusCode, 404, t);
        }
        assert.equal(calls, 0);
    } finally {
        restore();
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const RECURRING = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VTIMEZONE', 'TZID:Europe/London',
    'BEGIN:STANDARD', 'DTSTART:19701025T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:rec1@example.com',
    'DTSTART;TZID=Europe/London:20260601T090000', 'DTEND;TZID=Europe/London:20260601T100000',
    'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Weekly',
    'ATTENDEE:mailto:secret@example.com',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:ping', 'TRIGGER:-PT5M', 'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:day1@example.com', 'DTSTART;VALUE=DATE:20260610', 'DTEND;VALUE=DATE:20260611', 'SUMMARY:Holiday', 'END:VEVENT',
    'END:VCALENDAR', ''
].join('\r\n');

test('public feed: republishes RRULE, TZID and all-day dates, drops attendees and alarms, is private-cached', async () => {
    const dir = tmpDir('cal-feed-');
    const store = new IcalTokenStore(path.join(dir, 'ical-tokens.json'));
    const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
    const restore = patchClient({ listCalendarData: async () => [RECURRING] });
    const app = await calendarApp(dir);
    try {
        const res = await app.inject({ method: 'GET', url: `/v1/public/ical/${token}.ics`, headers: { host: 'cal.example.com', 'x-forwarded-proto': 'https' } });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['cache-control'], /^private/);
        const body = res.body;
        assert.match(body, /RRULE:FREQ=WEEKLY;COUNT=4/);
        assert.match(body, /DTSTART;TZID=Europe\/London:20260601T090000/);
        assert.match(body, /DTSTART;VALUE=DATE:20260610/);
        assert.match(body, /BEGIN:VTIMEZONE/);
        assert.doesNotMatch(body, /secret@example\.com/);
        assert.doesNotMatch(body, /VALARM/);
        assert.match(body, /URL:https:\/\/cal\.example\.com\/v1\/public\/event\//);
    } finally {
        restore();
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('public feed: a hostile Host header is refused, not echoed into edit links', async () => {
    const dir = tmpDir('cal-host-');
    const store = new IcalTokenStore(path.join(dir, 'ical-tokens.json'));
    const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
    const restore = patchClient({ listCalendarData: async () => [RECURRING] });
    const app = await calendarApp(dir);
    try {
        const res = await app.inject({
            method: 'GET', url: `/v1/public/ical/${token}.ics`,
            headers: { host: 'cal.example.com', 'x-forwarded-host': 'evil.test/path"><x' }
        });
        assert.equal(res.statusCode, 400);
        assert.doesNotMatch(res.body, /evil\.test/);
    } finally {
        restore();
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const TZ_EVENT = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:tz1@example.com',
    'DTSTART;TZID=Europe/London:20260601T090000', 'DTEND;TZID=Europe/London:20260601T100000',
    'SUMMARY:Standup', 'DESCRIPTION:Line one\\nLine two',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', ''
].join('\r\n');

async function editFixture(rawIcs, uid, smtp) {
    const dir = tmpDir('cal-edit-');
    const store = new IcalTokenStore(path.join(dir, 'ical-tokens.json'));
    const { token } = store.issue({ user: 'u@x.com', pass: 'p', calendar: 'personal' });
    const grant = makeEventGrant(store.get(token), uid);
    const puts = [];
    const restore = patchClient({
        getEventRaw: async () => rawIcs,
        putEventRaw: async (u, p, c, id, ical) => { puts.push(ical); return { uid: id }; }
    });
    const app = await calendarApp(dir, smtp);
    return { dir, app, grant, puts, restore, done: async () => { restore(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function form(fields) {
    return {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(fields).toString()
    };
}

test('public edit: a title-only edit leaves TZID times and the alarm untouched', async () => {
    const fx = await editFixture(TZ_EVENT, 'tz1@example.com');
    try {
        const res = await fx.app.inject({
            url: `/v1/public/event/${fx.grant}/edit`,
            ...form({ summary: 'Renamed', start: '2026-06-01T09:00', end: '2026-06-01T10:00', location: '', description: 'Line one\r\nLine two' })
        });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(fx.puts.length, 1);
        const put = fx.puts[0];
        assert.match(put, /SUMMARY:Renamed/);
        assert.match(put, /DTSTART;TZID=Europe\/London:20260601T090000/);
        assert.match(put, /DTEND;TZID=Europe\/London:20260601T100000/);
        assert.match(put, /DESCRIPTION:Reminder/);
        assert.match(put, /DESCRIPTION:Line one\\nLine two/);
        assert.doesNotMatch(put, /\r(?!\n)/, 'no stray CR');
    } finally { await fx.done(); }
});

test('public edit: a recurring TZID event can have its description edited but not its times', async () => {
    const raw = TZ_EVENT.replace('SUMMARY:Standup', 'RRULE:FREQ=DAILY\r\nSUMMARY:Standup');
    const fx = await editFixture(raw, 'tz1@example.com');
    try {
        const refused = await fx.app.inject({
            url: `/v1/public/event/${fx.grant}/edit`,
            ...form({ summary: 'Standup', start: '2026-06-01T10:00', end: '2026-06-01T11:00', location: '', description: 'Changed' })
        });
        assert.equal(refused.statusCode, 400);
        assert.match(refused.body, /repeating event/);
        assert.equal(fx.puts.length, 0);

        const ok = await fx.app.inject({
            url: `/v1/public/event/${fx.grant}/edit`,
            ...form({ summary: 'Standup', start: '2026-06-01T09:00', end: '2026-06-01T10:00', location: '', description: 'Changed' })
        });
        assert.equal(ok.statusCode, 200, ok.body);
        assert.equal(fx.puts.length, 1);
    } finally { await fx.done(); }
});

test('public edit: server-side field caps and a per-event cooldown', async () => {
    const fx = await editFixture(TZ_EVENT, 'tz1@example.com');
    try {
        const base = { summary: 'S', start: '2026-06-01T09:00', end: '2026-06-01T10:00', location: '', description: '' };
        for (const [field, len] of [['summary', 201], ['location', 301], ['description', 4001]]) {
            const res = await fx.app.inject({
                url: `/v1/public/event/${fx.grant}/edit`,
                ...form({ ...base, [field]: 'x'.repeat(len) })
            });
            assert.equal(res.statusCode, 400, field);
            assert.match(res.body, /too long/);
        }
        assert.equal(fx.puts.length, 0);

        const first = await fx.app.inject({ url: `/v1/public/event/${fx.grant}/edit`, ...form({ ...base, summary: 'One' }) });
        assert.equal(first.statusCode, 200);
        const second = await fx.app.inject({ url: `/v1/public/event/${fx.grant}/edit`, ...form({ ...base, summary: 'Two' }) });
        assert.equal(second.statusCode, 429);
        assert.ok(Number(second.headers['retry-after']) > 0);
        assert.equal(fx.puts.length, 1);
    } finally { await fx.done(); }
});

test('public edit form: labels are tied to inputs and errors announce as alerts', async () => {
    const fx = await editFixture(TZ_EVENT, 'tz1@example.com');
    try {
        const res = await fx.app.inject({ method: 'GET', url: `/v1/public/event/${fx.grant}/edit` });
        assert.equal(res.statusCode, 200);
        for (const id of ['ev-summary', 'ev-start', 'ev-end', 'ev-location', 'ev-description']) {
            assert.match(res.body, new RegExp(`<label for="${id}">`));
            assert.match(res.body, new RegExp(`id="${id}"`));
        }
        assert.match(res.body, /value="2026-06-01T09:00"/, 'zoned time renders as its wall clock');
        const bad = await fx.app.inject({ url: `/v1/public/event/${fx.grant}/edit`, ...form({ summary: '', start: '', end: '' }) });
        assert.equal(bad.statusCode, 400);
        assert.match(bad.body, /role="alert"/);
    } finally { await fx.done(); }
});

test('public edit POST carries a route-level rate limit well under the global one', async () => {
    const dir = tmpDir('cal-rl-');
    const app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(require('@fastify/rate-limit'), { max: 300, timeWindow: 60000 });
    await app.register(calendarRoutes, { sogoUrl: 'http://sogo-test/SOGo', dataDir: dir });
    try {
        const codes = [];
        for (let i = 0; i < 12; i++) {
            const res = await app.inject({ url: '/v1/public/event/nope.nope.nope/edit', ...form({ summary: 'x' }) });
            codes.push(res.statusCode);
        }
        assert.ok(codes.includes(429), codes.join(','));
        assert.equal(codes[0], 404);
    } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
