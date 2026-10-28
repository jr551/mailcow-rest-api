// Regression tests for the AI chat / calendar / drive review pass.
//
// The pure drive-name helpers are imported and exercised directly. The rest
// of the code under test lives in Svelte rune modules (.svelte.ts) that plain
// node cannot load, so those invariants are pinned against the source text in
// the same style as takeover-surface.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');

const { validateDriveName, attachmentFileName, validateDriveRelPath } =
    await import('../../src/lib/drive-api.ts');

test('validateDriveName rejects traversal, separators and control characters', () => {
    for (const bad of ['', '   ', '.', '..', '../x', 'a/b', 'a\\b', 'bad\u0000name', 'x'.repeat(256)]) {
        assert.throws(() => validateDriveName(bad), undefined, JSON.stringify(bad));
    }
    assert.equal(validateDriveName('  report.pdf '), 'report.pdf');
    assert.equal(validateDriveName('..hidden'), '..hidden');
});

test('attachmentFileName strips directory parts and dot segments', () => {
    assert.equal(attachmentFileName('../../other/x.html'), 'x.html');
    assert.equal(attachmentFileName('C:\\Users\\me\\evil.exe'), 'evil.exe');
    assert.equal(attachmentFileName('..'), 'attachment');
    assert.equal(attachmentFileName(''), 'attachment');
    assert.equal(attachmentFileName('a\nb.txt'), 'a_b.txt');
    assert.equal(attachmentFileName('invoice.pdf'), 'invoice.pdf');
});

test('validateDriveRelPath keeps sub-folders but refuses dot segments', () => {
    assert.equal(validateDriveRelPath('photos/2024/a.jpg'), 'photos/2024/a.jpg');
    assert.throws(() => validateDriveRelPath('photos/../a.jpg'));
    assert.throws(() => validateDriveRelPath('./a.jpg'));
});

test('every drive writer validates the name it was given', () => {
    const src = read('lib/drive.svelte.ts');
    for (const fn of ['createFolder', 'saveAttachmentToDrive', 'saveTextFile', 'saveDrawing', 'renameItem', 'createDrawing']) {
        const start = src.indexOf(`function ${fn}(`);
        assert.ok(start > 0, `${fn} exists`);
        const body = src.slice(start, src.indexOf('\nexport ', start + 1));
        assert.ok(/validateDriveName|attachmentFileName/.test(body), `${fn} must sanitise its name`);
    }
    assert.ok(/validateDriveRelPath/.test(src), 'folder uploads validate their relative path');
});

test('drive folders are deleted recursively, not just their placeholder', () => {
    const src = read('lib/drive.svelte.ts');
    assert.ok(!/path \+ '\/'/.test(src), 'no more deleting only `path/`');
    assert.ok(src.includes('deleteFolder('), 'folder deletes go through deleteFolder');
    const api = read('lib/drive-api.ts');
    assert.ok(api.includes('continuation-token'), 'deleteFolder pages through the listing');
});

