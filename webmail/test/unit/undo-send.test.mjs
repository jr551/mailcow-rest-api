import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'undo-send-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'undo-send.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/undo-send.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

describe('undo-send (slice 12)', () => {
    it('sanitizes undo send seconds', async () => {
        const mod = await loadModule();
        assert.equal(mod.sanitizeUndoSendSeconds(undefined), 5);
        assert.equal(mod.sanitizeUndoSendSeconds(0), 0);
        assert.equal(mod.sanitizeUndoSendSeconds(99), 30);
        assert.equal(mod.undoSendEnabled(0), false);
        assert.equal(mod.undoSendEnabled(5), true);
    });
});
