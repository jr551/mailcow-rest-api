'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { compileRulesScript, parseRules, webhookMailbox, webhookIdFromMailbox } = require('../../src/sieve-client');
const { normalizePrepend, createOutboundWebhookStore } = require('../../src/outbound-webhook-store');
const { quoteText, composeForwardedText, encodeAttachment } = require('../../src/webhook-payload');

// A stand-in for secret-box: the tests care about the store's behaviour, not
// about AES, and a reversible marker keeps the assertions readable.
const fakeBox = {
    encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
    decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
};

function freshStore() {
    return createOutboundWebhookStore({ filePath: ':memory:', secretBox: fakeBox, maxPerUser: 3 });
}

test('sieve: webhook action round-trips through compile and parse', () => {
    const rules = [{
        id: 'rule-abc123',
        name: 'Forward invoices',
        condition: { type: 'from-contains', value: 'billing@vendor.example' },
        action: { type: 'webhook', webhookId: 'deadbeefcafe' }
    }];
    const script = compileRulesScript(rules, '');
    // Parking is fileinto, not redirect — Dovecot needs the extension declared
    // and rejects a `redirect` whose argument isn't an address.
    assert.match(script, /require \[.*"fileinto".*\];/);
    assert.match(script, /fileinto "\.wh-deadbeefcafe";/);

    const parsed = parseRules(script);
    assert.strictEqual(parsed.rules.length, 1);
    // The whole point: it must come back as a webhook, not as a plain
    // fileinto into a folder that happens to be named .wh-*.
    assert.deepStrictEqual(parsed.rules[0].action, { type: 'webhook', webhookId: 'deadbeefcafe' });
    assert.strictEqual(parsed.rules[0].id, 'rule-abc123');
});

test('sieve: a webhook rule survives a second round-trip unchanged', () => {
    const rules = [{
        id: 'rule-1',
        name: 'n',
        condition: { type: 'subject-contains', value: 'x' },
        action: { type: 'webhook', webhookId: 'abc123' }
    }];
    const once = parseRules(compileRulesScript(rules, '')).rules;
    const twice = parseRules(compileRulesScript(once, '')).rules;
    assert.deepStrictEqual(twice, once);
});

test('sieve: a non-hex mailbox name is NOT mistaken for a webhook action', () => {
    // Webhook ids are generated as lowercase hex, so anything else in the
    // `.wh-` namespace is a user's own redirect to a folder that happens to
    // share the prefix. Treating it as a webhook would silently rewrite their
    // rule into one pointing at a webhook that does not exist — so the
    // namespace check is deliberately strict, and the escaping still has to
    // hold for the redirect path.
    const rules = [{
        id: 'rule-x',
        name: 'n',
        condition: { type: 'from-contains', value: 'v' },
        action: { type: 'redirect', to: '.wh-not-a-real-id' }
    }];
    const parsed = parseRules(compileRulesScript(rules, ''));
    assert.strictEqual(parsed.rules.length, 1);
    assert.deepStrictEqual(parsed.rules[0].action, { type: 'redirect', to: '.wh-not-a-real-id' });
});

test('sieve: a redirect target containing a backslash still round-trips', () => {
    // The escaping must hold for any value that reaches the script, or the
    // rule parses back differently and becomes undeletable. A backslash is
    // the realistic case (the API validates `to` as an email address, so a
    // quote cannot get here).
    const nasty = 'a\\b@example.com';
    const rules = [{
        id: 'rule-x',
        name: 'n',
        condition: { type: 'from-contains', value: 'v' },
        action: { type: 'redirect', to: nasty }
    }];
    const parsed = parseRules(compileRulesScript(rules, ''));
    assert.strictEqual(parsed.rules.length, 1);
    assert.strictEqual(parsed.rules[0].action.to, nasty);
});

test('sieve: a plain redirect is still a redirect, not a webhook', () => {
    const rules = [{
        id: 'rule-r',
        name: 'n',
        condition: { type: 'from-contains', value: 'v' },
        action: { type: 'redirect', to: 'someone@example.com' }
    }];
    const parsed = parseRules(compileRulesScript(rules, ''));
    assert.deepStrictEqual(parsed.rules[0].action, { type: 'redirect', to: 'someone@example.com' });
});

