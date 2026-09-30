'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createTakeoverStore } = require('../../src/takeover-store');
const {
    createTakeoverWorker,
    automatedReason,
    finalizeReply,
    unbackedFigures,
    parseDraft,
    parseClassify,
    TAKEOVER_CLASSIFY_SYSTEM,
    TAKEOVER_REPLY_SYSTEM,
    DISCLOSURE
} = require('../../src/takeover-worker');

// A stand-in for secret-box: these tests are about the worker's decisions,
// not about AES. A reversible marker keeps the assertions readable.
const fakeBox = {
    encrypt: (v) => (v === null || v === undefined ? v : `enc:${v}`),
    decrypt: (v) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)
};

const USER = 'john@example.com';
const T0 = Date.parse('2026-09-30T12:00:00Z');
const MINUTE = 60 * 1000;

function textPartOf(text) {
    return {
        part: '1',
        type: 'text/plain',
        disposition: '',
        childNodes: [],
        size: text.length
    };
}

// A fake ImapFlow good enough for the worker's own calls: search, fetchOne
// and download. The real worker code runs against it unchanged — the seam is
// withClient, exactly one function.
function makeImap(messages) {
    return {
        async getMailboxLock() {
            return { release() {} };
        },
        async search() {
            return messages.map((m) => m.uid);
        },
        async fetchOne(uid) {
            const m = messages.find((x) => String(x.uid) === String(uid));
            return m ? m.msg : null;
        },
        async download(uid) {
            const m = messages.find((x) => String(x.uid) === String(uid));
            const text = (m && m.body) || '';
            return {
                content: (async function* () { yield Buffer.from(text); })()
            };
        }
    };
}

function humanMessage(overrides = {}) {
    return {
        uid: 1,
        body: 'Hi John,\n\nCan you confirm the delivery date for order 4471?\n\nThanks,\nAlice',
        msg: {
            uid: 1,
            envelope: {
                from: [{ name: 'Alice Smith', address: 'alice@vendor.example' }],
                replyTo: [{ name: 'Alice Smith', address: 'alice@vendor.example' }],
                to: [{ address: USER }],
                subject: 'Delivery date for order 4471',
                date: new Date(T0 - 10 * MINUTE),
                messageId: '<m1@vendor.example>',
                inReplyTo: null
            },
            headers: '',
            bodyStructure: textPartOf('x')
        },
        ...overrides
    };
}

// Build a worker wired to fakes. `drafts` is the queue of draft answers the
// model gives; classification is controlled separately so a test can say
// "this one needs a reply" without also writing a reply.
function makeEnv({ messages = [], classify, drafts = [], storePath = ':memory:', store = null, maxPerHour } = {}) {
    const calls = { llm: [], deliver: [] };
    const state = { now: T0 };
    const imap = makeImap(messages);

    const liveStore = store || createTakeoverStore({
        filePath: storePath,
        secretBox: fakeBox,
        defaults: maxPerHour === undefined ? {} : { maxRepliesPerHour: maxPerHour }
    });
    liveStore.set(USER, { enabled: true });

    const draftQueue = Array.isArray(drafts) ? [...drafts] : [drafts];

    const worker = createTakeoverWorker({
        config: {
            takeover: {
                enabled: true,
                pollIntervalMs: 60 * MINUTE,
                maxCandidatesPerTick: 20,
                maxThreadChars: 12_000
            },
            ai: {}
        },
        store: liveStore,
        cache: {
            listActiveSessions: () => [{ user: USER, pass: 'pw', hash: 'hash', expires_at: state.now + 3600_000 }]
        },
        pool: {},
        logger: null,
        clock: () => state.now,
        resolveProvider: () => ({ kind: 'openai', model: 'test', apiKey: 'k', timeoutMs: 5000, maxInputChars: 50_000 }),
        withClient: (pool, creds, fn) => fn(imap),
        llm: async (args) => {
            calls.llm.push(args);
            if (args.system === TAKEOVER_CLASSIFY_SYSTEM) {
                const answer = typeof classify === 'function' ? classify(args) : (classify || { needsReply: true, reason: 'a question was asked' });
                return { ok: true, content: JSON.stringify(answer) };
            }
            assert.strictEqual(args.system, TAKEOVER_REPLY_SYSTEM);
            const next = draftQueue.length > 1 ? draftQueue.shift() : draftQueue[0];
            return { ok: true, content: next };
        },
        deliver: async (payload) => {
            calls.deliver.push(payload);
            return { pendingApproval: true, token: 'tok' };
        }
    });

    return {
        worker,
        store: liveStore,
        calls,
        imap,
        advance(ms) { state.now += ms; },
        now: () => state.now,
        drafts() {
            return calls.deliver.map((c) => c.message);
        }
    };
}

