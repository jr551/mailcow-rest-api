// Regression tests for the webmail app shell (Layout, FloatingPanel, pwa,
// takeover notice, shortcuts, global styles). Behavioural where the helper is
// plain TypeScript, source-pinned where the logic lives inside a Svelte
// component the unit harness cannot mount.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');
const layout = read('components/Layout.svelte');
const panel = read('components/FloatingPanel.svelte');
const notice = read('components/TakeoverNotice.svelte');
const pwa = read('lib/pwa.svelte.ts');
const sidebar = read('components/Sidebar.svelte');
const css = read('app.css');
const focusTrap = read('lib/focus-trap.ts');

globalThis.window = { location: new URL('https://mail.example.test/webmail/') };
const { safeShortcutUrl, shortcutSandbox } = await import('../../src/lib/shortcuts-store.ts');

test('shortcut URLs: only http(s) survive', () => {
    assert.equal(safeShortcutUrl('https://wiki.example.com/a'), 'https://wiki.example.com/a');
    assert.equal(safeShortcutUrl('http://intranet/x'), 'http://intranet/x');
    assert.equal(safeShortcutUrl('/webmail/foo'), 'https://mail.example.test/webmail/foo');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'blob:https://x/y', 'file:///etc/passwd', '', null, undefined]) {
        assert.equal(safeShortcutUrl(bad), null, String(bad));
    }
});

test('shortcut sandbox: same-origin frames never get allow-same-origin', () => {
    assert.ok(!shortcutSandbox('https://mail.example.test/webmail/x').split(' ').includes('allow-same-origin'));
    assert.ok(shortcutSandbox('https://wiki.example.com/').split(' ').includes('allow-same-origin'));
});

test('shortcut surfaces go through the URL allowlist', () => {
    assert.match(layout, /safeShortcutUrl\(sc\.url\)/);
    for (const f of ['components/ShortcutEmbed.svelte', 'components/ShortcutPopup.svelte']) {
        const src = read(f);
        assert.match(src, /safeShortcutUrl\(shortcut\.url\)/, f);
        assert.ok(!src.includes('sandbox="allow-same-origin'), `${f} must not hard-code allow-same-origin`);
    }
});

test('refreshMessages keys the cache by the request, not the current selection', () => {
    assert.match(layout, /cache\.putMessageList\(reqUser, reqPath, reqPage, search, r\)/);
    assert.ok(!/cache\.putMessageList\(currentUser\(\), ui\.selectedPath/.test(layout));
    assert.match(layout, /if \(!stillWanted\(\)\) return;/);
});

test('infinite scroll and the crawler keep the list filter', () => {
    assert.ok(!layout.includes('const search = ui.search || undefined;'));
    assert.equal((layout.match(/const search = effectiveSearch\(\);/g) || []).length >= 3, true);
});

test('Layout carries no mobile-PWA dead branches', () => {
    for (const needle of ['isMobilePwa', 'startNetworkWatchdog', 'prefetchFolderPages', 'FIRST_LOAD_BUDGET_MS']) {
        assert.ok(!layout.includes(needle), needle);
    }
});

test('global arrow/Escape handler stays out of other apps, dialogs and handled events', () => {
    const fn = layout.slice(layout.indexOf('function onKey('));
    assert.match(fn, /e\.defaultPrevented \|\| ui\.app !== 'mail'/);
    assert.match(fn, /closest\?\.\(OVERLAY_SELECTOR\)/);
    assert.ok(!/if \(ui\.composeOpen\) ui\.composeOpen = false/.test(fn), 'Layout must not discard compose on Escape');
});

test('Undo is tied to a fresh recordUndo, not to toast wording', () => {
    assert.ok(!layout.includes('/Trash|Archive|Moved/'));
    assert.match(layout, /ui\.toast\.ts - ui\.undo\.ts < 1000/);
});

test('background refresh leaves all-folders search results alone', () => {
    assert.match(layout, /async function refreshVisibleList\(\) \{\s*if \(ui\.searchScope === 'all'\) return;/);
    assert.equal((layout.match(/refreshVisibleList\(\)/g) || []).length, 3);
});

test('FloatingPanel Escape ignores handled events and text fields; trap follows minimise', () => {
    assert.match(panel, /e\.defaultPrevented/);
    assert.match(panel, /closeOnEscape/);
    assert.match(panel, /if \(!dialogEl \|\| geo\.minimized\) return;\s*return trapFocus\(dialogEl, false\);/);
});

test('trapFocus hands focus back to the opener on release', () => {
    assert.match(focusTrap, /export function captureOpener/);
    assert.match(focusTrap, /opener\.focus\(\)/);
});

test('TakeoverNotice only handles Escape while a notice is showing', () => {
    assert.match(notice, /e\.key === 'Escape' && item/);
});

test('service worker first claim and open compose do not force a reload', () => {
    assert.match(pwa, /let hadController = !!navigator\.serviceWorker\.controller;/);
    assert.match(pwa, /if \(!hadController\) \{ hadController = true; return; \}/);
    assert.match(pwa, /if \(reloading \|\| ui\.composeOpen\) return;/);
});

test('sidebar caret reflects and announces the expanded state', () => {
    assert.match(sidebar, /expanded \? 'chevronDown' : 'chevronRight'/);
    assert.match(sidebar, /aria-expanded=\{expanded\}/);
});

test('auto-dark palette carries --border-focus and motion is reduced globally', () => {
    const auto = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    assert.match(auto.slice(0, auto.indexOf('\n}\n')), /--border-focus: #6cb2f7;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
