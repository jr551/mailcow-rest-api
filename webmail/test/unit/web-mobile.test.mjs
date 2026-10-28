// Invariants for the mobile shell (src/mobile). Source-level pins for the
// defects fixed in the simplify/security pass; the behaviour itself is
// covered by test/e2e/mobile*.spec.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const inbox = read('src/mobile/components/InboxView.svelte');
const messageView = read('src/mobile/components/MessageView.svelte');
const store = read('src/mobile/lib/store.svelte.ts');
const app = read('src/mobile/App.svelte');
const settingsView = read('src/mobile/components/SettingsView.svelte');
const swipe = read('src/mobile/components/SwipeableRow.svelte');
const aiChat = read('src/mobile/components/AiChatView.svelte');
const compose = read('src/mobile/components/ComposeView.svelte');
const drive = read('src/mobile/components/DriveView.svelte');
const folders = read('src/mobile/components/FoldersView.svelte');
const html = read('mobile/index.html');

test('inbox row actions target the row\'s own folder and key rows by folder + uid', () => {
    assert.match(inbox, /const rowPath = \(msg: MessageListItem\) => msg\.mailbox \?\? mobileState\.selectedPath/);
    assert.match(inbox, /\{#each filtered as msg \(rowKey\(msg\)\)\}/);
    assert.ok(!/\{#each filtered as msg \(msg\.uid\)\}/.test(inbox), 'uid alone collides across folders');
    // No per-row action may fall back to the selected folder directly.
    for (const fn of ['toggleStar', 'trashMessage', 'archiveMessage', 'actionToggleRead']) {
        const start = inbox.indexOf(`async function ${fn}(`);
        assert.ok(start > 0, `${fn} exists`);
        const body = inbox.slice(start, inbox.indexOf('\n    }\n', start));
        assert.ok(!body.includes('mobileState.selectedPath'), `${fn} must resolve the folder via rowPath`);
    }
});

test('the phishing scan never runs when the setting is off', () => {
    const effect = messageView.slice(messageView.indexOf('// --- Phishing scan'), messageView.indexOf('scanEmailForPhishing('));
    assert.match(effect, /!settings\.phishingScan/);
    assert.match(effect, /AI Conversations/);
    assert.match(messageView, /const phishingFlagged = \$derived\(/);
    assert.match(messageView, /class:blurred=\{phishingFlagged/);
    assert.match(messageView, /\{#if phishingFlagged && !phishingDismissed\}/);
});

test('sign-out and account changes reset per-account mobile state', () => {
    assert.match(store, /export function resetMobileState\(\)/);
    assert.match(settingsView, /resetMobileState\(\);/);
    assert.match(app, /resetMobileState\(\)/);
});

test('error toasts are shown, with raw backend detail kept out of the message', () => {
    const fn = store.slice(store.indexOf('export function showToast'), store.indexOf('export function clearToast'));
    assert.ok(!fn.includes('suppressed'), 'errors must not be dropped');
    assert.match(fn, /detail\?: unknown/);
    assert.match(app, /role=\{mobileState\.toast\.kind === 'error' \? 'alert' : 'status'\}/);
    for (const [name, src] of [['ComposeView', compose], ['MessageView', messageView], ['SettingsView', settingsView]]) {
        // The message argument is always a literal; raw error text goes in `detail`.
        assert.ok(!/showToast\('error', (?!["'])/.test(src), `${name} must pass a literal message`);
        assert.ok(!/showToast\('error', `[^`]*\$\{/.test(src), `${name} must not interpolate error text`);
    }
});

test('write approvals show what will be written', () => {
    assert.match(aiChat, /function describeArgs\(/);
    assert.match(aiChat, /\{#each describeArgs\(w\.args\)/);
    assert.ok(!aiChat.includes('{@html describeArgs'), 'args are rendered as escaped text');
});

test('the AI turn can be stopped and ignores IME composition', () => {
    assert.match(aiChat, /abortCtrl\?\.abort\(\)/);
    assert.match(aiChat, /data-testid="ai-stop"/);
    assert.match(aiChat, /e\.isComposing \|\| e\.keyCode === 229/);
    assert.match(aiChat, /return denyPending;/);
});

test('reply all excludes the user, their aliases and the sender from Cc', () => {
    const fn = compose.slice(compose.indexOf('function buildReplyAllCc'), compose.indexOf('$effect(() => {\n        if (replyTo'));
    assert.match(fn, /skipAddr\(authState\.activeUser\)/);
    assert.match(fn, /sendFromOptions\.forEach\(skipAddr\)/);
    assert.match(fn, /replyTo\.envelope\.from\?\.forEach/);
    assert.match(compose, /cc = buildReplyAllCc\(\);/);
});

test('drive uses the mobile toast store and confirms bulk deletes', () => {
    assert.match(drive, /import \{ showToast, pushOverlay \} from '\.\.\/lib\/store\.svelte'/);
    assert.ok(!drive.includes("'../../lib/store.svelte'"), 'desktop toast store is invisible on mobile');
    const touchMove = drive.slice(drive.indexOf('function onTouchMove'), drive.indexOf('async function onTouchEnd'));
    assert.ok(!touchMove.includes('preventDefault'), 'passive touchmove cannot be cancelled');
    assert.match(drive, /confirm-delete-btn/);
    assert.ok(!/class="delete-btn" onclick=\{deleteSelected\}/.test(drive));
});

test('folder rows only select; a separate chevron toggles expansion', () => {
    assert.match(folders, /class="expand-btn"/);
    assert.match(folders, /aria-expanded=\{expanded\.has\(mb\.path\)\}/);
    assert.ok(!/toggleExpand\(mb\.path\);\s*\}\s*selectFolder/.test(folders));
    const fn = folders.slice(folders.indexOf('function selectFolder'), folders.indexOf('function renderNodes'));
    for (const reset of ['messages = []', 'messagesTotal = 0', "searchScope = 'folder'", 'messagesError = null']) {
        assert.ok(fn.includes(reset), `selectFolder resets ${reset}`);
    }
});

test('a swipe drag does not also open the row', () => {
    assert.match(swipe, /suppressClick = moved;/);
    assert.ok(!swipe.includes('Math.abs(currentX) < 8'), 'currentX is already reset when click fires');
});

test('viewport allows pinch zoom', () => {
    assert.ok(!html.includes('user-scalable=no'));
});
