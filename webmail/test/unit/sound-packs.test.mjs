// The sound packs grew from six to twelve and gained a STYLE axis. The
// parts of that worth pinning down are the ones where a mistake is silent:
//
//   * every pack in the union must be reachable in the picker. The original
//     bug was exactly this: 'ting' and 'blip' existed in the module and in
//     the stored profile but were hardcoded out of the Settings list, so no
//     user could ever select them. Adding a pack that never renders is the
//     same bug wearing a new hat.
//   * the stored-profile validator must ACCEPT the new ids and must still
//     fall back to the default for ids that don't exist — an unknown pack
//     must not poison the Record, and a new pack must not require editing
//     a second list.
//   * both styles must be non-empty, or "choose a style" is a dead end.
//   * the deliberate default profile (only new-mail + sent audible) must
//     survive, because it is a documented user decision.
//
// The module is loaded through esbuild with the Svelte rune globals
// stubbed, exercising the real loadProfile() rather than a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const soundsPath = path.join(webmailRoot, 'src/lib/sounds.svelte.ts');

const tmp = mkdtempSync(path.join(tmpdir(), 'sound-packs-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

execFileSync(
    path.join(webmailRoot, 'node_modules/.bin/esbuild'),
    ['--loader:.ts=ts', '--format=esm', `--outfile=${path.join(tmp, 'sounds.mjs')}`, soundsPath],
    { stdio: 'pipe' }
);

const PROFILE_KEY = 'webmail.sounds.profile.v1';

let loadCounter = 0;
/** Import the module fresh against a seeded profile blob. */
async function loadWith(blob) {
    loadCounter += 1;
    const store = new Map();
    if (blob !== null) store.set(PROFILE_KEY, blob);
    globalThis.localStorage = {
        getItem: k => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k)
    };
    globalThis.$state = v => v;
    globalThis.$derived = v => v;
    globalThis.$effect = () => { };
    return import(`${pathToFileURL(path.join(tmp, 'sounds.mjs')).href}?case=${loadCounter}`);
}

const fresh = await loadWith(null);
const { SOUND_PACKS, SOUND_STYLES, SOUND_EVENTS, packsInStyle, previewPack } = fresh;

test('both knockoff styles are populated', () => {
    for (const style of SOUND_STYLES) {
        const members = packsInStyle(style.id);
        assert.ok(members.length > 0, `style ${style.id} has no packs`);
    }
});

test('every pack id is unique and reaches the picker', () => {
    const ids = SOUND_PACKS.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate pack id');
    // The union the picker renders is exactly the declared union — a pack
    // that exists but is filtered out of every group is unreachable.
    const grouped = SOUND_STYLES.flatMap(s => packsInStyle(s.id).map(p => p.id));
    assert.deepEqual(grouped.slice().sort(), ids.slice().sort());
});

test('every pack carries a label and a blurb', () => {
    for (const p of SOUND_PACKS) {
        assert.ok(p.label.trim(), `${p.id} has no label`);
        assert.ok(p.blurb.trim(), `${p.id} has no blurb`);
    }
});

test('playing every pack is safe and does not throw', () => {
    // No AudioContext in this environment, so playPack exercises its
    // ctxOrNull() early-out — but the dispatch still has to reach every
    // branch without a typo'd identifier or a missing tone() argument.
    for (const p of SOUND_PACKS) {
        assert.doesNotThrow(() => previewPack(p.id), `${p.id} threw`);
    }
});

test('new pack ids survive a stored-profile round trip', () => {
    const { sounds, setEventPack } = fresh;
    setEventPack('notify', 'out-arrival');
    setEventPack('sent', 'gm-drop');
    setEventPack('error', 'gm-mail');
    const raw = globalThis.localStorage.getItem(PROFILE_KEY);
    assert.ok(raw, 'setEventPack did not persist');
    return loadWith(raw).then(reloaded => {
        assert.equal(reloaded.sounds.profile.notify, 'out-arrival');
        assert.equal(reloaded.sounds.profile.sent, 'gm-drop');
        assert.equal(reloaded.sounds.profile.error, 'gm-mail');
    });
});

test('unknown and malformed pack ids fall back to the default, valid siblings survive', async () => {
    // One bad entry must not take the rest of the profile down with it:
    // the valid 'sent' value is kept, and only the bad keys revert.
    const mod = await loadWith(JSON.stringify({
        notify: 'pack-from-the-future',
        sent: 'gm-pop',
        error: 42
    }));
    assert.equal(mod.sounds.profile.notify, 'chime', 'unknown id did not fall back');
    assert.equal(mod.sounds.profile.error, 'silent', 'non-string id did not fall back');
    assert.equal(mod.sounds.profile.sent, 'gm-pop', 'valid sibling was discarded');
});

test('the deliberate default profile is preserved', async () => {
    const mod = await loadWith(null);
    assert.equal(mod.sounds.profile.notify, 'chime');
    assert.equal(mod.sounds.profile.sent, 'soft');
    for (const id of ['error', 'sortDone', 'voiceStart', 'click']) {
        assert.equal(mod.sounds.profile[id], 'silent', `${id} should default to silent`);
    }
});

test('a corrupt or non-object profile blob falls back wholesale', async () => {
    for (const blob of ['not json at all', 'null', '42', '"a string"', '[1,2,3]']) {
        const mod = await loadWith(blob);
        assert.equal(mod.sounds.profile.notify, 'chime', `blob ${blob} did not fall back`);
        assert.equal(mod.sounds.profile.sent, 'soft');
    }
});

test('every declared event has a picker row and a default', async () => {
    const mod = await loadWith(null);
    for (const ev of SOUND_EVENTS) {
        assert.ok(ev.label, `${ev.id} has no label`);
        assert.ok(mod.sounds.profile[ev.id], `${ev.id} has no default pack`);
    }
});
