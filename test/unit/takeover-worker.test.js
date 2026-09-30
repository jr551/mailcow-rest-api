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
// "this one needs a reply" without also writing a reply. `rules` lists the
// per-sender patterns the store starts with — the assistant only looks at
// mail from a sender a rule covers, and the human sender below is the one
// most tests exercise.
function makeEnv({ messages = [], classify, drafts = [], storePath = ':memory:', store = null, maxPerHour, rules = ['alice@vendor.example'], config = {} } = {}) {
    const calls = { llm: [], deliver: [], send: [] };
    const state = { now: T0 };
    const imap = makeImap(messages);

    const liveStore = store || createTakeoverStore({
        filePath: storePath,
        secretBox: fakeBox,
        defaults: maxPerHour === undefined ? {} : { maxRepliesPerHour: maxPerHour }
    });
    liveStore.set(USER, { enabled: true });
    for (const pattern of rules) {
        // Idempotent: the restart tests build a second worker on the same
        // database, where the first worker's rules already exist.
        if (!liveStore.findSenderRule(USER, pattern)) {
            liveStore.addSender(USER, { pattern });
        }
    }

    const draftQueue = Array.isArray(drafts) ? [...drafts] : [drafts];

    const worker = createTakeoverWorker({
        config: {
            takeover: {
                enabled: true,
                pollIntervalMs: 60 * MINUTE,
                maxCandidatesPerTick: 20,
                maxThreadChars: 12_000,
                ...config
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
        },
        // The direct-send seam. Present here so the default environment
        // exercises the auto-send path a wired deployment gets; tests that
        // want the approval gate either turn the sender rule's autoSend off
        // or build a worker without this dep.
        send: async (payload) => {
            calls.send.push(payload);
            return { sent: true, messageId: `<sent-${calls.send.length}@test.example>` };
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
        },
        sends() {
            return calls.send.map((c) => c.message);
        }
    };
}

// --------------------------------------------------------------------------
// Rule: one reply per hour.
// --------------------------------------------------------------------------

test('rate limit: the second reply in an hour is held back, and released when the hour passes', async () => {
    const env = makeEnv({
        rules: ['alice@vendor.example', 'bob@vendor.example'],
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

    assert.strictEqual(env.calls.send.length, 1, 'exactly one confident reply goes out per hour (auto-send)');
    assert.strictEqual(env.calls.deliver.length, 0, 'nothing is parked in the approval queue');
    assert.strictEqual(env.store.repliesSince(USER, env.now() - 60 * MINUTE), 1, 'the direct send uses the hourly slot');

    const held = env.store.recentDecisions(USER, 50).find((d) => d.messageId === 'm2@x' && d.decision === 'rate-limited');
    assert.ok(held, 'the held-back message is explained in the audit trail');
    assert.match(held.reason, /per hour/i);
    assert.ok(!env.store.wasProcessed(USER, 'm2@x'), 'a rate-limited message is not marked done — it is queued');

    // Same hour, same limit.
    env.advance(30 * MINUTE);
    await env.worker.tick();
    assert.strictEqual(env.calls.send.length, 1, 'still held back inside the same hour');

    // Hour over: the queued message goes out.
    env.advance(31 * MINUTE);
    await env.worker.tick();
    assert.strictEqual(env.calls.send.length, 2, 'released once the hour has passed');
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

    assert.strictEqual(env.calls.send.length, 1, 'the resumed reply is not blocked by the hourly limit');
    assert.strictEqual(env.calls.deliver.length, 0);
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

    assert.strictEqual(env.calls.send.length, 0, 'the delay is enforced before any draft is made');
    assert.strictEqual(env.calls.deliver.length, 0);
    assert.strictEqual(env.calls.llm.length, 0, 'and before the model is even asked');
    const held = env.store.recentDecisions(USER, 50).find((d) => d.decision === 'delayed');
    assert.ok(held, 'the delay is explained rather than silent');
    assert.match(held.reason, /minimum 5-minute delay/i);
    assert.ok(!env.store.wasProcessed(USER, 'd1@x'), 'a deferred message is not marked done');

    env.advance(5 * MINUTE);
    await env.worker.tick();
    assert.strictEqual(env.calls.send.length, 1, 'once the delay has passed the reply is drafted and sent');
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

test('resume with advice: the answer is fed into the next draft and still goes out on the auto-send path', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: ['NEEDS INPUT:\n- the delivery date', 'REPLY:\nIt arrives on 14 October.\n']
    });

    await env.worker.tick();
    const item = env.store.listNeedsInput(USER)[0];
    env.store.resolveNeedsInput(USER, item.id, 'Tell him it arrives on 14 October and there is no charge');

    await env.worker.tick();

    assert.strictEqual(env.calls.send.length, 1, 'the resumed reply follows the normal routing');
    assert.strictEqual(env.calls.deliver.length, 0);
    const prompt = env.calls.llm.filter((c) => c.system === TAKEOVER_REPLY_SYSTEM).pop().userPrompt;
    assert.match(prompt, /Owner's instructions for this thread \(verbatim, from the owner himself\):/);
    assert.match(prompt, /arrives on 14 October and there is no charge/);
    assert.ok(env.store.wasProcessed(USER, 'm1@vendor.example'), 'once sent it is never looked at again');
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
            rules: [from],
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
    assert.strictEqual(first.calls.send.length, 1);
    assert.strictEqual(first.store.repliesSince(USER, first.now() - 60 * MINUTE), 1);
    first.store.close();

    // A fresh store and a fresh worker, exactly what a process restart gives.
    const second = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes, that works.\n', storePath: dbPath });

    // Straight after the restart the hourly limit is still holding too.
    await second.worker.tick();
    assert.strictEqual(second.calls.send.length, 0);

    // Well past the hour, so the rate limit cannot be what stops it: only the
    // record of what has already been handled stands between this and a
    // second copy of the same reply. That is the assertion that proves the
    // rule rather than a neighbouring one.
    second.advance(2 * 60 * MINUTE);
    await second.worker.tick();
    await second.worker.tick();

    assert.strictEqual(second.calls.send.length, 0, 'the message was already handled and is not drafted twice');
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

    const text = env.sends()[0].text;
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
    assert.strictEqual(env.calls.send.length, 0);
    assert.strictEqual(env.calls.llm.length, 0);
});

test('a paused user (0 replies per hour) never gets a draft', async () => {
    const env = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes.\n' });
    env.store.set(USER, { maxRepliesPerHour: 0 });
    await env.worker.tick();
    assert.strictEqual(env.calls.deliver.length, 0);
    assert.strictEqual(env.calls.send.length, 0);
    assert.strictEqual(env.calls.llm.length, 0);
});

// --------------------------------------------------------------------------
// Parsing and prompt-contract helpers.
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Parsing and prompt-contract helpers.
// --------------------------------------------------------------------------

test('a NEEDS INPUT answer is never read as a reply, even if it also contains one', () => {
    const parsed = parseDraft('NEEDS INPUT:\n- the delivery date\n\nREPLY:\nIt ships tomorrow.');
    assert.strictEqual(parsed.needsInput, true);
    assert.deepStrictEqual(parsed.missing, ['the delivery date']);
});

test('NEEDS INPUT also wins over an UNSURE answer', () => {
    // Both are "hold it back" shapes, but a missing fact is the stronger
    // claim, so that is the one the owner sees.
    const parsed = parseDraft('UNSURE:\nIt probably ships tomorrow.\nWhy unsure: tone\n\nNEEDS INPUT:\n- the delivery date');
    assert.strictEqual(parsed.needsInput, true);
    assert.deepStrictEqual(parsed.missing, ['the delivery date']);
});

test('an UNSURE answer parses into body plus the one-line reason', () => {
    const parsed = parseDraft('UNSURE:\nIt should arrive on 14 October.\n\nWhy unsure: the tone could sound like a promise');
    assert.strictEqual(parsed.needsInput, false);
    assert.strictEqual(parsed.needsApproval, true);
    assert.strictEqual(parsed.body, 'It should arrive on 14 October.');
    assert.strictEqual(parsed.reason, 'the tone could sound like a promise');
});

test('an UNSURE answer without a reason still parses, with an empty reason', () => {
    const parsed = parseDraft('UNSURE:\nDraft body here.');
    assert.strictEqual(parsed.needsApproval, true);
    assert.strictEqual(parsed.body, 'Draft body here.');
    assert.strictEqual(parsed.reason, '');
});

test('a REPLY answer is read as confident, with no approval flag', () => {
    const parsed = parseDraft('REPLY:\nIt ships tomorrow.');
    assert.strictEqual(parsed.needsInput, false);
    assert.strictEqual(parsed.needsApproval, undefined);
    assert.strictEqual(parsed.body, 'It ships tomorrow.');
});

test('marker lines are stripped from the body wherever the model echoes them', () => {
    // Some models answer with the bare body — and some echo the markers
    // inside it. The markers are structural and must never reach a
    // recipient; the disclosure line is stripped the same way.
    const out = finalizeReply('Short answer.\nUNSURE:\nWhy unsure: none\nREPLY:', true);
    assert.strictEqual(out, `Short answer.\n\n${DISCLOSURE}`);
    assert.strictEqual(finalizeReply('Short answer.', false), 'Short answer.');
});

test('classifier answers that cannot be read are a block, not a guess', () => {
    assert.strictEqual(parseClassify('I think so'), null);
    assert.deepStrictEqual(parseClassify('{"needsReply":false,"reason":"newsletter"}'), { needsReply: false, reason: 'newsletter' });
});

test('the reply prompt states the rules the new contract is judged on', () => {
    for (const must of [
        'NEVER invent facts',
        'NEEDS INPUT:',
        'UNSURE:',
        'REPLY:',
        'Why unsure:',
        'A REPLY IS SENT IMMEDIATELY',
        'The recipient is a real person',
        'No tells',
        'Never say you have done something',
        'never write "This reply came from my AI assistant"'
    ]) {
        assert.ok(TAKEOVER_REPLY_SYSTEM.includes(must), `prompt must say: ${must}`);
    }
    // The rate limit and the delay are enforced in code before the model is
    // asked anything, so the prompt is never the thing standing between the
    // owner and a second reply in an hour.
    assert.ok(!TAKEOVER_REPLY_SYSTEM.includes('one reply per hour'));
    // The old contract told the model the owner approves every reply; that
    // is no longer true and the prompt must not claim it.
    assert.ok(!TAKEOVER_REPLY_SYSTEM.includes('approves it before it is sent'));
});

// --------------------------------------------------------------------------
// Routing: confident → direct send; unsure / autoSend off / no send dep →
// the approval gate.
// --------------------------------------------------------------------------

test('a confident REPLY with autoSend on is sent directly and never queued for approval', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: 'REPLY:\nIt arrives on 14 October.\n'
    });
    await env.worker.tick();

    assert.strictEqual(env.calls.send.length, 1, 'the reply left via the injected send path');
    assert.strictEqual(env.calls.deliver.length, 0, 'no approval row was created');
    const payload = env.calls.send[0];
    assert.strictEqual(payload.user, USER);
    assert.strictEqual(payload.pass, 'pw');
    assert.strictEqual(payload.hash, 'hash');
    assert.strictEqual(payload.messageId, 'm1@vendor.example');
    assert.strictEqual(payload.message.subject, 'Re: Delivery date for order 4471');
    assert.ok(env.store.wasProcessed(USER, 'm1@vendor.example'), 'recorded with a terminal outcome');
    const decision = env.store.recentDecisions(USER, 10).find((d) => d.decision === 'sent');
    assert.ok(decision, 'the send is explained in the audit trail');
    assert.match(decision.reason, /sent it directly/i);
});

test('autoSend off on the rule routes every draft to the approval gate, even a confident one', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: 'REPLY:\nIt arrives on 14 October.\n'
    });
    const rule = env.store.listSenders(USER)[0];
    env.store.updateSender(USER, rule.id, { autoSend: false });
    await env.worker.tick();

    assert.strictEqual(env.calls.send.length, 0, 'nothing leaves directly');
    assert.strictEqual(env.calls.deliver.length, 1, 'the draft waits for approval');
    const text = env.drafts()[0].text;
    assert.ok(text.endsWith(DISCLOSURE), 'the sign-off knob is independent of routing and stays on');
});

