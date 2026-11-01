import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'reading-pane-quick-reply-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'reading-pane-quick-reply.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        [
            '--bundle',
            '--loader:.ts=ts',
            '--format=esm',
            `--outfile=${out}`,
            path.join(webmailRoot, 'src/lib/reading-pane-quick-reply.ts')
        ],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

const sampleDetail = {
    uid: 1001,
    envelope: {
        subject: 'Welcome',
        messageId: '<msg-1001@mock>',
        date: '2026-01-01T12:00:00Z',
        from: [{ address: 'concierge@example.com', name: 'Concierge' }],
        to: [{ address: 'user@example.com', name: 'User' }]
    },
    internalDate: '2026-01-01T12:00:00Z',
    text: 'Hello there',
    html: ''
};

describe('reading-pane-quick-reply (slice 52)', () => {
    it('builds Re: subject without doubling prefix', async () => {
        const mod = await loadModule();
        assert.equal(mod.quickReplySubject('Welcome'), 'Re: Welcome');
        assert.equal(mod.quickReplySubject('Re: Welcome'), 'Re: Welcome');
    });

    it('resolves reply recipient', async () => {
        const mod = await loadModule();
        assert.equal(mod.quickReplyToAddress(sampleDetail), 'concierge@example.com');
        assert.equal(mod.quickReplyRecipientLabel(sampleDetail), 'Concierge');
    });

    it('canSendQuickReply rejects blank', async () => {
        const mod = await loadModule();
        assert.equal(mod.canSendQuickReply(''), false);
        assert.equal(mod.canSendQuickReply('  hi '), true);
    });

    it('buildQuickReplySendPayload quotes the original', async () => {
        const mod = await loadModule();
        const payload = mod.buildQuickReplySendPayload(
            sampleDetail,
            'Thanks!',
            'user@example.com',
            'User',
            () => ''
        );
        assert.ok(payload);
        assert.deepEqual(payload.to, ['concierge@example.com']);
        assert.equal(payload.subject, 'Re: Welcome');
        assert.match(payload.html, /Thanks!/);
        assert.match(payload.html, /Hello there/);
        assert.equal(payload.inReplyTo, '<msg-1001@mock>');
    });
});
