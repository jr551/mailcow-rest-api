import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'mobile-compose-schedule-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'mobile-compose-schedule.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        [
            '--bundle',
            '--loader:.ts=ts',
            '--format=esm',
            `--outfile=${out}`,
            path.join(webmailRoot, 'src/lib/mobile-compose-schedule.ts')
        ],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

describe('mobile-compose-schedule (slice 36)', () => {
    it('formats queued toast with scheduled time', async () => {
        const mod = await loadModule();
        const now = Date.parse('2026-10-31T12:00:00');
        const sendAt = now + 60 * 60 * 1000;
        const msg = mod.mobileScheduledSendQueuedMessage(sendAt, now);
        assert.match(msg, /^Send scheduled for /);
        assert.match(msg, /1:00|13:00/);
    });
});