test('sieve: fileinto compiles, declares the extension, and round-trips', () => {
    const rules = [{
        id: 'rule-f',
        name: 'File receipts',
        condition: { type: 'subject-contains', value: 'receipt' },
        action: { type: 'fileinto', folder: 'Receipts' }
    }];
    const script = compileRulesScript(rules, '');
    // Dovecot rejects fileinto without the extension declared.
    assert.match(script, /require \["fileinto"\];/);
    assert.match(script, /fileinto "Receipts";/);
    const parsed = parseRules(script);
    assert.deepStrictEqual(parsed.rules[0].action, { type: 'fileinto', folder: 'Receipts' });
});

test('sieve: fileinto is not declared when no rule needs it', () => {
    const rules = [{
        id: 'rule-d',
        name: 'n',
        condition: { type: 'from-contains', value: 'v' },
        action: { type: 'discard' }
    }];
    assert.doesNotMatch(compileRulesScript(rules, ''), /fileinto/);
});

test('mailbox naming: prefix round-trips and rejects foreign names', () => {
    assert.strictEqual(webhookMailbox('abc123'), '.wh-abc123');
    assert.strictEqual(webhookIdFromMailbox('.wh-abc123'), 'abc123');
    // Not our namespace.
    assert.strictEqual(webhookIdFromMailbox('INBOX'), null);
    assert.strictEqual(webhookIdFromMailbox('.wh-'), null);
    // Uppercase or punctuation would not survive an IMAP folder round-trip.
    assert.strictEqual(webhookIdFromMailbox('.wh-ABC'), null);
    assert.strictEqual(webhookIdFromMailbox('.wh-a b'), null);
});

test('prepend: CR/LF is stripped so a preamble cannot forge a header', () => {
    assert.strictEqual(normalizePrepend('hello\r\nBcc: evil@example.com'), 'hello Bcc: evil@example.com');
    assert.strictEqual(normalizePrepend('  spaced  '), 'spaced');
    assert.strictEqual(normalizePrepend(null), '');
    assert.strictEqual(normalizePrepend(undefined), '');
    assert.strictEqual(normalizePrepend(42), '');
});

test('prepend: an over-long value is capped', () => {
    const long = 'x'.repeat(10_000);
    assert.strictEqual(normalizePrepend(long).length, 4000);
});

test('compose: with no prepend the original text is returned untouched', () => {
    const original = 'line one\nline two\n\nline four';
    // Not quoted: a receiver that asked for no preamble is getting the raw
    // message and must not have to strip markers back out.
    assert.strictEqual(composeForwardedText({ prepend: '', text: original }), original);
    assert.strictEqual(composeForwardedText({ prepend: '   ', text: original }), original);
});

test('compose: with a prepend the original is quoted underneath', () => {
    const out = composeForwardedText({
        prepend: 'You are an invoicing agent. Extract the total.',
        text: 'line one\n\nline three'
    });
    assert.strictEqual(
        out,
        'You are an invoicing agent. Extract the total.\n\n> line one\n>\n> line three'
    );
});

test('compose: quoting marks blank lines with a bare marker', () => {
    assert.strictEqual(quoteText('a\n\nb'), '> a\n>\n> b');
    assert.strictEqual(quoteText(''), '');
});

test('attachments: base64-of-gzip round-trips to the original bytes exactly', () => {
    const original = Buffer.from('name,amount\nwidget,12.50\n', 'utf8');
    const enc = encodeAttachment(original);
    assert.strictEqual(enc.encoding, 'base64+gzip');
    assert.strictEqual(enc.compressedBytes, Buffer.from(enc.content, 'base64').length);
    // The receiver's documented recovery path must actually work.
    const recovered = zlib.gunzipSync(Buffer.from(enc.content, 'base64'));
    assert.deepStrictEqual(recovered, original);
    assert.match(enc.instructions, /gunzip/i);
});

