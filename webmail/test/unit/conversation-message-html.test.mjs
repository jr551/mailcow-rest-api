import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'conversation-message-html-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

async function loadModule() {
    const out = path.join(tmp, 'conversation-message-html.mjs');
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        [
            '--bundle',
            '--loader:.ts=ts',
            '--format=esm',
            `--outfile=${out}`,
            path.join(webmailRoot, 'src/lib/conversation-message-html.ts')
        ],
        { stdio: 'pipe' }
    );
    return import(pathToFileURL(out).href);
}

describe('conversation message HTML (slice 42)', () => {
    it('conversationMessageHasHtml requires non-empty html', async () => {
        const { conversationMessageHasHtml } = await loadModule();
        assert.equal(conversationMessageHasHtml(undefined), false);
        assert.equal(conversationMessageHasHtml({ html: null }), false);
        assert.equal(conversationMessageHasHtml({ html: '   ' }), false);
        assert.equal(conversationMessageHasHtml({ html: '<p>Hi</p>' }), true);
    });

    it('buildConversationMessageSrcDoc sanitizes and wraps html', async () => {
        const { buildConversationMessageSrcDoc } = await loadModule();
        const doc = buildConversationMessageSrcDoc(
            '<p>Hello</p><script>alert(1)</script><p><strong>Friday</strong></p>',
            'dark'
        );
        assert.match(doc, /<html/i);
        assert.match(doc, /<strong>Friday<\/strong>/);
        assert.doesNotMatch(doc, /<script/i);
        assert.match(doc, /color-scheme/i);
    });
});