test('without an injected send function even a confident draft waits for approval', async () => {
    // The approval-gate test files cover this worker too; this pins the
    // routing rule directly: no `send` dep means the direct path does not
    // exist, whatever the settings say.
    const env = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes.\n' });
    const noSendWorker = createTakeoverWorker({
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
        deliver: async (payload) => {
            env.calls.deliver.push(payload);
            return { pendingApproval: true, token: 'tok' };
        }
        // deliberately no `send`
    });

    await noSendWorker.tick();

    assert.strictEqual(env.calls.deliver.length, 1, 'the approval gate is the only exit');
    const drafted = env.store.recentDecisions(USER, 10).find((d) => d.decision === 'drafted');
    assert.ok(drafted, 'the draft is explained in the audit trail');
    assert.match(drafted.reason, /waiting for you to approve/i);
});

test('an UNSURE draft goes to approval even with autoSend on, and carries the model reason', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: 'UNSURE:\nIt should arrive on 14 October.\n\nWhy unsure: the sender asked for a guarantee and the thread only supports an estimate'
    });
    await env.worker.tick();

    assert.strictEqual(env.calls.send.length, 0, 'an unsure draft never leaves directly');
    assert.strictEqual(env.calls.deliver.length, 1);
    const message = env.drafts()[0];
    assert.match(message.unsureReason, /guarantee/);
    assert.ok(!message.text.includes('UNSURE'), 'no marker leaks into the draft body');
    assert.ok(!message.text.includes('Why unsure'), 'nor the reason line');
    const decision = env.store.recentDecisions(USER, 10).find((d) => d.decision === 'drafted');
    assert.ok(decision, 'the held draft is explained in the audit trail');
    assert.match(decision.reason, /unsure/i);
});

