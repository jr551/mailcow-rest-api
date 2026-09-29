// Remote images went from auto-loading to blocked-by-default, and the way
// that was rolled out is the part worth pinning down.
//
// The flip is invisible until it is wrong: if an upgrading user silently
// loses every image in their mailbox, nothing throws, no test elsewhere
// fails, and the report is "images stopped working" weeks later. So the
// migration's contract is asserted directly, here:
//
//   * a NEW profile (no stored blob) resolves to BLOCKED — that is the
//     whole point of the change;
//   * an EXISTING profile keeps exactly the behaviour it had, because the
//     old auto-allow condition accepted EITHER `alwaysAllowImages` OR
//     `proxyImages`, and `proxyImages` shipped defaulting to true;
//   * live in-memory state and the persisted blob always agree, since a
//     disagreement makes the first session after an upgrade behave
//     differently from every reload after it;
//   * the migration is idempotent, so it cannot re-flip a profile the user
//     has since changed by hand.
//
// The module is loaded through esbuild (already a webmail dependency) with
// the Svelte rune globals and the two local imports stubbed, so this
// exercises the real load() + migrateRemoteImagesDefault code path rather
// than a re-implementation of it.

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

const tmp = mkdtempSync(path.join(tmpdir(), 'privacy-migration-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

// Transpile once; the module body re-runs per import via a cache-busting
// query so each case gets a clean module instance and a clean read of the
// store it is handed.
execFileSync(
    path.join(webmailRoot, 'node_modules/.bin/esbuild'),
    ['--loader:.ts=ts', '--format=esm', `--outfile=${path.join(tmp, 'settings.mjs')}`, settingsPath],
    { stdio: 'pipe' }
);

// The module's two local imports pull in Svelte runes and a browser API we
// don't have, so they are rewritten to point at a stub module. The real
// exports are left intact — `settings` and `remoteImagesBlockedFor` are
// exactly what the assertions below read off the module namespace.
writeFileSync(path.join(tmp, 'stubs.mjs'),
    'export const getAiConfig = async () => null;\n'
    + 'export const getTtsConfig = async () => null;\n'
    + 'export const apiUrl = (p) => p;\n'
    + 'export const getSession = () => null;\n'
    + 'export const bearerHeader = () => ({});\n');

const stubsUrl = pathToFileURL(path.join(tmp, 'stubs.mjs')).href;
const rewritten = readFileSync(path.join(tmp, 'settings.mjs'), 'utf8').replace(
    /from\s+"\.\/[^"]*"/g,
    `from "${stubsUrl}"`
);
writeFileSync(path.join(tmp, 'settings.mjs'), rewritten);

const STORAGE_KEY = 'webmail.settings.v1';

let loadCounter = 0;
/** Run load() against a seeded localStorage and report what it decided. */
async function resolve(blob) {
    loadCounter += 1;
    const store = new Map();
    if (blob !== null) store.set(STORAGE_KEY, blob);
    globalThis.localStorage = {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k)
    };
    globalThis.window = { location: { pathname: '/' } };
    globalThis.document = { documentElement: { classList: { contains: () => false } } };
    globalThis.$state = v => v;
    globalThis.$derived = v => v;
    globalThis.$effect = () => { };
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

    const mod = await import(
        `${pathToFileURL(path.join(tmp, 'settings.mjs')).href}?case=${loadCounter}`
    );
    const after = store.get(STORAGE_KEY);
    let persisted = null;
    if (after !== undefined) {
        try { persisted = JSON.parse(after); } catch { persisted = null; } // corrupt blob
    }
    return {
        live: mod.settings.alwaysAllowImages,
        persisted,
        raw: after,
        blocked: mod.remoteImagesBlockedFor(true)
    };
}

// The pre-flip world: the reader auto-allowed when alwaysAllowImages OR
// proxyImages was set, and proxyImages defaulted to true.
const PRE_FLIP_COMMON = JSON.stringify({ alwaysAllowImages: false, proxyImages: true });
const PRE_FLIP_PROXY_OFF = JSON.stringify({ alwaysAllowImages: false, proxyImages: false });
const PRE_FLIP_ALWAYS_ON = JSON.stringify({ alwaysAllowImages: true, proxyImages: true });
const PRE_FLIP_LEGACY_BLOB = JSON.stringify({ groupThreads: true }); // no image keys at all

test('a brand-new profile gets the blocked-by-default behaviour', async () => {
    const r = await resolve(null);
    assert.equal(r.live, false);
    assert.equal(r.blocked, true, 'images must be blocked for a fresh profile');
});

test('an existing profile keeps the images it already had', async () => {
    // This is the case that would have been a silent overnight regression:
    // the shipped pre-flip default auto-allowed every image via the proxy.
    for (const [name, blob, expectAllowed] of [
        ['proxy on (the shipped default)', PRE_FLIP_COMMON, true],
        ['proxy off and always-allow off', PRE_FLIP_PROXY_OFF, false],
        ['always-allow on', PRE_FLIP_ALWAYS_ON, true],
        ['a blob predating both image settings', PRE_FLIP_LEGACY_BLOB, true]
    ]) {
        const r = await resolve(blob);
        assert.equal(r.live, expectAllowed, `${name}: should keep alwaysAllowImages=${expectAllowed}`);
        assert.equal(r.blocked, !expectAllowed, `${name}: blocked state should be ${!expectAllowed}`);
    }
});

test('live state and the persisted blob never disagree', async () => {
    for (const blob of [PRE_FLIP_COMMON, PRE_FLIP_PROXY_OFF, PRE_FLIP_ALWAYS_ON, PRE_FLIP_LEGACY_BLOB]) {
        const r = await resolve(blob);
        assert.equal(
            r.live, r.persisted.alwaysAllowImages,
            'the first session after an upgrade must behave like every reload after it'
        );
        assert.equal(r.persisted.remoteImagesDefaulted, true, 'the profile should be marked as migrated');
    }
});

test('the migration is idempotent and does not re-flip a profile', async () => {
    // Once marked, the migration must leave the stored value alone — a user
    // who has since turned images off must not have them turned back on by
    // the next load.
    const userTurnedThemOff = JSON.stringify({
        alwaysAllowImages: false, proxyImages: true, remoteImagesDefaulted: true
    });
    const r = await resolve(userTurnedThemOff);
    assert.equal(r.live, false, 'a post-flip profile must be read literally');
    assert.equal(r.persisted.alwaysAllowImages, false);
    assert.equal(r.blocked, true);
});

test('a corrupt stored blob falls back to the new-profile defaults', async () => {
    // load() swallows the parse error and returns the defaults. The corrupt
    // blob is left on disk untouched, which is the pre-existing contract
    // (migrateStripClientRules does the same) — we do not want a migration
    // to destroy a blob it merely failed to understand.
    const r = await resolve('{not json');
    assert.equal(r.live, false, 'should fall back to blocked-by-default');
    assert.equal(r.blocked, true);
    assert.equal(r.raw, '{not json', 'a blob we cannot parse should not be rewritten');
});
