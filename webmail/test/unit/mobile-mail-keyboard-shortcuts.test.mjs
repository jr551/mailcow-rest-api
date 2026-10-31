import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'mobile-mail-kbd-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function load() {
    const out = path.join(tmp, 'mobile-mail-keyboard-shortcuts.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/mobile-mail-keyboard-shortcuts.ts')],
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

test('resolveMobileMailShortcut maps inbox navigation and help', async () => {
    const { resolveMobileMailShortcut } = await load();
    assert.equal(resolveMobileMailShortcut(ev({ key: 'j' })), 'navigate-next');
    assert.equal(resolveMobileMailShortcut(ev({ key: 'Enter' })), 'open-message');
    assert.equal(resolveMobileMailShortcut(ev({ key: '?' })), 'show-help');
    assert.equal(resolveMobileMailShortcut(ev({ key: '?', shiftKey: true })), 'show-help');
    assert.equal(resolveMobileMailShortcut(ev({ key: '/' })), 'focus-search');
    assert.equal(resolveMobileMailShortcut(ev({ key: 'e' })), 'archive');
});

test('MOBILE_MAIL_KEYBOARD_SHORTCUT_ROWS documents Enter to open', async () => {
    const { MOBILE_MAIL_KEYBOARD_SHORTCUT_ROWS } = await load();
    assert.ok(MOBILE_MAIL_KEYBOARD_SHORTCUT_ROWS.some((r) => r.keys.includes('Enter')));
});
