import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'compose-popout-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

function loadModule() {
    const out = path.join(tmp, 'compose-popout.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--bundle', '--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib/compose-popout.ts')],
        { stdio: 'pipe' }
    );
    return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

describe('compose-popout (slice 15)', () => {
    it('stores sessions and builds pop-out URLs', async () => {
        const mod = await loadModule();
        globalThis.sessionStorage = {
            _m: new Map(),
            getItem(k) { return this._m.get(k) ?? null; },
            setItem(k, v) { this._m.set(k, v); },
            removeItem(k) { this._m.delete(k); }
        };

        const id = mod.newComposePopoutSessionId();
        assert.match(id, /^pop-/);
        const url = mod.buildComposePopoutUrl(id, { pathname: '/webmail/', search: '' });
        assert.equal(url, `/webmail/?composePopout=1&sid=${encodeURIComponent(id)}`);

        mod.storeComposePopoutSession(id, {
            composeContext: {
                mode: 'new',
                replyTo: null,
                restore: {
                    to: 'a@b.c',
                    cc: '',
                    bcc: '',
                    subject: 'Hi',
                    body: '<p>x</p>',
                    from: 'me@b.c',
                    trackOpens: false,
                    attachments: []
                }
            }
        });
        const consumed = mod.consumeComposePopoutSession(id);
        assert.equal(consumed?.composeContext.restore?.subject, 'Hi');
        assert.equal(sessionStorage.getItem('webmail.compose-popout.v1.' + id), null);

        assert.equal(mod.isComposePopoutLocation({ search: `?composePopout=1&sid=${id}` }), true);
        assert.equal(mod.composePopoutSessionId({ search: `?composePopout=1&sid=${id}` }), id);
    });
});
