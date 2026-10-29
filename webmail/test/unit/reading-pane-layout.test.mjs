import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');

const tmp = mkdtempSync(path.join(tmpdir(), 'reading-pane-layout-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'reading-pane-layout.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/reading-pane-layout.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

test('sanitizeReadingPaneLayout defaults unknown to right', async () => {
    const { sanitizeReadingPaneLayout } = await loadModule();
    assert.equal(sanitizeReadingPaneLayout(undefined), 'right');
    assert.equal(sanitizeReadingPaneLayout('nope'), 'right');
    assert.equal(sanitizeReadingPaneLayout('bottom'), 'bottom');
    assert.equal(sanitizeReadingPaneLayout('hidden'), 'hidden');
});

test('nextReadingPaneLayout cycles OWA order', async () => {
    const { nextReadingPaneLayout } = await loadModule();
    assert.equal(nextReadingPaneLayout('right'), 'bottom');
    assert.equal(nextReadingPaneLayout('bottom'), 'hidden');
    assert.equal(nextReadingPaneLayout('hidden'), 'right');
});

test('readingPaneLayoutFromKeyboard accepts Alt+Shift+R/B/H only', async () => {
    const { readingPaneLayoutFromKeyboard } = await loadModule();
    assert.equal(readingPaneLayoutFromKeyboard({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: 'R' }), 'right');
    assert.equal(readingPaneLayoutFromKeyboard({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: 'b' }), 'bottom');
    assert.equal(readingPaneLayoutFromKeyboard({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: 'H' }), 'hidden');
    assert.equal(readingPaneLayoutFromKeyboard({ altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, key: 'R' }), null);
    assert.equal(readingPaneLayoutFromKeyboard({ altKey: true, shiftKey: true, ctrlKey: true, metaKey: false, key: 'R' }), null);
});

test('isDockedReadingPane is false only for hidden', async () => {
    const { isDockedReadingPane } = await loadModule();
    assert.equal(isDockedReadingPane('right'), true);
    assert.equal(isDockedReadingPane('bottom'), true);
    assert.equal(isDockedReadingPane('hidden'), false);
});
