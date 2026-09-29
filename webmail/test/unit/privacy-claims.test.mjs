// The privacy panel in Settings → Images & privacy makes specific claims
// about what does and does not leave the browser, and each claim cites the
// code it was verified against (webmail/src/lib/privacy-facts.ts). Those
// citations are the audit trail: when someone changes an AI route, a
// settings loader, or a redaction pattern, the Settings page must not keep
// asserting something that is no longer true.
//
// This test is the mechanical half of that audit. It does not judge whether
// a claim is still *true* — that needs a human reading the cited code — but
// it does fail when a citation stops pointing at anything, which is the
// common case after a refactor moves a line. A silently-rotten citation is
// worse than no citation, because it reads as provenance that was checked.
//
// It also pins the invariants that are cheap to break and expensive to
// notice:
//
//   1. Remote images are ALWAYS allowed and fetched through the proxy. The
//      blocking path — the per-message "This message has remote content"
//      prompt, the per-sender 30-day trust, and the `alwaysAllowImages`
//      field — is gone, and these tests fail if any of it comes back or if
//      an always-allow control survives as a silent no-op.
//   2. The privacy copy does not overstate the proxy: it hides who fetched
//      an image, not that the message was read.
//
// The migration behaviour itself is exercised end-to-end in
// privacy-migration.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webmailSrc = fileURLToPath(new URL('../../src/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const factsSrc = readFileSync(new URL('../../src/lib/privacy-facts.ts', import.meta.url), 'utf8');
const settingsSrc = readFileSync(new URL('../../src/lib/settings.svelte.ts', import.meta.url), 'utf8');

function read(relative) {
    return readFileSync(path.join(webmailSrc, relative), 'utf8');
}

// Resolve a citation to a file on disk. Citations are written either
// repo-relative (`src/routes/ai.js`) or webmail-relative
// (`webmail/src/lib/redact.ts`); both are looked up under both roots so the
// test does not care which convention a given claim used.
function resolve(rel) {
    // A `src/...` citation is ambiguous by construction: the repo has a
    // server-side src/ and the webmail has its own src/. So try the path as
    // written against every plausible root, and also with the leading `src/`
    // stripped — `src/lib/phishing-scan.ts` is cited from privacy-facts.ts,
    // which already lives in webmail/src/lib, and is meant as
    // webmail/src/lib/phishing-scan.ts.
    const stripped = rel.replace(/^(?:webmail\/)?src\//, '');
    const paths = [rel, stripped].flatMap(p => [
        path.join(repoRoot, p),
        path.join(webmailSrc, p),
        path.join(webmailSrc, 'lib', p),
        path.join(webmailSrc, 'components', p)
    ]);
    for (const p of paths) {
        const hit = readFileSafe(p);
        if (hit !== null) return hit;
    }
    return null;
}

// Only the `source:` fields are real citations. The file also contains prose
// comments that name a module by bare filename (`inbox-summary.ts:45`) to
// explain a resolver, and those are not claims the UI renders.
function citations() {
    const out = [];
    for (const m of factsSrc.matchAll(/source:\s*'([^']+)'/g)) {
        for (const c of m[1].matchAll(/(?:webmail\/)?((?:src\/)?[A-Za-z0-9/._-]+\.(?:ts|js|svelte)):(\d+)(?:-(\d+))?/g)) {
            out.push({ raw: m[1], file: c[1], start: Number(c[2]), end: c[3] ? Number(c[3]) : Number(c[2]) });
        }
    }
    return out;
}

test('every file:line cited by a privacy claim exists', () => {
    const cited = citations();
    assert.ok(cited.length >= 8, `expected the panel to cite several places, found ${cited.length}`);

    const files = new Set(cited.map(c => c.file));
    for (const rel of files) {
        assert.ok(
            resolve(rel) !== null,
            `privacy-facts.ts cites ${rel}, which does not exist under repoRoot or webmail/src`
        );
    }
});

function readFileSafe(p) {
    try { return readFileSync(p, 'utf8'); } catch { return null; }
}

test('every cited line number is within its file', () => {
    for (const c of citations()) {
        const file = resolve(c.file);
        if (file === null) continue; // covered by the test above
        const lines = file.split('\n').length;
        assert.ok(c.start <= lines, `${c.file}:${c.start} is past end of file (${lines} lines)`);
        assert.ok(c.end <= lines, `${c.file}:${c.end} is past end of file (${lines} lines)`);
    }
});

