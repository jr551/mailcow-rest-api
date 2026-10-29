import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');

const tmp = mkdtempSync(path.join(tmpdir(), 'focused-inbox-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadFocusedInbox() {
    const out = path.join(tmp, 'focused-inbox.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/focused-inbox.ts')],
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
        internalDate: null,
        envelope: {
            date: null,
            subject: partial.subject ?? '',
            from: [{ name: null, address: partial.from ?? 'a@b.c' }],
            to: [],
            cc: [],
            messageId: '<x>',
            inReplyTo: partial.inReplyTo ?? null
        }
    };
}

test('starred messages always land in Focused', async () => {
    const { inboxBucketForMessage } = await loadFocusedInbox();
    assert.equal(inboxBucketForMessage(msg({ flags: ['\\Flagged'], from: 'newsletter@shop.example' })), 'focused');
});

test('billing and newsletter senders land in Other', async () => {
    const { inboxBucketForMessage } = await loadFocusedInbox();
    assert.equal(inboxBucketForMessage(msg({ from: 'billing@acme.example' })), 'other');
    assert.equal(inboxBucketForMessage(msg({ from: 'newsletter@shop.example' })), 'other');
});

test('personal senders land in Focused', async () => {
    const { inboxBucketForMessage } = await loadFocusedInbox();
    assert.equal(inboxBucketForMessage(msg({ from: 'sam@friend.example', subject: 'Re: lunch?' })), 'focused');
});

test('filterMessagesByInboxTab respects tab', async () => {
    const { filterMessagesByInboxTab } = await loadFocusedInbox();
    const list = [
        msg({ uid: 1, from: 'sam@friend.example' }),
        msg({ uid: 2, from: 'billing@acme.example' })
    ];
    const focused = filterMessagesByInboxTab(list, 'focused');
    assert.deepEqual(focused.map((m) => m.uid), [1]);
    const other = filterMessagesByInboxTab(list, 'other');
    assert.deepEqual(other.map((m) => m.uid), [2]);
});