test('a direct send that throws becomes a blocked record, never a fallback approval', async () => {
    const env = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes.\n' });
    const failing = createTakeoverWorker({
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
        deliver: async () => { throw new Error('must not be reached'); },
        send: async () => { throw new Error('SMTP connection refused'); }
    });

    await failing.tick();

    assert.strictEqual(env.store.repliesSince(USER, env.now() - 60 * MINUTE), 0, 'nothing is counted as sent');
    assert.ok(!env.store.wasProcessed(USER, 'm1@vendor.example'), 'the message is retried on a later poll');
    const items = env.store.listNeedsInput(USER);
    assert.strictEqual(items.length, 1);
    assert.match(items[0].reason, /the reply could not be sent/);
    assert.match(items[0].reason, /Nothing was sent/);
});

// --------------------------------------------------------------------------
// The sign-off knob.
// --------------------------------------------------------------------------

test('signReplies off on the rule drops the disclosure entirely, even when the model writes one', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: 'REPLY:\nIt arrives on 14 October.\n\n-- \nThis reply came from my AI assistant.'
    });
    const rule = env.store.listSenders(USER)[0];
    env.store.updateSender(USER, rule.id, { signReplies: false });
    await env.worker.tick();

    const text = env.sends()[0].text;
    assert.ok(!text.includes('This reply came from my AI assistant.'), 'no disclosure survives');
    assert.ok(!text.includes('-- \n'), 'no dangling signature separator either');
    assert.match(text, /It arrives on 14 October\.$/, 'the body itself is untouched');
});