test('the server scrubber is reachable from exactly one route handler', () => {
    // The "no-server-scrub" claim for direct-to-provider users depends on
    // this being true. If someone starts scrubbing inside src/llm, that
    // claim becomes false and the copy must be rewritten — so trip here.
    const ai = readFileSync(path.join(repoRoot, 'src/routes/ai.js'), 'utf8');
    const scrubCalls = [...ai.matchAll(/scrubMessages(?:Pii)?\s*\(/g)].length;
    assert.equal(scrubCalls, 2, 'expected exactly the two scrub passes in ai.js');

    const llm = readFileSync(path.join(repoRoot, 'src/llm/index.js'), 'utf8');
    assert.ok(
        !llm.includes('secret-scrub'),
        'src/llm now imports the scrubber — the "server never sees your text" claim needs revisiting'
    );
});

// --- Remote images: always allowed, proxied ------------------------------
//
// These four replace the "blocked unless allowed" invariants that this file
// used to carry. They are not deletions: the removal of the blocking path is
// the single most user-visible behaviour change in the app (it is what made
// "This message has remote content" appear on ordinary mail), and a test
// file that quietly stopped covering it is how the state would silently come
// back. Each one fails if the blocking machinery creeps back in, and the
// last one fails if the privacy copy drifts away from what the code does.

test('remote images are never gated behind a permission check', () => {
    // The old rule was `alwaysAllowImages || isImageTrusted(sender)`. There is
    // no equivalent any more, and that is the point: neither reader may
    // reintroduce a per-message or per-sender gate, because the prompt is
    // the thing we removed.
    for (const file of ['components/MessageDetail.svelte', 'mobile/components/MessageView.svelte']) {
        const src = read(file);
        for (const symbol of [
            'allowImages',
            'loadRemoteContent',
            'loadRemoteImages',
            'trustSender',
            'isImageTrusted',
            'trustImagesFromSender',
            'settings.alwaysAllowImages'
        ]) {
            assert.ok(
                !src.includes(symbol),
                `${file}: still references ${symbol} — the remote-content blocking path must stay removed`
            );
        }
    }
});

test('the "load remote content" prompt is gone from both readers', () => {
    // The specific UI the user reported. Asserting on the copy text rather
    // than a testid catches the prompt coming back under a new name.
    for (const file of ['components/MessageDetail.svelte', 'mobile/components/MessageView.svelte']) {
        const src = read(file);
        assert.ok(
            !src.includes('This message has remote content'),
            `${file}: the remote-content prompt must not come back`
        );
        assert.ok(
            !src.includes('Remote content blocked'),
            `${file}: the mobile "Remote content blocked" card must not come back`
        );
        assert.ok(
            !/load-remote-content/.test(src),
            `${file}: the load-remote-content affordance must not come back`
        );
    }
});

test('images still resolve remotely after sanitising', () => {
    // The flip side of "always allowed": the readers must pass
    // allowRemoteImages: true explicitly. sanitizeHtml DEFAULTS IT TO FALSE,
    // so a reader that dropped the argument would silently blank every image
    // in the mailbox while every other test still passed.
    assert.match(
        read('components/MessageDetail.svelte'),
        /sanitizeHtml\([^)]*allowRemoteImages:\s*true/s
    );
    assert.match(
        read('mobile/components/MessageView.svelte'),
        /sanitizeHtml\([^)]*allowRemoteImages:\s*true/s
    );
});

test('the proxy governs HOW images are fetched, on both readers', () => {
    // Routing, not permission. Both readers must key proxying off the proxy
    // flag and the health check alone — there is no longer an `allowImages`
    // term to hang a permission check off.
    assert.match(
        read('components/MessageDetail.svelte'),
        /useProxy\s*=\s*settings\.proxyImages\s*&&\s*isProxyHealthy\(\)/
    );
    assert.match(
        read('mobile/components/MessageView.svelte'),
        /proxyActive\s*=\s*settings\.proxyImages\s*&&\s*remote/
    );
    assert.match(
        read('mobile/components/MessageView.svelte'),
        /if\s*\(\s*settings\.proxyImages\s*&&\s*remote\s*&&\s*isProxyHealthy\(\)/
    );
});

test('no stale always-allow control survives anywhere in the UI', () => {
    // A toggle wired to a field that no longer exists is the silent no-op
    // class of bug: it renders, it toggles, it changes nothing. The mobile
    // Settings screen had exactly this row.
    for (const file of ['components/Settings.svelte', 'mobile/components/SettingsView.svelte']) {
        const src = read(file);
        assert.ok(
            !src.includes('alwaysAllowImages') && !src.includes('setAlwaysAllowImages'),
            `${file}: still renders an always-allow control for a field that no longer exists`
        );
    }
    // The chat bridge must not advertise or accept it either: a tool that
    // claims to set a setting that does nothing will confidently tell the
    // user it changed their remote-image behaviour.
    const chat = read('lib/chat.svelte.ts');
    assert.ok(
        !chat.includes('alwaysAllowImages'),
        'lib/chat.svelte.ts still advertises or dispatches alwaysAllowImages'
    );
});

test('the privacy copy does not overstate what the proxy hides', () => {
    // The panel may claim the proxy hides the reader's IP. It may NOT claim
    // it hides that the message was read — the code says otherwise at
    // src/routes/image-proxy.js:190,193 (24h cache) and the sender still sees
    // the fetch. An overstating privacy panel is worse than none, because it
    // borrows trust from the control that does work.
    const panel = read('components/Settings.svelte');
    assert.ok(
        !/not the fact that you read|never knows you (read|opened)|cannot tell (that )?you read/i.test(panel),
        'the privacy panel must not claim the proxy hides that the message was read'
    );
    assert.ok(
        /not <em>that you read the message<\/em>|not \*that you read the message\*/i.test(panel),
        'the privacy panel should state the limit explicitly: it hides who fetched, not that you read'
    );

    // And the citable version must carry the same limit, so the two cannot
    // disagree with the UI that renders it.
    assert.match(
        factsSrc,
        /id:\s*'image-proxy-limit'[\s\S]{0,700}?not that you read the message/i,
        'privacy-facts.ts must carry an image-proxy-limit claim stating the honest boundary'
    );
    assert.match(
        factsSrc,
        /src\/routes\/image-proxy\.js:190,193/,
        'the image-proxy-limit claim must cite the daily cap and the 24h cache'
    );
});

test('every cited line number is still inside its file', () => {
    // Kept from the original file: a silently-rotten citation reads as
    // provenance that was checked, which is worse than no citation.
    for (const c of citations()) {
        const file = resolve(c.file);
        if (file === null) continue; // covered by the test above
        const lines = file.split('\n').length;
        assert.ok(c.start <= lines, `${c.file}:${c.start} is past end of file (${lines} lines)`);
        assert.ok(c.end <= lines, `${c.file}:${c.end} is past end of file (${lines} lines)`);
    }
});