test('attachments: binary content round-trips too', () => {
    const original = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00]);
    const enc = encodeAttachment(original);
    assert.deepStrictEqual(zlib.gunzipSync(Buffer.from(enc.content, 'base64')), original);
});

test('store: create returns the secret once and never lists it', () => {
    const store = freshStore();
    const created = store.create({
        user: 'a@example.com',
        password: 'pw',
        label: 'Invoices',
        url: 'https://example.com/hook',
        keep: true,
        prepend: 'ctx'
    });
    assert.ok(created.secret, 'secret returned at creation');
    assert.strictEqual(created.mailbox, `.wh-${created.id}`);
    assert.strictEqual(created.keep, true);
    assert.strictEqual(created.prepend, 'ctx');

    const listed = store.list({ user: 'a@example.com' });
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].secret, undefined, 'secret must not be listed');
    store.close();
});

test('store: the mailbox password is encrypted at rest and only exposed to the forwarder', () => {
    const store = freshStore();
    const created = store.create({
        user: 'a@example.com', password: 'hunter2', label: 'L', url: 'https://example.com/h'
    });
    // Public shape must never carry it.
    assert.strictEqual(store.get({ id: created.id, user: 'a@example.com' }).password, undefined);
    // The forwarder path is the only one that decrypts it.
    const live = store.listAllLive();
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].password, 'hunter2');
    store.close();
});

test('store: refreshSecrets re-keys the stored password', () => {
    const store = freshStore();
    store.create({ user: 'a@example.com', password: 'old', label: 'L', url: 'https://example.com/h' });
    assert.strictEqual(store.listAllLive()[0].password, 'old');
    const n = store.refreshSecrets({ user: 'a@example.com', password: 'new' });
    assert.strictEqual(n, 1);
    assert.strictEqual(store.listAllLive()[0].password, 'new');
    store.close();
});

test('store: update changes label/keep/prepend but not the url', () => {
    const store = freshStore();
    const created = store.create({
        user: 'a@example.com', password: 'pw', label: 'Old', url: 'https://example.com/h', keep: false
    });
    const updated = store.update({
        id: created.id, user: 'a@example.com', label: 'New', keep: true, prepend: 'hi'
    });
    assert.strictEqual(updated.label, 'New');
    assert.strictEqual(updated.keep, true);
    assert.strictEqual(updated.prepend, 'hi');
    assert.strictEqual(updated.url, 'https://example.com/h');
    store.close();
});

test('store: another user cannot read, update or revoke your webhook', () => {
    const store = freshStore();
    const created = store.create({
        user: 'a@example.com', password: 'pw', label: 'L', url: 'https://example.com/h'
    });
    assert.strictEqual(store.get({ id: created.id, user: 'b@example.com' }), null);
    assert.strictEqual(store.update({ id: created.id, user: 'b@example.com', label: 'x' }), null);
    assert.strictEqual(store.revoke({ id: created.id, user: 'b@example.com' }), 0);
    // Still intact for the owner.
    assert.ok(store.get({ id: created.id, user: 'a@example.com' }));
    store.close();
});

test('store: revoking removes it from the forwarder list', () => {
    const store = freshStore();
    const created = store.create({
        user: 'a@example.com', password: 'pw', label: 'L', url: 'https://example.com/h'
    });
    assert.strictEqual(store.listAllLive().length, 1);
    store.revoke({ id: created.id, user: 'a@example.com' });
    assert.strictEqual(store.listAllLive().length, 0);
    store.close();
});

test('store: the per-user limit is enforced', () => {
    const store = freshStore();
    for (let i = 0; i < 3; i++) {
        store.create({ user: 'a@example.com', password: 'pw', label: `L${i}`, url: 'https://example.com/h' });
    }
    assert.throws(
        () => store.create({ user: 'a@example.com', password: 'pw', label: 'L4', url: 'https://example.com/h' }),
        /limit reached/i
    );
    // A different user is unaffected.
    store.create({ user: 'b@example.com', password: 'pw', label: 'L', url: 'https://example.com/h' });
    store.close();
});
