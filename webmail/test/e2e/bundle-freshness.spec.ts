import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Guard against the failure mode that produced two false greens during the
// v0.18-0.20 work: a suite that passed while serving a STALE dist, so the
// code under test was not the code that had just been written.
//
// The webServer command in playwright.config.ts now builds first, which
// removes the common case. This spec is the backstop for the case a build
// command cannot catch: source that is newer than the bundle actually
// served, which means the run tested a build from before an edit.
//
// It is deliberately cheap: a handful of mtime comparisons, no browser work.

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

/** Newest mtime under `dir`, ignoring node_modules. */
function newestMtime(dir: string, exts: string[]): number {
    let newest = 0;
    const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const p = join(d, entry.name);
            if (entry.isDirectory()) {
                walk(p);
            } else if (exts.some((e) => entry.name.endsWith(e))) {
                newest = Math.max(newest, statSync(p).mtimeMs);
            }
        }
    };
    walk(dir);
    return newest;
}

test('the served bundle is newer than the source it was built from', () => {
    const newestSource = newestMtime(SRC, ['.ts', '.svelte', '.css']);
    const newestBundle = newestMtime(DIST, ['.js', '.css', '.html']);
    expect(newestBundle).toBeGreaterThan(0);

    // Allow a small clock/skew margin, but if a source file is materially
    // newer than the bundle, the build is stale and every assertion below
    // is about code that is not running.
    const staleBy = newestSource - newestBundle;
    const MARGIN_MS = 5_000;
    expect(
        staleBy,
        `src is ${Math.round(staleBy / 1000)}s newer than dist — the preview bundle is STALE. ` +
        'Re-run the build, or use the config in playwright.config.ts that builds first.'
    ).toBeLessThan(MARGIN_MS);
});

test('the app shell loads and the service worker does not intercept', async ({ page }) => {
    // If the service worker were live it would answer /v1/* itself and the
    // page.route() mocks in fixtures.ts would never fire, which reads as
    // "the app ignores the mock" rather than "the SW is intercepting".
    const sw = await page.evaluate(() => navigator.serviceWorker?.controller?.scriptURL ?? null);
    expect(sw, 'service worker must not control the page during tests').toBeNull();
});

test('the built bundle contains code from the current source', async ({ page }) => {
    // A cheap canary: a string that exists in the current source and must
    // therefore exist in the built JS. If someone edits a component and the
    // run serves an old dist, this fails first and says why.
    const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
    const mainMatch = /src="(\/webmail\/assets\/main-[^"]+\.js)"/.exec(html);
    expect(mainMatch, 'dist/index.html must reference a hashed main bundle').not.toBeNull();

    // index.html references the asset with its BASE path (/webmail/assets/...),
    // but the file on disk lives at dist/assets/... — the base is a URL prefix,
    // not a directory in the build output.
    const mainJs = readFileSync(join(ROOT, 'dist' + (mainMatch as RegExpExecArray)[1].replace(/^\/webmail/, '')), 'utf8');
    // Copied straight from the current component, so it cannot drift.
    const source = readFileSync(join(SRC, 'components/MessageList.svelte'), 'utf8');
    expect(source, 'canary source must contain the marker').toContain('Create rule from message');
    expect(mainJs, 'built bundle must contain the same marker as current source')
        .toContain('Create rule from message');
});
