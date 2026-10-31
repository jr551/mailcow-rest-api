import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'follow-up-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'message-follow-up.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/message-follow-up.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

describe('message follow-up flags (slice 18)', () => {
    it('presets produce due instants in the future (except no-date)', async () => {
        const { followUpDueForPreset } = await loadModule();
        const now = Date.parse('2026-06-03T10:00:00');
        const todayDue = followUpDueForPreset('today', now);
        assert.ok(todayDue !== null && todayDue > now);
        const tomorrowDue = followUpDueForPreset('tomorrow', now);
        assert.ok(tomorrowDue !== null && tomorrowDue > now);
        const weekDue = followUpDueForPreset('this-week', now);
        assert.ok(weekDue !== null && weekDue > now);
        assert.equal(followUpDueForPreset('no-date', now), null);
    });

    it('labels due dates for list rows', async () => {
        const { followUpDueForPreset, followUpDueLabel } = await loadModule();
        const now = Date.parse('2026-06-03T10:00:00');
        assert.equal(followUpDueLabel(followUpDueForPreset('today', now), now), 'Follow up today');
        assert.equal(followUpDueLabel(followUpDueForPreset('tomorrow', now), now), 'Follow up tomorrow');
    });

    it('stores due by mailbox + uid key', async () => {
        const {
            emptyFollowUpOverlay,
            followUpOverlayKey,
            getFollowUpDueMs,
            sanitizeFollowUpOverlay
        } = await loadModule();
        const overlay = emptyFollowUpOverlay();
        const key = followUpOverlayKey('INBOX', 42);
        overlay.dueBy[key] = Date.parse('2026-06-10T23:59:59');
        assert.equal(getFollowUpDueMs(overlay, 'INBOX', 42), overlay.dueBy[key]);
        const parsed = sanitizeFollowUpOverlay(JSON.parse(JSON.stringify(overlay)));
        assert.equal(getFollowUpDueMs(parsed, 'INBOX', 42), overlay.dueBy[key]);
    });
});
