// Remote images went from blocked-by-default to ALWAYS ALLOWED THROUGH THE
// PROXY, and the rollout is the part worth pinning down.
//
// This reverses v0.19.0, which deliberately made blocking the default and
// used a migration to protect the users who had been auto-loading images all
// along. That protection is exactly what is now in the way: anyone left on
// `alwaysAllowImages: false` keeps a "This message has remote content"
// overlay on every message with an image in it, and once the toggle that
// produced the state is deleted there is no longer any way out of it. That
// is the deployed symptom this release fixes.
//
// The flip is invisible until it is wrong in both directions, so the
// migration's contract is asserted directly, here:
//
//   * a NEW profile (no stored blob) resolves to proxied-and-allowed;
//   * an EXISTING profile stuck in the blocked state is MOVED OUT of it —
//     the field is deleted and the proxy is forced on — because with
//     blocking gone a stored `proxyImages: false` can only mean "connect to
//     the sender's CDN from the user's own browser", i.e. hand over their IP;
//   * live in-memory state and the persisted blob always agree, since a
//     disagreement makes the first session after an upgrade behave
//     differently from every reload after it;
//   * the migration is idempotent, so it cannot re-flip a profile the user
//     has since changed by hand — including a user who deliberately turns
//     the proxy back off, who must NOT be re-proxied on the next load.
//
// The module is loaded through esbuild (already a webmail dependency) with
// the Svelte rune globals and the two local imports stubbed, so this
// exercises the real load() + migrateRemoteImagesAlwaysAllowed code path
// rather than a re-implementation of it.
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
        // The only image setting left. Live state and the persisted blob are
        // compared directly rather than through a predicate, because there
        // is no predicate left to disagree about.
        proxied: mod.settings.proxyImages,
        persisted,
        raw: after
    };
}

// The shapes that existed immediately before this release, i.e. what an
// upgrading profile can actually hold on disk.
const BLOCKED_BY_DEFAULT = JSON.stringify({
    alwaysAllowImages: false, proxyImages: true, remoteImagesDefaulted: true
});
// The profile that was explicitly strict: blocking AND no proxy. Under the
// old reader this is the one shape that was already blocking.
const BLOCKED_NO_PROXY = JSON.stringify({
    alwaysAllowImages: false, proxyImages: false, remoteImagesDefaulted: true
});
// Auto-allowing, no prompt, proxy on — where most users already were.
const ALLOWED_PROXY_ON = JSON.stringify({ alwaysAllowImages: true, proxyImages: true });
// A blob predating both image settings entirely.
const LEGACY_BLOB = JSON.stringify({ groupThreads: true });

test('a brand-new profile loads images through the proxy', async () => {
    const r = await resolve(null);
    assert.equal(r.proxied, true, 'a fresh profile must proxy remote images');
});

test('every profile stuck in the blocked state is moved out of it', async () => {
    // The point of the migration. Both of these profiles would otherwise
    // still be showing the "This message has remote content" overlay after
    // the upgrade, with the toggle that produced it deleted and no way back.
    for (const [name, blob] of [
        ['blocked by default', BLOCKED_BY_DEFAULT],
        ['blocked and proxy off', BLOCKED_NO_PROXY],
        ['allowed with proxy on', ALLOWED_PROXY_ON],
        ['a blob predating both image settings', LEGACY_BLOB]
    ]) {
        const r = await resolve(blob);
        assert.equal(r.proxied, true, `${name}: must resolve to proxied after the migration`);
        assert.ok(
            r.persisted && !('alwaysAllowImages' in r.persisted),
            `${name}: the dead alwaysAllowImages field must be deleted from the blob`
        );
        assert.equal(r.persisted.proxyImages, true, `${name}: the proxy flag must be forced on`);
    }
});


test('live state and the persisted blob never disagree', async () => {
    for (const blob of [BLOCKED_BY_DEFAULT, BLOCKED_NO_PROXY, ALLOWED_PROXY_ON, LEGACY_BLOB]) {
        const r = await resolve(blob);
        assert.equal(
            r.proxied, r.persisted.proxyImages,
            'the first session after an upgrade must behave like every reload after it'
        );
    }
});

test('the migration runs once and then leaves the profile alone', async () => {
    // The stamp is what separates "opted out before the upgrade" from "opted
    // out after it". Without one, a stored `proxyImages: false` is a
    // pre-upgrade profile and MUST be forced back onto the proxy — that is
    // the entire migration, and it is why the stamp is needed rather than a
    // state predicate: the predicate cannot tell those two apart and would
    // re-proxy the user on every single reload, which is the same class of
    // bug as the prompt itself (a setting that overrides the user).
    const preUpgradeOptOut = JSON.stringify({ proxyImages: false });
    const forced = await resolve(preUpgradeOptOut);
    assert.equal(forced.proxied, true, 'a pre-upgrade opt-out must be moved onto the proxy');

    const postUpgradeOptOut = JSON.stringify({
        proxyImages: false, remoteImagesAlwaysAllowed: true, density: 'compact'
    });
    const r = await resolve(postUpgradeOptOut);
    assert.equal(r.proxied, false, 'a deliberate choice to load images directly must survive');
    assert.equal(r.persisted.proxyImages, false, 'and must be left as the user set it');
    assert.equal(r.persisted.density, 'compact', 'an untouched setting must survive the read');
});

test('a corrupt stored blob falls back to the new-profile defaults', async () => {
    // load() swallows the parse error and returns the defaults. The corrupt
    // blob is left on disk untouched, which is the pre-existing contract
    // (migrateStripClientRules does the same) — we do not want a migration
    // to destroy a blob it merely failed to understand.
    const r = await resolve('{not json');
    assert.equal(r.proxied, true, 'should fall back to the always-allow-through-proxy default');
    assert.equal(r.raw, '{not json', 'a blob we cannot parse should not be rewritten');
});
