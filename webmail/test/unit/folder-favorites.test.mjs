import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');

const tmp = mkdtempSync(path.join(tmpdir(), 'folder-favorites-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'folder-favorites.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/folder-favorites.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

const KNOWN = ['INBOX', 'Sent', 'Drafts', 'Projects', 'Trash'];

test('resolveFavoritePaths uses OWA defaults when storage never set', async () => {
    const { resolveFavoritePaths } = await loadModule();
    assert.deepEqual(resolveFavoritePaths(undefined, KNOWN), ['INBOX', 'Sent', 'Drafts']);
});

test('resolveFavoritePaths respects stored list and prunes unknown paths', async () => {
    const { resolveFavoritePaths } = await loadModule();
    assert.deepEqual(
        resolveFavoritePaths(['Projects', 'Missing', 'INBOX'], KNOWN),
        ['Projects', 'INBOX']
    );
});

test('add and remove favorite paths', async () => {
    const { addFavoritePath, removeFavoritePath } = await loadModule();
    assert.deepEqual(addFavoritePath(['INBOX'], 'Projects'), ['INBOX', 'Projects']);
    assert.deepEqual(addFavoritePath(['INBOX'], 'INBOX'), ['INBOX']);
    assert.deepEqual(removeFavoritePath(['INBOX', 'Sent'], 'Sent'), ['INBOX']);
});

test('moveFavoritePath reorders without losing entries', async () => {
    const { moveFavoritePath } = await loadModule();
    assert.deepEqual(moveFavoritePath(['INBOX', 'Sent', 'Drafts'], 0, 2), ['Sent', 'Drafts', 'INBOX']);
});

test('remapFavoritePath updates renamed folder', async () => {
    const { remapFavoritePath } = await loadModule();
    assert.deepEqual(
        remapFavoritePath(['INBOX', 'Projects/Old'], 'Projects/Old', 'Projects/New'),
        ['INBOX', 'Projects/New']
    );
});