// --------------------------------------------------------------------------
// Rule: one reply per hour.
// --------------------------------------------------------------------------

test('rate limit: the second reply in an hour is held back, and released when the hour passes', async () => {
    const env = makeEnv({
        messages: [
            humanMessage({ uid: 1, msg: { ...humanMessage().msg, envelope: { ...humanMessage().msg.envelope, messageId: '<m1@x>' } } }),
            humanMessage({ uid: 2, body: 'What colour would you like?', msg: {
                uid: 2,
                envelope: {
                    from: [{ name: 'Bob', address: 'bob@vendor.example' }],
                    replyTo: [{ address: 'bob@vendor.example' }],
                    to: [{ address: USER }],
                    subject: 'Colour',
                    date: new Date(T0 - 10 * MINUTE),
                    messageId: '<m2@x>',
                    inReplyTo: null
                },
                headers: '',
                bodyStructure: textPartOf('x')
            } })
        ],
        drafts: 'REPLY:\nThat works for me.\n'
    });

    await env.worker.tick();

    assert.strictEqual(env.calls.deliver.length, 1, 'exactly one draft is put up for approval per hour');
    assert.strictEqual(env.store.repliesSince(USER, env.now() - 60 * MINUTE), 1);

    const held = env.store.recentDecisions(USER, 50).find((d) => d.messageId === 'm2@x' && d.decision === 'rate-limited');
    assert.ok(held, 'the held-back message is explained in the audit trail');
    assert.match(held.reason, /per hour/i);
    assert.ok(!env.store.wasProcessed(USER, 'm2@x'), 'a rate-limited message is not marked done — it is queued');

    // Same hour, same limit.
    env.advance(30 * MINUTE);
    await env.worker.tick();
    assert.strictEqual(env.calls.deliver.length, 1, 'still held back inside the same hour');

    // Hour over: the queued message goes out.
    env.advance(31 * MINUTE);
    await env.worker.tick();
    assert.strictEqual(env.calls.deliver.length, 2, 'released once the hour has passed');
});

test('rate limit: a draft that stopped for a missing fact does not use up the slot', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: ['NEEDS INPUT:\n- the delivery date', 'REPLY:\nIt arrives on 14 October.\n']
    });

    await env.worker.tick();
    assert.strictEqual(env.calls.deliver.length, 0);
    assert.strictEqual(env.store.repliesSince(USER, env.now() - 60 * MINUTE), 0, 'nothing was handed to the approval gate');

    // John supplies the fact; the reply still goes out inside the same hour.
    const item = env.store.listNeedsInput(USER)[0];
    env.store.resolveNeedsInput(USER, item.id, 'It arrives on 14 October');
    await env.worker.tick();

    assert.strictEqual(env.calls.deliver.length, 1, 'the resumed draft is not blocked by the hourly limit');
});

// --------------------------------------------------------------------------
// Rule: five minute minimum delay.
// --------------------------------------------------------------------------

test('delay: nothing is drafted until the message has been waiting five minutes', async () => {
    const env = makeEnv({
        messages: [humanMessage({
            uid: 1,
            msg: {
                uid: 1,
                envelope: {
                    from: [{ address: 'alice@vendor.example' }],
                    replyTo: [{ address: 'alice@vendor.example' }],
                    to: [{ address: USER }],
                    subject: 'Quick question',
                    date: new Date(T0 - MINUTE), // one minute old
                    messageId: '<d1@x>',
                    inReplyTo: null
                },
                headers: '',
                bodyStructure: textPartOf('x')
            }
        })],
        drafts: 'REPLY:\nFine by me.\n'
    });

    await env.worker.tick();

    assert.strictEqual(env.calls.deliver.length, 0, 'the delay is enforced before any draft is made');
    assert.strictEqual(env.calls.llm.length, 0, 'and before the model is even asked');
    const held = env.store.recentDecisions(USER, 50).find((d) => d.decision === 'delayed');
    assert.ok(held, 'the delay is explained rather than silent');
    assert.match(held.reason, /minimum 5-minute delay/i);
    assert.ok(!env.store.wasProcessed(USER, 'd1@x'), 'a deferred message is not marked done');

    env.advance(5 * MINUTE);
    await env.worker.tick();
    assert.strictEqual(env.calls.deliver.length, 1, 'once the delay has passed the reply is drafted');
});

