import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');

const tmp = mkdtempSync(path.join(tmpdir(), 'list-quick-filters-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'list-quick-filters.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/list-quick-filters.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

function msg(partial) {
    return {
        uid: partial.uid ?? 1,
        seq: 0,
        flags: partial.flags ?? [],
        size: partial.size ?? 100,
        internalDate: partial.internalDate ?? '2026-04-29T10:00:00Z',
        hasAttachments: partial.hasAttachments,
        envelope: {
            date: partial.internalDate ?? '2026-04-29T10:00:00Z',
            subject: partial.subject ?? '',
            from: [{ name: null, address: partial.from ?? 'a@b.c' }],
            to: partial.to ?? [{ name: null, address: 'me@test.local' }],
            cc: partial.cc ?? [],
            messageId: '<x>',
            inReplyTo: null
        }
    };
}

test('to-me keeps direct To, drops CC-only', async () => {
    const { messageIsAddressedToMe, filterMessagesByOutlookFilter } = await loadModule();
    const direct = msg({ uid: 1, to: [{ name: null, address: 'me@test.local' }] });
    const ccOnly = msg({ uid: 2, to: [{ name: null, address: 'other@test.local' }], cc: [{ name: null, address: 'me@test.local' }] });
    assert.equal(messageIsAddressedToMe(direct, 'me@test.local'), true);
    assert.equal(messageIsAddressedToMe(ccOnly, 'me@test.local'), false);
    const filtered = filterMessagesByOutlookFilter([direct, ccOnly], 'to-me', { userEmail: 'me@test.local' });
    assert.deepEqual(filtered.map((m) => m.uid), [1]);
});

test('mentions matches @local in subject', async () => {
    const { filterMessagesByOutlookFilter } = await loadModule();
    const hit = msg({ uid: 3, subject: 'Hey @demo — review?' });
    const miss = msg({ uid: 4, subject: 'No tag here' });
    const filtered = filterMessagesByOutlookFilter([hit, miss], 'mentions', { userEmail: 'demo@test.local' });
    assert.deepEqual(filtered.map((m) => m.uid), [3]);
});

test('sort subject ascending', async () => {
    const { sortMessageList } = await loadModule();
    const a = msg({ uid: 1, subject: 'Zebra' });
    const b = msg({ uid: 2, subject: 'Alpha' });
    const sorted = sortMessageList([a, b], 'subject-asc');
    assert.deepEqual(sorted.map((m) => m.uid), [2, 1]);
});

test('imapFilterToken maps Outlook filters', async () => {
    const { imapFilterToken } = await loadModule();
    assert.equal(imapFilterToken('unread', 'u@x'), 'is:unread');
    assert.equal(imapFilterToken('to-me', 'Demo@Test.Local'), 'to:demo@test.local');
    assert.equal(imapFilterToken('mentions', 'demo@test.local'), 'body:@demo');
});

test('OUTLOOK_FILTER_MENU matches mobile and desktop quick filter bar', async () => {
    const { OUTLOOK_FILTER_MENU } = await loadModule();
    assert.deepEqual(
        OUTLOOK_FILTER_MENU.map((f) => f.value),
        ['all', 'unread', 'starred', 'to-me', 'attachments', 'mentions']
    );
});