// --------------------------------------------------------------------------
// Standing instructions reach both prompts.
// --------------------------------------------------------------------------

test('the matching rule\'s instructions reach the draft prompt and the classifier prompt', async () => {
    const env = makeEnv({
        messages: [humanMessage()],
        drafts: 'REPLY:\nIt arrives on 14 October.\n'
    });
    const rule = env.store.listSenders(USER)[0];
    env.store.updateSender(USER, rule.id, { instructions: 'Never promise delivery dates. Keep replies under three sentences.' });
    await env.worker.tick();

    const draftPrompt = env.calls.llm.filter((c) => c.system === TAKEOVER_REPLY_SYSTEM).pop().userPrompt;
    assert.match(draftPrompt, /Owner's standing instructions \(verbatim, from the owner himself/);
    assert.match(draftPrompt, /Never promise delivery dates\./);
    const classifyPrompt = env.calls.llm.filter((c) => c.system === TAKEOVER_CLASSIFY_SYSTEM).pop().userPrompt;
    assert.match(classifyPrompt, /The owner's standing instructions for this assistant/);
    assert.match(classifyPrompt, /Keep replies under three sentences\./);
});

// --------------------------------------------------------------------------
// Per-sender rules govern everything about a draft.
// --------------------------------------------------------------------------

test('a sender no rule covers is invisible: no draft, no decision, nothing processed', async () => {
    const env = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nYes.\n' });
    for (const rule of env.store.listSenders(USER)) env.store.deleteSender(USER, rule.id);

    await env.worker.tick();

    assert.strictEqual(env.calls.llm.length, 0, 'the model is never asked');
    assert.strictEqual(env.calls.deliver.length, 0);
    assert.strictEqual(env.calls.send.length, 0);
    assert.deepStrictEqual(env.store.recentDecisions(USER, 50), [], 'nothing reaches the audit trail');
    assert.deepStrictEqual(env.store.listNeedsInput(USER), [], 'and nothing is parked as needing input');
    assert.ok(!env.store.wasProcessed(USER, 'm1@vendor.example'), 'nor is the message marked processed');
});

test('adding the rule later picks up the mail that was invisible before it', async () => {
    const env = makeEnv({ messages: [humanMessage()], drafts: 'REPLY:\nIt arrives on 14 October.\n' });
    for (const rule of env.store.listSenders(USER)) env.store.deleteSender(USER, rule.id);
    await env.worker.tick();
    assert.strictEqual(env.calls.send.length, 0);

    env.store.addSender(USER, { pattern: 'alice@vendor.example' });
    await env.worker.tick();

    assert.strictEqual(env.calls.send.length, 1, 'the already-unread message is drafted once a rule covers its sender');
});

test('routing follows the matching rule: one sender auto-sends while another waits for approval', async () => {
    const bob = humanMessage({
        uid: 2,
        msg: {
            uid: 2,
            envelope: {
                from: [{ name: 'Bob', address: 'bob@vendor.example' }],
                replyTo: [{ address: 'bob@vendor.example' }],
                to: [{ address: USER }],
                subject: 'Second opinion',
                date: new Date(T0 - 10 * MINUTE),
                messageId: '<b1@vendor.example>',
                inReplyTo: null
            },
            headers: '',
            bodyStructure: textPartOf('x')
        }
    });
    const env = makeEnv({
        messages: [humanMessage(), bob],
        rules: ['alice@vendor.example', 'bob@vendor.example'],
        maxPerHour: 2,
        drafts: 'REPLY:\nIt arrives on 14 October.\n'
    });
    const bobRule = env.store.listSenders(USER).find((r) => r.pattern === 'bob@vendor.example');
    env.store.updateSender(USER, bobRule.id, { autoSend: false });

    await env.worker.tick();

    assert.strictEqual(env.calls.send.length, 1, 'alice\'s rule (autoSend on) sent directly');
    assert.strictEqual(env.calls.send[0].message.to[0], 'alice@vendor.example');
    assert.strictEqual(env.calls.deliver.length, 1, 'bob\'s rule (autoSend off) held the same-shaped draft for approval');
    assert.strictEqual(env.calls.deliver[0].message.to[0], 'bob@vendor.example');
});

test('a backlog of senders without rules cannot starve a covered sender', async () => {
    // 60 rule-less senders ahead of one covered sender, with a 20-header
    // scan window. The rule-less messages are skipped at the scan — they
    // free their slots instead of eating them — so the covered message is
    // reached within a few rotations.
    const messages = Array.from({ length: 60 }, (_, i) => humanMessage({
        uid: i + 1,
        msg: {
            uid: i + 1,
            envelope: {
                from: [{ address: 'news@shop.example' }],
                replyTo: [{ address: 'news@shop.example' }],
                to: [{ address: USER }],
                subject: `Spring sale number ${i + 1}`,
                date: new Date(T0 - 10 * MINUTE),
                messageId: `<news-${i + 1}@shop.example>`,
                inReplyTo: null
            },
            headers: '',
            bodyStructure: textPartOf('x')
        }
    }));
    messages.push(humanMessage({ uid: 61 }));
    const env = makeEnv({
        messages,
        drafts: 'REPLY:\nIt arrives on 14 October.\n',
        config: { maxHeaderScanPerTick: 20 }
    });

    for (let i = 0; i < 12 && env.calls.send.length === 0; i++) await env.worker.tick();

    assert.strictEqual(env.calls.send.length, 1, 'the covered sender is reached behind the rule-less backlog');
    assert.strictEqual(env.calls.deliver.length, 0);
    assert.ok(
        env.store.recentDecisions(USER, 50).length >= 1
            && env.store.recentDecisions(USER, 50).every((d) => d.messageId === 'm1@vendor.example'),
        'only the covered message left a trail — the rule-less ones were skipped silently'
    );
});

test('figures are only flagged when they are the kind of fact that matters', () => {
    assert.deepStrictEqual(unbackedFigures('See you at 14:30 tomorrow.', 'nothing here'), ['14:30']);
    assert.deepStrictEqual(unbackedFigures('See you tomorrow.', 'nothing here'), []);
    assert.deepStrictEqual(unbackedFigures('I have asked 2 people.', 'nothing here'), []);
    assert.deepStrictEqual(unbackedFigures('Refund of £1,200 issued.', 'nothing here'), ['£1,200']);
    assert.deepStrictEqual(unbackedFigures('Refund of £1,200 issued.', 'the refund is £1,200'), []);
});
