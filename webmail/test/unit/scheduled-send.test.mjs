import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'scheduled-send-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'scheduled-send.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/scheduled-send.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

describe('scheduled-send (slice 13)', () => {
    it('sanitizes send-at times within OWA-like bounds', async () => {
        const mod = await loadModule();
        const now = Date.parse('2026-10-30T12:00:00Z');
        const min = mod.minScheduledSendAt(now);
        assert.ok(min >= now + 60_000);
        assert.equal(mod.sanitizeSendAtMs(now, now), min);
        assert.ok(mod.sanitizeSendAtMs(now + mod.maxScheduledSendAt(now) - now + 999, now) <= mod.maxScheduledSendAt(now));
    });

    it('computes preset send times', async () => {
        const mod = await loadModule();
        const now = Date.parse('2026-10-30T12:00:00Z');
        const hour = mod.computePresetSendAt('in-one-hour', now);
        assert.equal(hour, mod.sanitizeSendAtMs(now + 3600_000, now));
        const tomorrow = mod.computePresetSendAt('tomorrow-morning', now);
        assert.ok(tomorrow > now + 3600_000);
    });

    it('formats scheduled labels', async () => {
        const mod = await loadModule();
        const now = Date.parse('2026-10-30T12:00:00Z');
        const label = mod.formatScheduledSendWhen(now + 3600_000, now);
        assert.match(label, /Today at/);
    });
});