// --------------------------------------------------------------------------
// Rule: a missing fact is a question, never a guess.
// --------------------------------------------------------------------------

test('missing fact: the assistant asks instead of drafting', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: 'NEEDS INPUT:\n- the delivery date for order 4471\n- whether it can arrive before the 14th'
    });

    await env.worker.tick();

    assert.strictEqual(env.calls.deliver.length, 0, 'no draft is created when a fact is missing');
    const items = env.store.listNeedsInput(USER);
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].missing, [
        'the delivery date for order 4471',
        'whether it can arrive before the 14th'
    ]);
    assert.match(items[0].reason, /Nothing was drafted and nothing was sent/);
    assert.ok(!env.store.wasProcessed(USER, 'm1@vendor.example'), 'it stays open until John answers');
});

test('missing fact: a figure invented by the model becomes a question, not a draft', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        // The thread never mentions a price. A reply that quotes one is
        // guessing at it.
        drafts: 'REPLY:\nNo problem — the total comes to £45 and it ships Friday.\n'
    });

    await env.worker.tick();

    assert.strictEqual(env.calls.deliver.length, 0, 'an invented figure is never handed to the approval gate');
    const items = env.store.listNeedsInput(USER);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].missing.length, 1);
    assert.match(items[0].missing[0], /£45/);
    assert.match(items[0].reason, /appears nowhere in the message thread/);
});

test('missing fact: a figure that is already established is not treated as invented', () => {
    // In the thread or in John's own instruction, a figure is backed and the
    // reply may use it.
    assert.deepStrictEqual(
        unbackedFigures('Order 4471 ships on 14 October and the total is £45.', 'order 4471 ... the total is £45'),
        []
    );
    // In neither, it is a guess and must become a question.
    assert.deepStrictEqual(unbackedFigures('That will be £99.', 'order 4471'), ['£99']);
    // A plain count is not the kind of fact this is about.
    assert.deepStrictEqual(unbackedFigures('I have asked 2 people.', 'nothing here'), []);
});

test('resume with advice: the answer is fed into the next draft and still goes to approval', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: ['NEEDS INPUT:\n- the delivery date', 'REPLY:\nIt arrives on 14 October.\n']
    });

    await env.worker.tick();
    const item = env.store.listNeedsInput(USER)[0];
    env.store.resolveNeedsInput(USER, item.id, 'Tell him it arrives on 14 October and there is no charge');

    await env.worker.tick();

    assert.strictEqual(env.calls.deliver.length, 1, 'the resumed reply still goes through the approval gate');
    const prompt = env.calls.llm.filter((c) => c.system === TAKEOVER_REPLY_SYSTEM).pop().userPrompt;
    assert.match(prompt, /Owner's instructions \(verbatim, from the owner himself\):/);
    assert.match(prompt, /arrives on 14 October and there is no charge/);
    assert.ok(env.store.wasProcessed(USER, 'm1@vendor.example'), 'once drafted it is never looked at again');
});

// --------------------------------------------------------------------------
// Rule: automated mail is never drafted for.
// --------------------------------------------------------------------------

test('automated senders are skipped outright, with no model call at all', async () => {
    const cases = [
        ['no-reply@shop.example', 'Your receipt from the shop', ''],
        ['donotreply@list.example', 'Weekly digest', ''],
        ['mailer-daemon@vendor.example', 'Undelivered Mail Returned to Sender', ''],
        ['bob@vendor.example', 'Your order confirmation', ''],
        ['bob@vendor.example', 'Out of Office: back on Monday', ''],
        ['bob@vendor.example', 'Delivery Status Notification (Failure)', ''],
        ['alice@vendor.example', 'Question about the invoice', 'list-id: invoices.list.example'],
        ['alice@vendor.example', 'Lunch?', 'precedence: bulk'],
        ['alice@vendor.example', 'Ping', 'auto-submitted: auto-replied']
    ];

    for (const [from, subject, headers] of cases) {
        const env = makeEnv({
            messages: [{
                uid: 1,
                body: 'body',
                msg: {
                    uid: 1,
                    envelope: {
                        from: [{ address: from }],
                        replyTo: [{ address: from }],
                        to: [{ address: USER }],
                        subject,
                        date: new Date(T0 - 10 * MINUTE),
                        messageId: `<${from}-${subject.length}@x>`,
                        inReplyTo: null
                    },
                    headers,
                    bodyStructure: textPartOf('x')
                }
            }],
            drafts: 'REPLY:\nSure.\n'
        });

        await env.worker.tick();

        assert.strictEqual(env.calls.deliver.length, 0, `must not draft for ${from} / "${subject}"`);
        assert.strictEqual(env.calls.llm.length, 0, `must not even ask the model about ${from} / "${subject}"`);
        assert.ok(
            env.store.wasProcessed(USER, `${from}-${subject.length}@x`),
            `must record a terminal outcome for ${from} / "${subject}"`
        );
    }
});

