// Regression tests for the webmail login / credentials / settings-sync /
// setup-diagnostics area. The real modules are transpiled with esbuild and
// loaded with their sibling imports rewired, so these exercise the shipped
// code rather than copies of it:
//
//   * sign-out must forget the remembered credentials, otherwise the login
//     screen signs the user straight back in on the next load;
//   * a per-account sign-out must not leave other accounts' tokens in
//     localStorage when permanent sign-in is off;
//   * the sign-in handoff must refuse a token that belongs to somebody else
//     than the mailbox the link names;
//   * settings sync must neither write nor accept the LLM provider block or
//     permanentSignIn, and must validate everything else it is handed;
//   * the vault install key must come from the CSPRNG;
//   * setup checks must go through apiUrl() so a cross-origin API works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const lib = (f) => path.join(webmailRoot, 'src/lib', f);

const tmp = mkdtempSync(path.join(tmpdir(), 'web-settings-auth-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

const urlOf = (f) => pathToFileURL(path.join(tmp, f)).href;
const MODULES = {
    './keychain': 'keychain.mjs',
    './auth.svelte': 'auth.mjs',
    './settings.svelte': 'settings.mjs',
    './settings-sync': 'sync.mjs',
    './setup-diagnostics.svelte': 'diag.mjs',
    './api': 'api-stub.mjs',
    './spam-feedback.svelte': 'spam-stub.mjs'
};

for (const [src, out] of [
    ['keychain.ts', 'keychain.mjs'],
    ['auth.svelte.ts', 'auth.mjs'],
    ['settings.svelte.ts', 'settings.mjs'],
    ['settings-sync.ts', 'sync.mjs'],
    ['setup-diagnostics.svelte.ts', 'diag.mjs']
]) {
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--loader:.ts=ts', '--format=esm', `--outfile=${path.join(tmp, out)}`, lib(src)],
        { stdio: 'pipe' }
    );
    const code = readFileSync(path.join(tmp, out), 'utf8').replace(
        /from\s+"(\.\/[^"]+)"/g,
        (m, spec) => (MODULES[spec] ? `from "${urlOf(MODULES[spec])}"` : m)
    );
    writeFileSync(path.join(tmp, out), code);
}

writeFileSync(path.join(tmp, 'api-stub.mjs'), `
export const apiBase = () => globalThis.__apiBase ?? '';
export const apiUrl = (p) => (globalThis.__apiBase ?? '') + p;
export const getAiConfig = async () => null;
export const getTtsConfig = async () => null;
export const listMessages = async () => ({ messages: [] });
export const getRawMessage = async () => '';
export const appendRawMessage = async () => {};
export const createMailbox = async () => {};
export const deleteMessage = async () => {};
`);
writeFileSync(path.join(tmp, 'spam-stub.mjs'), `
export const spamFeedback = { trustedDomains: ['a.test'], trustedAddresses: [], spamDomains: [], spamAddresses: [] };
`);

function memStore() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _m: m
    };
}

let counter = 0;
function env({ settings = null, base = '' } = {}) {
    counter += 1;
    globalThis.localStorage = memStore();
    globalThis.sessionStorage = memStore();
    if (settings) globalThis.localStorage.setItem('webmail.settings.v1', JSON.stringify(settings));
    globalThis.location = { protocol: 'https:', pathname: '/webmail/', hash: '', search: '' };
    globalThis.window = { location: globalThis.location };
    globalThis.document = { cookie: '', documentElement: { classList: { contains: () => false } } };
    globalThis.history = { replaceState: () => {} };
    globalThis.$state = (v) => v;
    globalThis.$derived = (v) => v;
    globalThis.$effect = () => {};
    globalThis.__apiBase = base;
    return counter;
}

const load = (file, n) => import(`${urlOf(file)}?case=${n}`);

const FAR = Date.now() + 3600_000;

test('removeSession forgets the remembered credentials of that account', async () => {
    const n = env();
    const auth = await load('auth.mjs', n);
    const kc = await import(urlOf('keychain.mjs'));
    kc.rememberCreds('a@x.test', 'pw-a');
    kc.rememberCreds('b@x.test', 'pw-b');
    auth.upsertSession({ user: 'a@x.test', token: 't-a', expiresAt: FAR });
    auth.upsertSession({ user: 'b@x.test', token: 't-b', expiresAt: FAR });
    auth.removeSession('b@x.test');
    assert.deepEqual(kc.rememberedUsers(), ['a@x.test']);
    assert.equal(kc.recallCreds('b@x.test'), null);
});

