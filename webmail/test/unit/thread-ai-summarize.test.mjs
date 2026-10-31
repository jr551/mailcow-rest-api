import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');

const tmp = mkdtempSync(path.join(tmpdir(), 'thread-ai-summarize-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'thread-ai-summarize.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        [
            '--loader:.ts=ts',
            '--format=esm',
            '--bundle',
            `--outfile=${out}`,
            path.join(webmailRoot, 'src/lib/thread-ai-summarize.ts')
        ],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

function listMsg(partial) {
    return {
        uid: partial.uid ?? 1,
        seq: 0,
        flags: [],
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

function detail(partial) {
    return {
        uid: partial.uid,
        mailbox: 'INBOX',
        flags: [],
        size: 100,
        envelope: listMsg(partial).envelope,
        text: partial.text ?? '',
        html: null,
        attachments: []
    };
}

test('buildThreadSummarizePayload uses single message when grouping off', async () => {
    const mod = await loadModule();
    const messages = [
        listMsg({ uid: 10, messageId: '<root>', subject: 'Plan' }),
        listMsg({ uid: 11, messageId: '<reply>', inReplyTo: '<root>', subject: 'Re: Plan' })
    ];
    const primary = detail({ uid: 11, text: 'Latest reply body' });
    const built = mod.buildThreadSummarizePayload({
        messages,
        focusUid: 11,
        primaryDetail: primary,
        conversationDetails: {},
        groupThreads: false
    });
    assert.equal(built.mode, 'message');
    assert.match(built.text, /Latest reply body/);
    assert.doesNotMatch(built.text, /---/);
});

test('buildThreadSummarizePayload merges thread when grouping on', async () => {
    const mod = await loadModule();
    const messages = [
        listMsg({ uid: 10, messageId: '<root>', subject: 'Plan', internalDate: '2026-04-26T10:00:00Z' }),
        listMsg({ uid: 11, messageId: '<reply>', inReplyTo: '<root>', subject: 'Re: Plan', internalDate: '2026-04-27T10:00:00Z' })
    ];
    const primary = detail({ uid: 11, text: 'Reply text' });
    const built = mod.buildThreadSummarizePayload({
        messages,
        focusUid: 11,
        primaryDetail: primary,
        conversationDetails: {
            10: detail({ uid: 10, text: 'Root text' })
        },
        groupThreads: true
    });
    assert.equal(built.mode, 'thread');
    assert.match(built.text, /Root text/);
    assert.match(built.text, /Reply text/);
    assert.match(built.text, /\n\n---\n\n/);
});
