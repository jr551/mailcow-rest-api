// Invariants for the AI assistant takeover surface (webmail half).
//
// The one rule every assertion below serves: the browser side of takeover
// NEVER sends. The assistant drafts server-side and every draft stops at
// the approval gate — "Resume with advice" posts John's answer as context
// and nothing more. A send call appearing anywhere in these files is the
// bug this file exists to catch, in the same spirit as privacy-claims'
// citation audit.
//
// It also pins the shared modal convention (overlay + dialog + trapFocus,
// copied from LinkCheckPrompt.svelte) and the "no new timer" rule for the
// takeover surface: the notice is self-gating state, not a poller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const noticeSrc = readFileSync(new URL('../../src/components/TakeoverNotice.svelte', import.meta.url), 'utf8');
const stateSrc = readFileSync(new URL('../../src/lib/takeover.svelte.ts', import.meta.url), 'utf8');
const apiSrc = readFileSync(new URL('../../src/lib/api.ts', import.meta.url), 'utf8');
const settingsSrc = readFileSync(new URL('../../src/components/Settings.svelte', import.meta.url), 'utf8');
const layoutSrc = readFileSync(new URL('../../src/components/Layout.svelte', import.meta.url), 'utf8');

const SEND_MARKERS = ['sendStub', '/v1/messages/send', 'sendMessage(', 'smtp'];

test('takeover UI files contain no send path', () => {
    for (const [name, src] of [['TakeoverNotice.svelte', noticeSrc], ['takeover.svelte.ts', stateSrc]]) {
        for (const marker of SEND_MARKERS) {
            assert.ok(!src.includes(marker), `${name} must not reference ${marker} — resume with advice never sends`);
        }
    }
});

test('the takeover api helpers never touch the send endpoint', () => {
    const section = apiSrc.slice(apiSrc.indexOf('// ---------- AI assistant takeover ----------'));
    assert.ok(section.length > 0, 'the takeover section exists in api.ts');
    // Quoted form only: prose is allowed to name the approval gate, code
    // must not call it.
    assert.ok(!section.includes("'/v1/messages/send'"), 'takeover helpers must only talk to /v1/me/takeover*');
    for (const path of ['/v1/me/takeover', '/v1/me/takeover/needs-input', '/v1/me/takeover/stop']) {
        assert.ok(section.includes(path), `api.ts covers ${path}`);
    }
});

test('the notice uses the shared modal convention', () => {
    for (const needle of ['takeover-overlay', 'takeover-dialog', 'role="dialog"', 'aria-modal="true"', 'trapFocus(']) {
        assert.ok(noticeSrc.includes(needle), `TakeoverNotice.svelte is missing ${needle}`);
    }
    // The user is never trapped: Escape and the backdrop both leave.
    assert.ok(noticeSrc.includes('Escape'), 'Escape must dismiss the dialog');
});

test('the notice offers exactly the two required actions', () => {
    assert.ok(noticeSrc.includes('data-testid="takeover-resume"'), 'a [resume with advice] action exists');
    assert.ok(noticeSrc.includes('data-testid="takeover-stop"'), 'a [stop] action exists');
    assert.ok(noticeSrc.includes('Resume with advice'), 'the resume action is labelled for humans');
});

test('the AI disclosure is present wherever the assistant is described', () => {
    const DISCLOSURE = 'This reply came from my AI assistant.';
    assert.ok(noticeSrc.includes(DISCLOSURE), 'the notice names the signature the assistant uses');
    assert.ok(settingsSrc.includes(DISCLOSURE), 'Settings names the signature the assistant uses');
});

test('the minimum delay floor is presented as 5 minutes', () => {
    const card = settingsSrc.slice(settingsSrc.indexOf('data-testid="settings-takeover"'));
    assert.ok(card.length > 0, 'the takeover card exists in Settings');
    assert.ok(card.includes('min="5"'), 'the delay knob cannot suggest less than the server floor');
});

test('the takeover surface adds no timers', () => {
    for (const [name, src] of [['TakeoverNotice.svelte', noticeSrc], ['takeover.svelte.ts', stateSrc]]) {
        for (const timer of ['setInterval(', 'setTimeout(']) {
            assert.ok(!src.includes(timer), `${name} must not add ${timer} — the notice is self-gating, not a poller`);
        }
    }
    assert.equal((layoutSrc.match(/<TakeoverNotice\s*\/>/g) || []).length, 1, 'Layout mounts the notice exactly once');
});

test('the state module exposes the surface contract', () => {
    for (const name of [
        'export const takeover',
        'export function takeoverNoticeItem',
        'export function takeoverActive',
        'export async function loadTakeover',
        'export async function setTakeoverEnabled',
        'export async function setTakeoverKnobs',
        'export async function answerTakeoverItem',
        'export async function stopTakeoverItem',
        'export function dismissTakeoverNotice'
    ]) {
        assert.ok(stateSrc.includes(name), `takeover.svelte.ts exports ${name}`);
    }
});

test('notice dismissal is persisted, so it does not nag on every open', () => {
    assert.ok(stateSrc.includes('localStorage'), 'dismissals survive a reload');
    assert.ok(stateSrc.includes('webmail.takeover-dismissed'), 'dismissals live under their own storage key');
});
