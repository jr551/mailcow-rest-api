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
// It also pins the two invariants that are cheap to break and expensive to
// notice:
//
//   1. Images are blocked unless the user has stood images up, in BOTH
//      readers, and the proxy setting must NOT be one of the ways through.
//      (Regression guard for the "routing is not consent" rule.)
//   2. The in-memory settings state and the persisted blob must resolve
//      remote-image permission the same way, or the first session after an
//      upgrade disagrees with every reload after it.
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

test('remote images are blocked unless the user allowed them', () => {
    for (const file of ['components/MessageDetail.svelte', 'mobile/components/MessageView.svelte']) {
        const src = read(file);
        const allowDecision = src.match(/^\s*(?:allowImages|const shouldAllow)\s*=.*$/m);
        assert.ok(allowDecision, `${file}: could not find the allow decision`);
        assert.ok(
            !allowDecision[0].includes('proxyImages'),
            `${file}: the proxy flag must not grant permission to load images — routing is not consent`
        );
    }
});

test('the proxy still governs routing for images that ARE allowed', () => {
    // Guards the other half of the rule: dropping the proxy from the
    // permission check must not have silently disabled proxying entirely.
    const desktop = read('components/MessageDetail.svelte');
    assert.match(desktop, /useProxy\s*=\s*settings\.proxyImages\s*&&\s*allowImages/);

    const mobile = read('mobile/components/MessageView.svelte');
    assert.match(mobile, /proxyActive\s*=\s*shouldAllow\s*&&\s*settings\.proxyImages/);
});

test('a per-message override exists on both readers', () => {
    // Without this, "blocked by default" would mean "permanently blocked".
    // Bounded generously: the desktop handler optionally persists per-sender
    // trust before flipping the flag, so the assignment is a few lines in.
    assert.match(
        read('components/MessageDetail.svelte'),
        /function loadRemoteContent\(\)\s*\{[\s\S]{0,400}?allowImages = true;/
    );
    assert.match(
        read('mobile/components/MessageView.svelte'),
        /function loadRemoteImages\(\)\s*\{\s*allowImages = true;/
    );
});

test('the settings loader and the migration share one pre-flip rule', () => {
    // If these diverge, the live state and the rewritten blob disagree for
    // the session between the upgrade and the next reload.
    assert.match(
        settingsSrc,
        /preRemoteImagesAutoAllowed\(parsed\)/,
        'load() must derive alwaysAllowImages through the shared pre-flip rule'
    );
    assert.match(
        settingsSrc,
        /parsed\.alwaysAllowImages = preRemoteImagesAutoAllowed\(parsed\)/,
        'the migration must use the same rule the loader uses'
    );
});

test('the privacy panel never derives its copy from the migration marker', () => {
    // The marker exists only to stop the migration running twice. Reading it
    // to decide what to TELL the user would reintroduce the lie the
    // migration exists to avoid.
    const remotePredicate = settingsSrc.match(/export function remoteImagesBlockedFor[\s\S]*?\n}/);
    assert.ok(remotePredicate, 'remoteImagesBlockedFor() should exist as the single source of truth');
    assert.ok(
        !remotePredicate[0].includes('remoteImagesDefaulted'),
        'remoteImagesBlockedFor() must not read the migration marker'
    );

    const panel = read('components/Settings.svelte');
    const stateLine = panel.match(/data-testid="privacy-image-state"/);
    assert.ok(stateLine, 'the privacy panel should render a state line');
    assert.ok(
        !/imagesBlocked\s*=\s*\$derived\([^)]*remoteImagesDefaulted/.test(panel),
        'the panel must derive the image state from remoteImagesBlockedFor, not the marker'
    );
});
