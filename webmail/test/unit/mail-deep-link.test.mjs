import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'mail-deep-link-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'mail-deep-link.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/mail-deep-link.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

describe('mail-deep-link (slice 16)', () => {
    it('parses and builds OWA-style hash links', async () => {
        const mod = await loadModule();
        const target = mod.parseMailDeepLinkHash('#mail?folder=INBOX&uid=1001');
        assert.deepEqual(target, { folder: 'INBOX', uid: 1001 });

        assert.equal(mod.buildMailDeepLinkHash('INBOX', 1001), '#mail?folder=INBOX&uid=1001');

        const url = mod.buildMailDeepLinkUrl('Projects/Client A', 42, {
            origin: 'https://mail.example.test',
            pathname: '/webmail/',
            search: ''
        });
        assert.equal(
            url,
            'https://mail.example.test/webmail/#mail?folder=Projects%2FClient+A&uid=42'
        );

        assert.equal(mod.parseMailDeepLinkHash('#other'), null);
        assert.equal(mod.sanitizeMailDeepLinkUid('0'), null);
    });
});
