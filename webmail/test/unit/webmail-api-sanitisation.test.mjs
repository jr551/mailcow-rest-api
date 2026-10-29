// Regression tests for the dependency-free helpers in webmail/src/lib:
// sanitize.ts, markdown.ts, redact.ts, domain-scope.ts and image-trust.ts.
// Each is transpiled with the repo's esbuild and imported as a real module,
// so the assertions run against the shipped code rather than a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webmailRoot = path.resolve(here, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'webmail-api-sanitisation-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

async function load(name) {
    const out = path.join(tmp, `${name}.mjs`);
    execFileSync(
        path.join(webmailRoot, 'node_modules/.bin/esbuild'),
        ['--loader:.ts=ts', '--format=esm', `--outfile=${out}`, path.join(webmailRoot, 'src/lib', `${name}.ts`)],
        { stdio: 'pipe' }
    );
    return import(pathToFileURL(out).href);
}

const { sanitizeHtml, buildIframeSrcDoc, linkCheckShim, placeholderRemoteImages } = await load('sanitize');
const { renderMarkdown } = await load('markdown');
const { redactSecrets } = await load('redact');
const { domainPattern, rootDomainPattern } = await load('domain-scope');
const { hasRemoteImages } = await load('image-trust');

test('sanitize strips handlers separated by slash or a closing quote', () => {
    assert.ok(!/onload/i.test(sanitizeHtml('<svg/onload=alert(1)>')));
    assert.ok(!/onerror/i.test(sanitizeHtml('<img src="x"/onerror=alert(1)>')));
    assert.ok(!/onerror/i.test(sanitizeHtml('<img src="x"onerror=alert(1)>')));
    assert.ok(!/onclick/i.test(sanitizeHtml('<a href="#" onclick="x()">a</a>')));
});

test('sanitize neutralises obfuscated javascript: URLs', () => {
    for (const href of ['&#106;avascript:alert(1)', '&#x6A;avascript:alert(1)', 'java&Tab;script:alert(1)', 'java\tscript:alert(1)', ' JaVaScRiPt:alert(1)', 'javascript&colon;alert(1)']) {
        const out = sanitizeHtml(`<a href="${href}">x</a>`);
        assert.ok(out.includes('href="#"'), `${href} -> ${out}`);
    }
    assert.equal(sanitizeHtml('<a href="https://example.com/a">x</a>'), '<a href="https://example.com/a">x</a>');
    assert.equal(sanitizeHtml('<img src="data:image/png;base64,AAAA">'), '<img src="data:image/png;base64,AAAA">');
});

test('sanitize blocks protocol-relative and attribute-borne remote loads when remote images are off', () => {
    assert.ok(sanitizeHtml('<img src="//t.example/p.gif">').includes('data-blocked-src'));
    assert.ok(!sanitizeHtml('<td background="https://t.example/p.gif">x</td>').includes('background'));
    assert.ok(!sanitizeHtml('<div style="background:url(//t.example/p.gif)">x</div>').includes('t.example'));
    // Allowed when the caller opts in (the proxy path).
    assert.ok(sanitizeHtml('<img src="//t.example/p.gif">', { allowRemoteImages: true }).includes(' src="//t.example'));
});

test('placeholderRemoteImages also parks protocol-relative sources', () => {
    const out = placeholderRemoteImages('<img src="//t.example/p.gif"><img src="https://t.example/q.gif">');
    assert.ok(!/\ssrc=/.test(out));
    assert.equal((out.match(/data-loading-src/g) || []).length, 2);
});

test('srcdoc carries a CSP; script only with the shim nonce', () => {
    const plain = buildIframeSrcDoc('<p>hi</p>', 'light');
    assert.match(plain, /http-equiv="Content-Security-Policy"/);
    assert.match(plain, /default-src 'none'/);
    assert.match(plain, /img-src data:;/);
    assert.ok(!plain.includes('script-src'));

    const withShim = buildIframeSrcDoc('<p>hi</p>', 'light', linkCheckShim('lc-1-abc'));
    assert.match(withShim, /script-src 'nonce-lc-1-abc'/);
    assert.match(withShim, /<script nonce="lc-1-abc">/);
    assert.ok(withShim.indexOf('Content-Security-Policy') < withShim.indexOf('<script'));

    const remote = buildIframeSrcDoc('<img src="https://t.example/p.gif">', 'light');
    assert.match(remote, /img-src data: http: https:/);
});

test('markdown: $ sequences in code blocks survive restoration', () => {
    const out = renderMarkdown("```sh\necho $'a'\n```");
    assert.ok(!out.includes('\u0000'), out);
    assert.ok(out.includes('echo $&#39;a&#39;'), out);
    assert.ok(renderMarkdown('```js\nx.replace(/a/, "$&")\n```').includes('$&amp;'));
});

test('redact: secret that appears inside its label does not leak or mangle the label', () => {
    assert.equal(redactSecrets('password: word'), 'password: [REDACTED]');
    assert.equal(redactSecrets('password: password'), 'password: [REDACTED]');
    assert.equal(redactSecrets('Your verification code: 123456'), 'Your verification code: [REDACTED]');
    assert.equal(redactSecrets('api key: abcdefghijklmnop1234'), 'api key: [REDACTED]');
});

test('domain-scope: path, port, query, fragment and percent-encoding are not hosts', () => {
    for (const a of ['x@legit.com#.spam.test', 'x@legit.com/x', 'x@legit.com:25', 'x@legit.com?a', 'x@a%41.com']) {
        assert.equal(domainPattern(a), null, a);
    }
    assert.equal(domainPattern('x@Legit.COM'), '*@legit.com');
    assert.equal(domainPattern('x@bücher.example'), '*@xn--bcher-kva.example');
    assert.equal(rootDomainPattern('x@a.b.example.co.uk'), '*@example.co.uk');
});

test('image-trust: protocol-relative and background= sources count as remote', () => {
    assert.ok(hasRemoteImages('<img src="//t.example/p.gif">'));
    assert.ok(hasRemoteImages('<td background="https://t.example/p.gif">'));
    assert.ok(!hasRemoteImages('<img src="data:image/png;base64,AAAA">'));
});