test('logoutRemote forgets credentials and revokes the token with DELETE /v1/auth/session', async () => {
    const n = env({ base: 'https://api.test' });
    const auth = await load('auth.mjs', n);
    const kc = await import(urlOf('keychain.mjs'));
    kc.rememberCreds('a@x.test', 'pw-a');
    auth.upsertSession({ user: 'a@x.test', token: 't-a', expiresAt: FAR });
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 204 }; };
    await auth.logoutRemote();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.test/v1/auth/session');
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].init.headers.authorization, 'Bearer t-a');
    assert.deepEqual(kc.rememberedUsers(), []);
});

test('setSession(null) (session-invalid path) leaves the vault for the silent re-login', async () => {
    const n = env();
    const auth = await load('auth.mjs', n);
    const kc = await import(urlOf('keychain.mjs'));
    kc.rememberCreds('a@x.test', 'pw-a');
    auth.upsertSession({ user: 'a@x.test', token: 't-a', expiresAt: FAR });
    auth.setSession(null);
    assert.equal(auth.authState.activeUser, null);
    assert.deepEqual(kc.rememberedUsers(), ['a@x.test']);
});

test('signing one account out does not copy the other token to localStorage when permanent sign-in is off', async () => {
    const n = env({ settings: { permanentSignIn: false } });
    const auth = await load('auth.mjs', n);
    auth.upsertSession({ user: 'a@x.test', token: 't-a', expiresAt: FAR });
    auth.upsertSession({ user: 'b@x.test', token: 't-b', expiresAt: FAR });
    auth.removeSession('a@x.test');
    assert.equal(globalThis.localStorage.getItem('webmail.session.perm.v1'), null);
});

test('with permanent sign-in on, the remaining account is still persisted; switching it off drops the copy', async () => {
    const n = env({ settings: { permanentSignIn: true } });
    const auth = await load('auth.mjs', n);
    auth.upsertSession({ user: 'a@x.test', token: 't-a', expiresAt: FAR });
    auth.upsertSession({ user: 'b@x.test', token: 't-b', expiresAt: FAR });
    auth.removeSession('a@x.test');
    const perm = JSON.parse(globalThis.localStorage.getItem('webmail.session.perm.v1'));
    assert.deepEqual(perm.sessions.map((s) => s.user), ['b@x.test']);
    auth.dropPermanentSession();
    assert.equal(globalThis.localStorage.getItem('webmail.session.perm.v1'), null);
});

test('handoff: a token that belongs to a different mailbox than wm_user is refused', async () => {
    const n = env();
    const auth = await load('auth.mjs', n);
    globalThis.location.hash = '#wm_token=attacker-token&wm_user=victim@corp.test';
    globalThis.fetch = async (url) => ({
        ok: true,
        json: async () => (String(url).endsWith('/v1/me/mailbox')
            ? { username: 'attacker@evil.test' }
            : { authenticated: true, expiresAt: new Date(FAR).toISOString() })
    });
    assert.equal(await auth.adoptHandoffSession(), false);
    assert.equal(auth.authState.sessions.length, 0);
});

test('handoff: a token that belongs to the named mailbox is adopted', async () => {
    const n = env();
    const auth = await load('auth.mjs', n);
    globalThis.location.hash = '#wm_token=good-token&wm_user=Me@Corp.test';
    globalThis.fetch = async (url) => ({
        ok: true,
        json: async () => (String(url).endsWith('/v1/me/mailbox')
            ? { username: 'me@corp.test' }
            : { authenticated: true, expiresAt: new Date(FAR).toISOString() })
    });
    assert.equal(await auth.adoptHandoffSession(), true);
    assert.equal(auth.authState.activeUser, 'me@corp.test');
});

test('handoff: a non-finite expiry is refused', async () => {
    const n = env();
    const auth = await load('auth.mjs', n);
    globalThis.location.hash = '#wm_token=t&wm_user=me@corp.test';
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ authenticated: true }) });
    assert.equal(await auth.adoptHandoffSession(), false);
});