test('a real person with a real question is never mistaken for automation', () => {
    assert.strictEqual(automatedReason({ from: { address: 'alice@vendor.example', name: 'Alice' }, subject: 'Question about the order', headers: {} }), null);
    assert.strictEqual(automatedReason({ from: { address: 'robert@vendor.example', name: 'Robert' }, subject: 'Re: our chat', headers: {} }), null);
    assert.ok(automatedReason({ from: { address: 'noreply@vendor.example' }, subject: 'x', headers: {} }));
});

// --------------------------------------------------------------------------
// Rule: a restart never re-drafts.
// --------------------------------------------------------------------------

test('restart: a second worker on the same database does not draft again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
    const dbPath = path.join(dir, 'takeover.db');

    const first = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes, that works.\n', storePath: dbPath });
    await first.worker.tick();
    assert.strictEqual(first.calls.deliver.length, 1);
    assert.strictEqual(first.store.repliesSince(USER, first.now() - 60 * MINUTE), 1);
    first.store.close();

    // A fresh store and a fresh worker, exactly what a process restart gives.
    const second = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes, that works.\n', storePath: dbPath });

    // Straight after the restart the hourly limit is still holding too.
    await second.worker.tick();
    assert.strictEqual(second.calls.deliver.length, 0);

    // Well past the hour, so the rate limit cannot be what stops it: only the
    // record of what has already been handled stands between this and a
    // second copy of the same reply. That is the assertion that proves the
    // rule rather than a neighbouring one.
    second.advance(2 * 60 * MINUTE);
    await second.worker.tick();
    await second.worker.tick();

    assert.strictEqual(second.calls.deliver.length, 0, 'the message was already handled and is not drafted twice');
    assert.ok(second.store.wasProcessed(USER, 'm1@vendor.example'), 'the outcome survived the restart');
    second.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('restart: a message stopped for input is not drafted again on the next poll', async () => {
    const env = makeEnv({ messages: [humanMessage()], drafts: 'NEEDS INPUT:\n- the delivery date' });

    await env.worker.tick();
    await env.worker.tick();
    await env.worker.tick();

    assert.strictEqual(env.store.listNeedsInput(USER).length, 1, 'one question, not one per poll');
    assert.strictEqual(env.calls.llm.filter((c) => c.system === TAKEOVER_REPLY_SYSTEM).length, 1, 'and one draft attempt');
});

// --------------------------------------------------------------------------
// The disclosure, and the fact that nothing is sent.
// --------------------------------------------------------------------------

test('the reply ends with the one-line sign-off and carries no extra AI banner', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: 'REPLY:\nIt arrives on 14 October.\n'
    });
    await env.worker.tick();

    const text = env.drafts()[0].text;
    assert.ok(text.endsWith(DISCLOSURE), 'the sign-off is the last thing in the message');
    assert.strictEqual(text.match(/This reply came from my AI assistant\./g).length, 1, 'and it appears exactly once');
    assert.strictEqual(DISCLOSURE, '-- \nThis reply came from my AI assistant.');
    assert.ok(!/generated by (an )?(artificial intelligence|ai)/i.test(text), 'no verbose disclaimer banner');
    assert.ok(!/may contain (errors|mistakes)/i.test(text), 'no hedging boilerplate');
});

test('the sign-off is appended exactly once even when the model writes its own', () => {
    const one = finalizeReply('Short answer.\n\n-- \nThis reply came from my AI assistant.');
    assert.strictEqual(one.match(/This reply came from my AI assistant\./g).length, 1);
    assert.ok(one.endsWith(DISCLOSURE));
});

