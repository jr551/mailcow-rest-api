import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'pin-snooze-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'message-pin-snooze.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/message-pin-snooze.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

const pathName = 'INBOX';

function msg(uid) {
    return {
        uid,
        seq: uid,
        flags: ['\\Seen'],
        size: 100,
        internalDate: new Date(2026, 0, uid).toISOString(),
        envelope: {
            date: new Date(2026, 0, uid).toISOString(),
            subject: `m${uid}`,
            from: [{ name: 'A', address: 'a@example.com' }],
            to: [],
            cc: [],
            messageId: `<${uid}>`,
            inReplyTo: null
        }
    };
}

describe('message pin / snooze (slice 9)', () => {
    it('pins sort above the chosen list order', async () => {
        const { sortWithPinnedFirst, messageOverlayKey, emptyPinSnoozeOverlay } = await loadModule();
        const overlay = emptyPinSnoozeOverlay();
        overlay.pinned[messageOverlayKey(pathName, 1002)] = true;
        const list = [msg(1001), msg(1002), msg(1003)];
        const sorted = sortWithPinnedFirst(list, pathName, overlay, 'date-desc');
        assert.equal(sorted[0].uid, 1002);
    });

    it('hides snoozed messages until the wake time', async () => {
        const {
            filterOutSnoozedMessages,
            isMessageSnoozed,
            messageOverlayKey,
            emptyPinSnoozeOverlay
        } = await loadModule();
        const overlay = emptyPinSnoozeOverlay();
        const now = Date.parse('2026-06-01T12:00:00');
        overlay.snoozeUntil[messageOverlayKey(pathName, 1001)] = now + 60_000;
        assert.ok(isMessageSnoozed(overlay, pathName, 1001, now));
        assert.ok(!isMessageSnoozed(overlay, pathName, 1001, now + 120_000));
        const visible = filterOutSnoozedMessages([msg(1001), msg(1002)], pathName, overlay, now);
        assert.deepEqual(visible.map((m) => m.uid), [1002]);
    });

    it('snooze presets land in the future', async () => {
        const { snoozeUntilForPreset } = await loadModule();
        const now = Date.parse('2026-06-01T10:00:00');
        assert.ok(snoozeUntilForPreset('later-today', now) > now);
        assert.ok(snoozeUntilForPreset('tomorrow', now) > now);
        assert.ok(snoozeUntilForPreset('next-week', now) > now);
    });

    it('toggle pin state is keyed by mailbox + uid', async () => {
        const { isMessagePinned, messageOverlayKey, emptyPinSnoozeOverlay } = await loadModule();
        const overlay = emptyPinSnoozeOverlay();
        overlay.pinned[messageOverlayKey(pathName, 7)] = true;
        assert.ok(isMessagePinned(overlay, pathName, 7));
        assert.ok(!isMessagePinned(overlay, pathName, 8));
    });
});
