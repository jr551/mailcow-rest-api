import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'compose-draft-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'compose-draft.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/compose-draft.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

describe('compose-draft (slice 14)', () => {
    it('resolves Drafts folder from special-use', async () => {
        const mod = await loadModule();
        assert.equal(
            mod.resolveDraftsMailboxPath([
                { path: 'INBOX', name: 'Inbox', delimiter: '/', flags: [], specialUse: '\\Inbox', subscribed: true },
                { path: 'My Drafts', name: 'My Drafts', delimiter: '/', flags: [], specialUse: '\\Drafts', subscribed: true }
            ]),
            'My Drafts'
        );
    });

    it('detects when compose has saveable content', async () => {
        const mod = await loadModule();
        assert.equal(mod.composeDraftHasContent({ to: '', subject: '', html: '<p></p>' }), false);
        assert.equal(mod.composeDraftHasContent({ to: 'a@b.com', subject: '', html: '' }), true);
        assert.equal(mod.composeDraftHasContent({ to: '', subject: 'Hi', html: '' }), true);
    });

    it('builds RFC822 with Draft-friendly headers', async () => {
        const mod = await loadModule();
        const bytes = mod.buildComposeDraftRfc822({
            from: 'me@example.com',
            fromName: 'Me',
            to: ['friend@example.com'],
            subject: 'Hello',
            html: '<p>Hi</p>',
            text: 'Hi',
            inReplyTo: '<msg@x>'
        }, Date.parse('2026-10-30T12:00:00Z'));
        const raw = new TextDecoder().decode(bytes);
        assert.match(raw, /^Subject: Hello/m);
        assert.match(raw, /^From: "Me" <me@example.com>/m);
        assert.match(raw, /^To: friend@example.com/m);
        assert.match(raw, /^In-Reply-To: <msg@x>/m);
        assert.match(raw, /Content-Type: text\/html; charset=utf-8/);
        assert.match(raw, /Hi/);
    });
});