test('a draft that cannot be delivered is not recorded as sent', async () => {
    const env = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes.\n' });
    // The deliver seam is the only exit; if it fails, nothing left.
    const broken = createTakeoverWorker({
        config: { takeover: { enabled: true }, ai: {} },
        store: env.store,
        cache: { listActiveSessions: () => [{ user: USER, pass: 'pw', hash: 'hash', expires_at: env.now() + 3600_000 }] },
        pool: {},
        clock: () => env.now(),
        resolveProvider: () => ({ kind: 'openai', model: 'test', apiKey: 'k', timeoutMs: 5000, maxInputChars: 50_000 }),
        withClient: (p, c, fn) => fn(env.imap),
        llm: async (args) => (args.system === TAKEOVER_CLASSIFY_SYSTEM
            ? { ok: true, content: '{"needsReply":true,"reason":"a question"}' }
            : { ok: true, content: 'REPLY:\nYes.\n' }),
        deliver: async () => { throw new Error('connection refused'); }
    });

    await broken.tick();

    assert.strictEqual(env.store.repliesSince(USER, env.now() - 60 * MINUTE), 0, 'nothing is counted as sent');
    assert.ok(!env.store.wasProcessed(USER, 'm1@vendor.example'), 'and the message is not marked done');
    const items = env.store.listNeedsInput(USER);
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].missing, [], 'a block is not a question about facts');
    assert.match(items[0].reason, /approval request could not be created/);
    assert.match(items[0].reason, /Nothing was sent/);
});

test('the worker refuses to start without a deliver function when the feature is on', () => {
    assert.throws(() => createTakeoverWorker({
        config: { takeover: { enabled: true } },
        store: { get: () => ({}) },
        cache: {},
        pool: {}
    }), /deliver is required/);
});

test('nothing is delivered for a user who has not switched takeover on', async () => {
    const env = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes.\n' });
    env.store.set(USER, { enabled: false });
    await env.worker.tick();
    assert.strictEqual(env.calls.deliver.length, 0);
    assert.strictEqual(env.calls.llm.length, 0);
});

test('a paused user (0 replies per hour) never gets a draft', async () => {
    const env = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes.\n' });
    env.store.set(USER, { maxRepliesPerHour: 0 });
    await env.worker.tick();
    assert.strictEqual(env.calls.deliver.length, 0);
    assert.strictEqual(env.calls.llm.length, 0);
});

// --------------------------------------------------------------------------
// Parsing and prompt-contract helpers.
// --------------------------------------------------------------------------

test('a NEEDS INPUT answer is never read as a reply, even if it also contains one', () => {
    const parsed = parseDraft('NEEDS INPUT:\n- the delivery date\n\nREPLY:\nIt ships tomorrow.');
    assert.strictEqual(parsed.needsInput, true);
    assert.deepStrictEqual(parsed.missing, ['the delivery date']);
});

test('classifier answers that cannot be read are a block, not a guess', () => {
    assert.strictEqual(parseClassify('I think so'), null);
    assert.deepStrictEqual(parseClassify('{"needsReply":false,"reason":"newsletter"}'), { needsReply: false, reason: 'newsletter' });
});

test('the reply prompt states the rules the feature is judged on', () => {
    for (const must of [
        'NEVER invent facts',
        'NEEDS INPUT:',
        'This reply came from my AI assistant.',
        'The recipient is a real person',
        'No tells',
        'Never say you have done something',
        'you never send anything'
    ]) {
        assert.ok(TAKEOVER_REPLY_SYSTEM.includes(must), `prompt must say: ${must}`);
    }
    // The rate limit and the delay are enforced in code before the model is
    // asked anything, so the prompt is never the thing standing between the
    // owner and a second reply in an hour.
    assert.ok(!TAKEOVER_REPLY_SYSTEM.includes('one reply per hour'));
});

test('figures are only flagged when they are the kind of fact that matters', () => {
    assert.deepStrictEqual(unbackedFigures('See you at 14:30 tomorrow.', 'nothing here'), ['14:30']);
    assert.deepStrictEqual(unbackedFigures('See you tomorrow.', 'nothing here'), []);
    assert.deepStrictEqual(unbackedFigures('I have asked 2 people.', 'nothing here'), []);
    assert.deepStrictEqual(unbackedFigures('Refund of £1,200 issued.', 'nothing here'), ['£1,200']);
    assert.deepStrictEqual(unbackedFigures('Refund of £1,200 issued.', 'the refund is £1,200'), []);
});
