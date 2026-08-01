'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scrubText, scrubMessages } = require('../../src/secret-scrub');

const scrub = (s) => scrubText(s, {});

test('removes vendor API keys and tokens', () => {
    // Fixtures are assembled at runtime so no secret-shaped literal ever
    // sits in the source. A test for a redactor is the last place that
    // should trip a secret scanner — or contain a real key by accident.
    const fake = {
        openai: 'sk-' + 'A0'.repeat(16),
        github: 'ghp_' + 'B1'.repeat(12),
        aws: 'AKIA' + 'C2'.repeat(8),
        stripe: 'sk_' + 'live_' + 'D3'.repeat(12),
        slack: 'xoxb-' + '4'.repeat(12) + '-' + 'e5'.repeat(8)
    };
    const cases = [
        `here is the key ${fake.openai} use it`,
        `token ${fake.github} done`,
        `aws ${fake.aws} here`,
        `stripe ${fake.stripe} ok`,
        `slack ${fake.slack} fine`
    ];
    for (const c of cases) {
        const out = scrub(c);
        assert.match(out, /\[redacted:/, `not redacted: ${c}`);
        // The surrounding words must survive — the model still needs context.
        assert.match(out, /here|done|ok|fine/);
    }
});

test('removes JWTs and private key blocks', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    assert.equal(scrub(`auth ${jwt} end`).includes(jwt), false);

    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...secretbody...\n-----END RSA PRIVATE KEY-----';
    const out = scrub(`key:\n${pem}\nthanks`);
    assert.equal(out.includes('secretbody'), false);
    assert.match(out, /thanks/);
});

test('removes labelled credentials but keeps the label', () => {
    assert.equal(scrub('Your password is hunter2ABC'), 'Your password is [redacted]');
    assert.equal(scrub('passwd=Tr0ub4dor&3'), 'passwd=[redacted]');
    assert.equal(scrub('One-time code: 884213'), 'One-time code: [redacted]');
    // The label survives so the summary can still say what kind of thing
    // was in the mail.
    assert.match(scrub('API key: abcd1234efgh5678'), /API key: \[redacted\]/);
});

test('leaves ordinary prose about credentials alone', () => {
    // The word appearing in a sentence is not an assignment, and mangling
    // normal text is how a redactor gets switched off.
    const prose = 'Please reset your password before Friday, the security code review is due.';
    assert.equal(scrub(prose), prose);
    assert.equal(scrub('I forgot my password again'), 'I forgot my password again');
});

test('leaves placeholder values alone', () => {
    for (const p of ['password: ********', 'password: unchanged', 'pin: n/a']) {
        assert.equal(scrub(p), p);
    }
});

test('redacts credentials embedded in URLs but keeps the host', () => {
    const out = scrub('clone https://alice:s3cretpw@git.example.com/repo.git now');
    assert.equal(out.includes('s3cretpw'), false);
    assert.match(out, /alice:\[redacted:password\]@git\.example\.com/);
});

test('redacts card numbers only when they pass Luhn', () => {
    // A real test card number.
    assert.match(scrub('card 4242 4242 4242 4242 charged'), /\[redacted:card-number\]/);
    // An order reference of similar length must survive — this is the case
    // that makes an over-eager digit rule unusable on real mail.
    const order = 'your order 7031897255101234 is confirmed';
    assert.equal(scrub(order), order);
});

test('scrubMessages walks string and multimodal content', () => {
    const { messages, redacted, counts } = scrubMessages([
        { role: 'system', content: 'You summarise mail.' },
        { role: 'user', content: 'password is Sup3rSecret!' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'key sk-abcdefghijklmnop123456' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ]
        }
    ]);

    assert.equal(messages[0].content, 'You summarise mail.', 'untouched text must be identical');
    assert.equal(messages[1].content, 'password is [redacted]');
    assert.equal(messages[2].content[0].text.includes('sk-abcdefghijklmnop123456'), false);
    // Non-text parts pass through untouched.
    assert.equal(messages[2].content[1].image_url.url, 'data:image/png;base64,AAAA');
    assert.ok(redacted >= 2);
    assert.ok(Object.keys(counts).length >= 1);
});

test('scrubMessages does not mutate the caller\'s array', () => {
    const original = [{ role: 'user', content: 'password is abcd1234' }];
    const copy = JSON.parse(JSON.stringify(original));
    scrubMessages(original);
    assert.deepEqual(original, copy);
});
