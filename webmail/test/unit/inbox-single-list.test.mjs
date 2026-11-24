// Pin the single-list inbox: the Focused/Other split was removed, so a
// legacy profile carrying `inboxTab` (localStorage or an IMAP-synced
// snapshot, which is filtered through sanitizeSettings) must load with the
// key dropped — never resurrected, never hiding mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const settingsPath = path.join(webmailRoot, 'src/lib/settings.svelte.ts');

const tmp = mkdtempSync(path.join(tmpdir(), 'inbox-single-list-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

execFileSync(
    path.join(webmailRoot, 'node_modules/.bin/esbuild'),
    ['--loader:.ts=ts', '--format=esm', `--outfile=${path.join(tmp, 'settings.mjs')}`, settingsPath],
    { stdio: 'pipe' }
);
execFileSync(
    path.join(webmailRoot, 'node_modules/.bin/esbuild'),
    ['--loader:.ts=ts', '--format=esm', `--outfile=${path.join(tmp, 'reading-pane-layout.mjs')}`, path.join(webmailRoot, 'src/lib/reading-pane-layout.ts')],
    { stdio: 'pipe' }
);

writeFileSync(path.join(tmp, 'stubs.mjs'),
    'export const getAiConfig = async () => null;\n'
    + 'export const getTtsConfig = async () => null;\n'
    + 'export const apiUrl = (p) => p;\n'
    + 'export const getSession = () => null;\n'
    + 'export const bearerHeader = () => ({});\n'
    + 'export const dropPermanentSession = () => {};\n');

const stubsUrl = pathToFileURL(path.join(tmp, 'stubs.mjs')).href;
const readingPaneUrl = pathToFileURL(path.join(tmp, 'reading-pane-layout.mjs')).href;
const rewritten = readFileSync(path.join(tmp, 'settings.mjs'), 'utf8').replace(
    /from\s+"\.\/[^"]*"/g,
    (m) => (m.includes('reading-pane-layout') ? `from "${readingPaneUrl}"` : `from "${stubsUrl}"`)
);
writeFileSync(path.join(tmp, 'settings.mjs'), rewritten);

let counter = 0;
async function loadSettingsModule(blob) {
    counter += 1;
    const store = new Map();
    if (blob !== null) store.set('webmail.settings.v1', blob);
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k)
    };
    globalThis.window = { location: { pathname: '/' } };
    globalThis.document = { documentElement: { classList: { contains: () => false } } };
    globalThis.$state = (v) => v;
    globalThis.$derived = (v) => v;
    globalThis.$effect = () => { };
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

    return import(
        `${pathToFileURL(path.join(tmp, 'settings.mjs')).href}?case=${counter}`
    );
}

test('sanitizeSettings drops a legacy inboxTab key', async () => {
    const { sanitizeSettings } = await loadSettingsModule(null);
    const clean = sanitizeSettings({ inboxTab: 'other', density: 'compact' });
    assert.equal(Object.hasOwn(clean, 'inboxTab'), false);
    assert.equal(clean.density, 'compact');
});

test('a profile last left on Other loads with no inboxTab state', async () => {
    const { settings } = await loadSettingsModule(
        JSON.stringify({ inboxTab: 'other', density: 'compact' })
    );
    assert.equal(Object.hasOwn(settings, 'inboxTab'), false);
    assert.equal(settings.density, 'compact');
});
