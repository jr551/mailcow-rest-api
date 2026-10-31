import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');

const tmp = mkdtempSync(path.join(tmpdir(), 'conversation-view-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'conversation-view.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        [
            '--loader:.ts=ts',
            '--format=esm',
            '--bundle',
            `--outfile=${out}`,
            path.join(webmailRoot, 'src/lib/conversation-view.ts')
        ],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

function msg(partial) {
    return {
        uid: partial.uid ?? 1,
        seq: 0,
        flags: partial.flags ?? [],
        size: 100,
        internalDate: partial.internalDate ?? '2026-04-27T08:00:00Z',
        envelope: {
            date: partial.internalDate ?? '2026-04-27T08:00:00Z',
            subject: partial.subject ?? '',
            from: [{ name: null, address: partial.from ?? 'a@b.c' }],
            to: [],
            cc: [],
            messageId: partial.messageId ?? `<m-${partial.uid ?? 1}>`,
            inReplyTo: partial.inReplyTo ?? null
        }
    };
}

test('findThreadForUid groups reply chains', async () => {
    const mod = await loadModule();
    const messages = [
        msg({ uid: 10, messageId: '<root>', subject: 'Plan', internalDate: '2026-04-26T10:00:00Z' }),
        msg({ uid: 11, messageId: '<reply>', inReplyTo: '<root>', subject: 'Re: Plan', internalDate: '2026-04-27T10:00:00Z' })
    ];
    const t = mod.findThreadForUid(messages, 11);
    assert.ok(t);
    assert.equal(t.count, 2);
});

test('conversationOrderChronological sorts oldest first', async () => {
    const mod = await loadModule();
    const messages = [
        msg({ uid: 10, messageId: '<root>', internalDate: '2026-04-26T10:00:00Z' }),
        msg({ uid: 11, messageId: '<reply>', inReplyTo: '<root>', internalDate: '2026-04-27T10:00:00Z' })
    ];
    const thread = mod.findThreadForUid(messages, 11);
    const order = mod.conversationOrderChronological(thread);
    assert.deepEqual(order.map((m) => m.uid), [10, 11]);
});

test('isConversationMessageExpanded focuses selected uid', async () => {
    const mod = await loadModule();
    assert.equal(mod.isConversationMessageExpanded(5, 5, new Set()), true);
    assert.equal(mod.isConversationMessageExpanded(4, 5, new Set()), false);
    assert.equal(mod.isConversationMessageExpanded(4, 5, new Set([4])), true);
});

test('conversationSnippet trims whitespace', async () => {
    const mod = await loadModule();
    assert.equal(mod.conversationSnippet('  hello\n\nworld  '), 'hello world');
});

test('shouldShowConversationStack requires groupThreads and multiple uids', async () => {
    const mod = await loadModule();
    assert.equal(mod.shouldShowConversationStack(false, { uids: [1, 2] }), false);
    assert.equal(mod.shouldShowConversationStack(true, null), false);
    assert.equal(mod.shouldShowConversationStack(true, { uids: [1] }), false);
    assert.equal(mod.shouldShowConversationStack(true, { uids: [1, 2] }), true);
});