test('drive toolbar confirms bulk delete', () => {
    const src = read('components/drive/DriveToolbar.svelte');
    assert.ok(/confirm\(/.test(src));
    assert.ok(!/onclick=\{deleteSelected\}/.test(src));
});

test('office preview is opt-in and uses a short-lived URL', () => {
    const src = read('components/drive/DrivePreview.svelte');
    assert.ok(src.includes('OFFICE_URL_TTL_SEC'));
    assert.ok(!/encodeURIComponent\(url\)/.test(src), 'the default (long-lived) url never goes to the viewer');
    assert.ok(src.includes('openOfficeViewer'));
});

test('encodeKey refuses dot segments', () => {
    const api = read('lib/drive-api.ts');
    const fn = api.slice(api.indexOf('function encodeKey'), api.indexOf('const CONTROL_CHARS'));
    assert.ok(fn.includes("'..'"));
});

test('AI threads and caches are scoped to the signed-in account', () => {
    const src = read('lib/ai-threads.svelte.ts');
    assert.ok(src.includes('keyFor('), 'storage keys carry the user');
    assert.ok(!/localStorage\.(get|set)Item\((STORAGE_KEY|TOOLS_KEY|DELETED_KEY)/.test(src), 'no bare global keys');
    assert.ok(src.includes('syncScope'), 'state reloads when the account changes');
    assert.ok(/authState\.activeUser !== user\) return;\s*const rfc822/.test(src), 'sync never appends into another account');
    assert.ok(read('lib/ai-cache.svelte.ts').includes('authState.activeUser'), 'ai-cache hash includes the user');
});

test('calendar storage is scoped to the signed-in account and colours are validated', () => {
    const src = read('lib/calendar.svelte.ts');
    assert.ok(src.includes('scoped(base)'));
    assert.ok(src.includes('resetForUser'));
    assert.ok(src.includes('function safeColor'));
    assert.ok(!/color: (s|c|sub)\.color \|\| DEFAULT_COLOR/.test(src), 'raw colours never reach state');
    assert.ok(read('lib/phishing-scan.ts').includes("getSession()?.user"), 'phishing cache key includes the account');
});

test('calendar edit creates before deleting and delete failures surface', () => {
    const src = read('lib/calendar.svelte.ts');
    const update = src.slice(src.indexOf('export async function updateEvent'), src.indexOf('export async function deleteEvent'));
    assert.ok(update.indexOf('apiCreateEvent') < update.indexOf('apiDeleteEvent'), 'create first');
    assert.ok(!/catch \{ \/\* tolerate/.test(src), 'no swallowed API errors');
    const evt = read('components/calendar/EventModal.svelte');
    assert.ok(!evt.includes('cal-evt-recurrence'), 'Repeat is hidden until the server stores it');
});

test('calendar app keeps uids with @ and ignores modified keys', () => {
    const src = read('components/calendar/CalendarApp.svelte');
    assert.ok(!src.includes("split('@')"));
    assert.ok(src.includes('e.ctrlKey || e.metaKey'));
});

test('chat only runs offered tools and asks before risky calls', () => {
    const src = read('lib/chat.svelte.ts');
    assert.ok(src.includes('toolCatalog.some((t) => t.function.name === tc.name)'));
    assert.ok(src.includes('needsConsent(tc.name, parsed)'));
    // set_setting is fail-closed: only the listed cosmetic keys skip consent.
    assert.ok(src.includes('!LOW_RISK_SETTING_KEYS.has(String(args.key))'));
    const allowList = /LOW_RISK_SETTING_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
    for (const key of ['density', 'listFilter', 'weatherChip']) {
        assert.ok(allowList.includes(`'${key}'`), key);
    }
    for (const key of ['aiSystemPrompt', 'phishingScan', 'proxyImages', 'llmModel', 'useCustomLlm', 'defaultFromAddress', 'trackOpensDefault']) {
        assert.ok(!allowList.includes(`'${key}'`), `${key} must need consent`);
    }
    assert.ok(!src.includes('${args.uid}'), 'uids are validated before reaching a path');
    assert.ok(src.includes('uidSegment(args.uid)'));
});

test('stopping a chat turn denies parked approvals and aborts the tool loop', () => {
    const chat = read('lib/chat.svelte.ts');
    assert.ok(chat.includes('awaitConsent('));
    assert.ok(/opts\.signal\?\.aborted\) throw abortError\(\)/.test(chat));
    const app = read('components/ai/ChatApp.svelte');
    assert.ok(/function stop\(\) \{[^}]*denyAllPending\(\)/.test(app));
});

test('approval card shows every argument untruncated', () => {
    const app = read('components/ai/ChatApp.svelte');
    assert.ok(!/slice\(0, 4\)/.test(app));
    assert.ok(!/s\.slice\(0, 60\)/.test(app));
    assert.ok(app.includes('describeArgs(p.args)'));
});

test('inbox summary only keeps refUids from the page it showed the model', () => {
    assert.ok(read('lib/inbox-summary.ts').includes('pageUids.has(a.refUid)'));
});

test('geoip does not cache transient failures and checks IPv4-mapped addresses', () => {
    const src = read('lib/geoip.svelte.ts');
    assert.ok(src.includes("throw new Error(`geoip ${r.status}`)"));
    assert.ok(src.includes('retryAt'));
    assert.ok(src.includes('::ffff:'));
});

test('calendar-suggest errors no longer echo key fragments', () => {
    assert.ok(!read('lib/calendar-suggest.ts').includes('keyHint'));
});
