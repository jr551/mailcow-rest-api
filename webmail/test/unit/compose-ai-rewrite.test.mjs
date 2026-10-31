import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');

const tmp = mkdtempSync(path.join(tmpdir(), 'compose-ai-rewrite-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'compose-ai-rewrite.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        [
            '--loader:.ts=ts',
            '--format=esm',
            '--bundle',
            `--outfile=${out}`,
            path.join(webmailRoot, 'src/lib/compose-ai-rewrite.ts')
        ],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

test('selectionEligibleForRewrite respects minimum length', async () => {
    const mod = await loadModule();
    assert.equal(mod.selectionEligibleForRewrite('  '), false);
    assert.equal(mod.selectionEligibleForRewrite('ok!'), true);
});

test('buildComposeRewriteSystemPrompt includes tone marker', async () => {
    const mod = await loadModule();
    const sys = mod.buildComposeRewriteSystemPrompt('concise');
    assert.match(sys, /Outlook compose rewrite assistant/);
    assert.match(sys, /Shorten/i);
});

test('sanitizeComposeRewriteOutput strips wrapping quotes', async () => {
    const mod = await loadModule();
    assert.equal(mod.sanitizeComposeRewriteOutput('"Hello there"'), 'Hello there');
});
