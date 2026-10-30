import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'quick-steps-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'message-quick-steps.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/message-quick-steps.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

const mailboxes = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [], specialUse: '\\Inbox', subscribed: true },
    { path: 'Archive', name: 'Archive', delimiter: '/', flags: [], specialUse: '\\Archive', subscribed: true },
    { path: 'Trash', name: 'Trash', delimiter: '/', flags: [], specialUse: '\\Trash', subscribed: true },
    { path: 'Junk', name: 'Junk', delimiter: '/', flags: [], specialUse: '\\Junk', subscribed: true }
];

describe('message quick steps (slice 11)', () => {
    it('Done marks read then archives', async () => {
        const { quickStepById } = await loadModule();
        const step = quickStepById('done');
        assert.ok(step);
        assert.equal(step.actions[0].type, 'mark-read');
        assert.equal(step.actions[1].type, 'move');
        assert.equal(step.actions[1].target, 'archive');
    });

    it('resolves special-use folders for move actions', async () => {
        const { resolveQuickStepMovePath } = await loadModule();
        assert.equal(resolveQuickStepMovePath('archive', mailboxes), 'Archive');
        assert.equal(resolveQuickStepMovePath('trash', mailboxes), 'Trash');
        assert.equal(resolveQuickStepMovePath('junk', mailboxes), 'Junk');
    });

    it('sanitize falls back to the full catalog', async () => {
        const { sanitizeEnabledQuickStepIds, DEFAULT_QUICK_STEPS } = await loadModule();
        assert.deepEqual(sanitizeEnabledQuickStepIds(null), DEFAULT_QUICK_STEPS.map((s) => s.id));
        assert.deepEqual(sanitizeEnabledQuickStepIds(['done', 'nope']), ['done']);
    });

    it('ordered steps respect enabled id order', async () => {
        const { orderedQuickSteps } = await loadModule();
        const steps = orderedQuickSteps(['junk', 'done']);
        assert.deepEqual(steps.map((s) => s.id), ['junk', 'done']);
    });
});
