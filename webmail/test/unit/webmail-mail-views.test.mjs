// Regression tests for the message list / reading pane / compose pass.
//
// The two lib modules with real logic (spam-feedback, spam-sweep) are loaded
// through esbuild with their local imports stubbed, as privacy-migration does.
// The Svelte components cannot run under node, so the fixes that live in
// them are pinned with source assertions on the exact guard they added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const src = (p) => path.join(webmailRoot, 'src', p);

const tmp = mkdtempSync(path.join(tmpdir(), 'mail-views-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

const stubsUrl = pathToFileURL(path.join(tmp, 'stubs.mjs')).href;
writeFileSync(path.join(tmp, 'stubs.mjs'),
    'export const calls = { listMessages: [], moveMessage: [] };\n'
    + 'export const hooks = { move: async () => {}, total: 1000 };\n'
    + 'export const listMailboxes = async () => [{ path: "INBOX", name: "INBOX", specialUse: "\\\\Inbox" }];\n'
    + 'export const listMessages = async (_p, o) => {\n'
    + '  calls.listMessages.push({ ...o });\n'
    + '  const start = o.page * o.pageSize;\n'
    + '  const n = Math.max(0, Math.min(o.pageSize, hooks.total - start));\n'
    + '  return { messages: Array.from({ length: n }, (_, i) => ({ uid: start + i + 1 })) };\n'
    + '};\n'
    + 'export const getMessage = async (_p, uid) => ({ uid, envelope: { from: [{ address: "a@b.c" }], to: [] }, text: "", html: "", attachments: [] });\n'
    + 'export const moveMessage = async (p, uid, d) => { calls.moveMessage.push(uid); return hooks.move(uid); };\n'
    + 'export const scanEmailForPhishing = async () => ({ isPhishing: false, isSpam: false });\n'
    + 'export const envelopeToHeaders = () => ({});\n'
    + 'export const settings = { spamSweepBatchSize: 150 };\n');

function load(file, name) {
    const out = path.join(tmp, `${name}.mjs`);
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--loader:.ts=ts', '--format=esm', `--outfile=${out}`, src(file)],
        { stdio: 'pipe' }
    );
    writeFileSync(out, readFileSync(out, 'utf8').replace(/from\s+"\.\/[^"]*"/g, `from "${stubsUrl}"`));
    return import(`${pathToFileURL(out).href}?t=${Date.now()}${Math.random()}`);
}

function fakeStorage() {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k)
    };
}

test('markTrusted trusts the exact address, never the whole domain', async () => {
    fakeStorage();
    globalThis.$state = (v) => v;
    const fb = await load('lib/spam-feedback.svelte.ts', 'fb1');
    fb.markTrusted('Alice@Gmail.com');
    assert.equal(fb.isTrustedSender('alice@gmail.com'), true);
    assert.equal(fb.isTrustedSender('stranger@gmail.com'), false, 'one click must not trust every gmail.com sender');
    assert.deepEqual(fb.spamFeedback.trustedDomains, []);
});

test('addTrustedDomain is explicit and refuses free-mail providers', async () => {
    fakeStorage();
    globalThis.$state = (v) => v;
    const fb = await load('lib/spam-feedback.svelte.ts', 'fb2');
    assert.equal(fb.addTrustedDomain('gmail.com'), false);
    assert.equal(fb.addTrustedDomain('@Corp.Example'), true);
    assert.equal(fb.isTrustedSender('anyone@corp.example'), true);
    // Removing an address never silently drops an explicit domain entry.
    fb.markTrusted('boss@corp.example');
    fb.removeTrusted('boss@corp.example');
    assert.equal(fb.isTrustedSender('anyone@corp.example'), true);
    fb.removeTrustedDomain('corp.example');
    assert.equal(fb.isTrustedSender('anyone@corp.example'), false);
});

test('spam sweep reads 0-based pages and never asks for more than 100 per page', async () => {
    const stubs = await import(stubsUrl);
    stubs.calls.listMessages.length = 0;
    stubs.hooks.total = 1000;
    const sweep = await load('lib/spam-sweep.ts', 'sweep1');
    await sweep.runSpamSweep();
    assert.deepEqual(stubs.calls.listMessages.map((c) => [c.page, c.pageSize]), [[0, 100], [1, 50]]);
});

test('spam sweep stops paging when the inbox runs out', async () => {
    const stubs = await import(stubsUrl);
    stubs.calls.listMessages.length = 0;
    stubs.hooks.total = 30;
    const sweep = await load('lib/spam-sweep.ts', 'sweep2');
    await sweep.runSpamSweep();
    assert.equal(stubs.calls.listMessages.length, 1);
});

test('bulkMove reports failures and returns only the items that moved', async () => {
    const stubs = await import(stubsUrl);
    stubs.hooks.move = async (uid) => { if (uid === 2) throw new Error('nope'); };
    const sweep = await load('lib/spam-sweep.ts', 'sweep3');
    const progress = [];
    const r = await sweep.bulkMove(
        [1, 2, 3].map((uid) => ({ path: 'INBOX', uid })),
        'Trash',
        (done, total, failed) => progress.push([done, total, failed])
    );
    assert.equal(r.moved, 2);
    assert.equal(r.failed, 1);
    assert.deepEqual(r.movedItems.map((i) => i.uid), [1, 3]);
    assert.deepEqual(progress, [[1, 3, 0], [2, 3, 1], [3, 3, 1]]);
});

const read = (p) => readFileSync(src(p), 'utf8');

test('compose escapes model-written reply text before inserting it as HTML', () => {
    const compose = read('components/Compose.svelte');
    assert.ok(!/`<p>\$\{p\.replace\(/.test(compose), 'AI reply paragraphs must go through escapeHtml');
    assert.equal((compose.match(/<p>\$\{escapeHtml\(p\)\.replace/g) || []).length, 2);
});

test('compose never sends an empty subject and honours Shift+Click', () => {
    const compose = read('components/Compose.svelte');
    assert.match(compose, /subject\.trim\(\) \|\| '\(no subject\)'/);
    assert.match(compose, /skipReview = e\.shiftKey/);
    assert.ok(!compose.includes('pendingSendArgs'));
});

test('message list row keydown ignores keys bubbling from nested buttons', () => {
    const list = read('components/MessageList.svelte');
    assert.match(list, /function rowKey[\s\S]*?if \(e\.target !== e\.currentTarget\) return;/);
});

test('select all only selects rows the active filter shows', () => {
    const list = read('components/MessageList.svelte');
    assert.match(list, /ui\.selected = new Set\(filtered\.map\(\(m\) => m\.uid\)\)/);
    assert.ok(!list.includes('selectAllVisible'));
});

test('the phishing bubble dismiss button no longer trusts the sender', () => {
    const detail = read('components/MessageDetail.svelte');
    assert.match(detail, /aria-label="Dismiss warning"/);
    assert.ok(!detail.includes('aria-label="Mark as trusted"'));
    assert.match(detail, /isTrustedSender\([^)]*\) && !authFailed\(detail\.auth\)/);
});
