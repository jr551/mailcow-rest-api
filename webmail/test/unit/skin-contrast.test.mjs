// Every skin's text must stay legible on its own surface, in BOTH its light
// and its dark palette. A live pass across the bundled skins found several
// combinations below WCAG AA — muted labels, timestamps, folder counts and
// keyboard hints that were technically rendered but not readable. Contrast
// is arithmetic, so it can simply be asserted rather than re-audited by eye.
//
// The parser below walks the real object literal instead of splitting the
// file on brace runs. The old approach read the FIRST '--bg-surface' in an
// entry, which silently skipped the `darkVars` object nested beside `vars`:
// the dark palette got no coverage at all while the suite still reported
// green. The 'both palettes are parsed' test below is the tripwire for that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/lib/skins.svelte.ts', import.meta.url), 'utf8');

function relativeLuminance(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const [r, g, b] = [0, 2, 4]
        .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
}

// Pull the literal that follows `name:` out of a source range. Braces inside
// the CSS template strings are not a problem here: readVarsObject is only
// ever called on a `vars:` / `darkVars:` object, whose values are plain
// quoted strings.
function readVarsObject(source) {
    const start = source.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start + 1, i);
        }
    }
    return null;
}

function tokenMap(source) {
    const out = {};
    for (const m of source.matchAll(/'(--[a-z-]+)':\s*'(#[0-9a-fA-F]{3,8})'/g)) out[m[1]] = m[2];
    return out;
}

// One entry per skin per palette, so a contrast failure names the exact
// surface it was measured against.
function palettes() {
    const arrayStart = src.indexOf('export const SKINS: Skin[] = [');
    assert.notEqual(arrayStart, -1, 'could not find the SKINS array');
    return src.slice(arrayStart).split(/\n    \{\n/).slice(1).flatMap((entry) => {
        const id = (entry.match(/id:\s*'([^']+)'/) || [])[1];
        if (!id) return [];
        const out = [];
        const light = entry.indexOf('vars:');
        if (light !== -1) out.push({ id, mode: 'light', ...tokenMap(readVarsObject(entry.slice(light)) || '') });
        const dark = entry.indexOf('darkVars:');
        if (dark !== -1) out.push({ id, mode: 'dark', ...tokenMap(readVarsObject(entry.slice(dark)) || '') });
        return out;
    });
}

test('contrast maths matches known reference values', () => {
    // Sanity-check the implementation before trusting its verdicts.
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
    assert.equal(Math.round(contrastRatio('#ffffff', '#ffffff')), 1);
});

test('both palettes of every skin are actually parsed', () => {
    // False-green tripwire. The previous parser read the first '--bg-surface'
    // in an entry, which meant a `darkVars` object nested beside `vars` was
    // never measured — the suite stayed green while checking half of nothing.
    // If this fails, the parser has gone blind again and the AA tests below
    // are not testing what their names claim.
    const found = palettes();
    assert.equal(
        found.length, 4,
        `expected 2 skins x 2 palettes, got ${found.length}: ${found.map((p) => `${p.id}/${p.mode}`).join(', ')}`
    );
    for (const p of found) {
        assert.ok(p['--bg-surface'] || p['--bg-base'], `${p.id}/${p.mode} has no surface token`);
        assert.ok(p['--text-primary'], `${p.id}/${p.mode} has no --text-primary`);
    }
    // Light and dark must be genuinely different palettes, not one copied.
    for (const id of ['outlook', 'gmail']) {
        const light = found.find((p) => p.id === id && p.mode === 'light');
        const dark = found.find((p) => p.id === id && p.mode === 'dark');
        assert.notEqual(light['--bg-surface'], dark['--bg-surface'], `${id} dark is a copy of light`);
    }
});

test('every skin meets WCAG AA for secondary and tertiary text, light and dark', () => {
    const skins = palettes();
    // Exactly the two shipped skins, in both palettes. The count is asserted
    // rather than kept loose so that deleting a skin without re-checking its
    // contrast is a test failure, not a silent pass.
    assert.equal(skins.length, 4, `expected exactly 2 skins x 2 palettes, got ${skins.length}`);
    const failures = [];
    for (const skin of skins) {
        const surface = skin['--bg-surface'] || skin['--bg-base'];
        if (!surface) continue;
        for (const tokenName of ['--text-secondary', '--text-tertiary']) {
            const color = skin[tokenName];
            if (!color) continue;
            const ratio = contrastRatio(color, surface);
            if (ratio < 4.5) {
                failures.push(`${skin.id}/${skin.mode} ${tokenName} ${color} on ${surface} = ${ratio.toFixed(2)}:1`);
            }
        }
    }
    assert.deepEqual(failures, [], `palettes below AA:\n  ${failures.join('\n  ')}`);
});

test('primary text meets WCAG AA on every skin, light and dark', () => {
    const failures = [];
    for (const skin of palettes()) {
        const surface = skin['--bg-surface'] || skin['--bg-base'];
        const color = skin['--text-primary'];
        if (!surface || !color) continue;
        const ratio = contrastRatio(color, surface);
        // AA is the bar the issue sets. Pushing the decorative skins to
        // AAA would mean flattening them to near-white text, which trades
        // the thing people picked the skin for against a threshold nobody
        // asked for — c64 at AAA is indistinguishable from plain white.
        if (ratio < 4.5) failures.push(`${skin.id}/${skin.mode} ${color} on ${surface} = ${ratio.toFixed(2)}:1`);
    }
    assert.deepEqual(failures, [], `primary text below AA:\n  ${failures.join('\n  ')}`);
});

test('dark palettes are dark, and their borders are visible against them', () => {
    const failures = [];
    for (const skin of palettes().filter((p) => p.mode === 'dark')) {
        const surface = skin['--bg-surface'];
        if (!surface) continue;
        // A dark palette whose surface is still light means the toggle is a
        // no-op — the exact regression that made the light/dark control dead.
        if (relativeLuminance(surface) > 0.3) {
            failures.push(`${skin.id} dark --bg-surface ${surface} is not dark`);
        }
        // On a near-black pane a dark border is invisible; Fluent and
        // Material both lighten borders instead.
        const border = skin['--border-subtle'];
        if (border && relativeLuminance(border) <= relativeLuminance(surface)) {
            failures.push(`${skin.id} dark --border-subtle ${border} is not lighter than its surface ${surface}`);
        }
    }
    assert.deepEqual(failures, [], `dark palettes that would not read:\n  ${failures.join('\n  ')}`);
});
