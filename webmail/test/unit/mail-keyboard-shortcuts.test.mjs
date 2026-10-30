import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'mail-kbd-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function load() {
    const out = path.join(tmp, 'mail-keyboard-shortcuts.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/mail-keyboard-shortcuts.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

function ev(partial) {
    return {
        key: partial.key ?? '',
        altKey: partial.altKey ?? false,
        shiftKey: partial.shiftKey ?? false,
        ctrlKey: partial.ctrlKey ?? false,
        metaKey: partial.metaKey ?? false
    };
}

test('resolveMailShortcut maps OWA-style keys', async () => {
    const { resolveMailShortcut } = await load();
    assert.equal(resolveMailShortcut(ev({ key: 'j' })), 'navigate-next');
    assert.equal(resolveMailShortcut(ev({ key: 'k' })), 'navigate-prev');
    assert.equal(resolveMailShortcut(ev({ key: 'n' })), 'compose-new');
    assert.equal(resolveMailShortcut(ev({ key: 'r' })), 'reply');
    assert.equal(resolveMailShortcut(ev({ key: 'r', shiftKey: true })), 'reply-all');
    assert.equal(resolveMailShortcut(ev({ key: 'f', shiftKey: true })), 'forward');
    assert.equal(resolveMailShortcut(ev({ key: 'e' })), 'archive');
    assert.equal(resolveMailShortcut(ev({ key: 'Delete' })), 'delete');
    assert.equal(resolveMailShortcut(ev({ key: 'q' })), 'mark-read');
    assert.equal(resolveMailShortcut(ev({ key: 'u' })), 'mark-unread');
    assert.equal(resolveMailShortcut(ev({ key: 'Insert' })), 'toggle-flag');
    assert.equal(resolveMailShortcut(ev({ key: '/' })), 'focus-search');
    assert.equal(resolveMailShortcut(ev({ key: '?' })), 'show-help');
    assert.equal(resolveMailShortcut(ev({ key: 'z', ctrlKey: true })), 'undo');
});

test('resolveMailShortcut ignores blocked modifier combos', async () => {
    const { resolveMailShortcut } = await load();
    assert.equal(resolveMailShortcut(ev({ key: 'r', altKey: true })), null);
    assert.equal(resolveMailShortcut(ev({ key: 'n', ctrlKey: true })), null);
});