test('the vault install key is 32 random bytes and the vault round-trips', async () => {
    env();
    const kc = await import(urlOf('keychain.mjs'));
    kc.rememberCreds('a@x.test', 'päss');
    const id = globalThis.localStorage.getItem('webmail.install-id');
    assert.equal(atob(id).length, 32);
    assert.deepEqual(kc.recallCreds('a@x.test'), { user: 'a@x.test', pass: 'päss' });
});

test('mobile session cookie is Secure on https', async () => {
    const n = env();
    globalThis.location.pathname = '/webmail/mobile/';
    globalThis.window.location.pathname = '/webmail/mobile/';
    const auth = await load('auth.mjs', n);
    auth.upsertSession({ user: 'a@x.test', token: 't-a', expiresAt: FAR });
    assert.match(globalThis.document.cookie, /; Secure$/);
});

test('sanitizeSnapshot keeps only known, synced, valid settings', async () => {
    const n = env();
    const sync = await load('sync.mjs', n);
    const hostile = JSON.parse(`{
        "v": 1, "ts": 1e15,
        "settings": {
            "__proto__": { "polluted": true },
            "llm": { "kind": "openai", "apiKey": "sk-x", "baseUrl": "https://evil.test" },
            "useCustomLlm": true,
            "permanentSignIn": true,
            "clientRules": [1],
            "somethingElse": 1,
            "pageSize": 5000000,
            "weatherLatitude": 9999,
            "density": "compact"
        },
        "spamFeedback": {
            "trustedDomains": "nope",
            "spamDomains": ["ok.test", 5, null, "${'x'.repeat(400)}"],
            "spamAddresses": []
        }
    }`);
    const snap = sync.sanitizeSnapshot(hostile);
    assert.ok(snap);
    assert.ok(snap.ts <= Date.now() + 6 * 60 * 1000, 'far-future ts is clamped');
    assert.deepEqual(Object.keys(snap.settings).sort(), ['density', 'pageSize', 'weatherLatitude']);
    assert.equal(snap.settings.density, 'compact');
    assert.equal(snap.settings.pageSize, 25);
    assert.equal(snap.settings.weatherLatitude, 90);
    assert.equal({}.polluted, undefined);
    assert.equal(snap.spamFeedback.trustedDomains, undefined);
    assert.deepEqual(snap.spamFeedback.spamDomains, ['ok.test']);
    assert.deepEqual(snap.spamFeedback.spamAddresses, []);
});

test('sanitizeSnapshot rejects malformed envelopes', async () => {
    const n = env();
    const sync = await load('sync.mjs', n);
    assert.equal(sync.sanitizeSnapshot(null), null);
    assert.equal(sync.sanitizeSnapshot({ v: 2, ts: 1, settings: {} }), null);
    assert.equal(sync.sanitizeSnapshot({ v: 1, ts: Infinity, settings: {} }), null);
    assert.equal(sync.sanitizeSnapshot({ v: 1, ts: 1, settings: [] }), null);
});

test('the pushed snapshot never carries the LLM key or permanentSignIn', async () => {
    const n = env({ settings: { useCustomLlm: true, llm: { kind: 'openai', apiKey: 'sk-secret', baseUrl: 'https://p.test' }, permanentSignIn: true } });
    const sync = await load('sync.mjs', n);
    const snap = sync.snapshotNow();
    const text = JSON.stringify(snap);
    assert.ok(!text.includes('sk-secret'));
    for (const k of ['llm', 'useCustomLlm', 'permanentSignIn']) assert.ok(!(k in snap.settings), k);
    assert.ok('density' in snap.settings);
});

test('setup checks go through apiUrl() so a cross-origin API is reachable', async () => {
    const n = env({ base: 'https://api.example' });
    const diag = await load('diag.mjs', n);
    const seen = [];
    globalThis.fetch = async (url) => {
        seen.push(url);
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, clone() { return this; }, json: async () => ({ openapi: '3' }) };
    };
    await diag.runSetupDiagnostics();
    assert.deepEqual(seen.sort(), [
        'https://api.example/health',
        'https://api.example/openapi.json',
        'https://api.example/v1/push/config'
    ]);
    assert.equal(diag.setupDiagnostics.apiBase, 'https://api.example');
    assert.equal(diag.setupIsBlocking(), false);
});
