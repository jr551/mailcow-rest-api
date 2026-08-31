// Every skin's secondary and tertiary text must stay legible on its own
// surface. A live pass across the bundled skins found six combinations
// below WCAG AA — muted labels, timestamps, folder counts and keyboard
// hints that were technically rendered but not readable. Contrast is
// arithmetic, so it can simply be asserted rather than re-audited by eye.

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

function skinBlocks() {
    return src
        .split(/\n\s*\{\s*\n/)
        .filter((b) => b.includes('--text-'))
        .map((b) => {
            const id = (b.match(/id:\s*'([^']+)'/) || [])[1];
            const token = (k) => (b.match(new RegExp(`'${k}':\\s*'(#[0-9a-fA-F]{3,8})'`)) || [])[1];
            return { id, token };
        })
        .filter((s) => s.id);
}

test('contrast maths matches known reference values', () => {
    // Sanity-check the implementation before trusting its verdicts.
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
    assert.equal(Math.round(contrastRatio('#ffffff', '#ffffff')), 1);
});

test('every skin meets WCAG AA for secondary and tertiary text', () => {
    const skins = skinBlocks();
    assert.ok(skins.length >= 5, `expected to parse several skins, got ${skins.length}`);

    const failures = [];
    for (const skin of skins) {
        const surface = skin.token('--bg-surface') || skin.token('--bg-base');
        if (!surface) continue;
        for (const tokenName of ['--text-secondary', '--text-tertiary']) {
            const color = skin.token(tokenName);
            if (!color) continue;
            const ratio = contrastRatio(color, surface);
            if (ratio < 4.5) {
                failures.push(`${skin.id} ${tokenName} ${color} on ${surface} = ${ratio.toFixed(2)}:1`);
            }
        }
    }
    assert.deepEqual(failures, [], `skins below AA:\n  ${failures.join('\n  ')}`);
});

test('primary text meets WCAG AA on every skin', () => {
    const failures = [];
    for (const skin of skinBlocks()) {
        const surface = skin.token('--bg-surface') || skin.token('--bg-base');
        const color = skin.token('--text-primary');
        if (!surface || !color) continue;
        const ratio = contrastRatio(color, surface);
        // AA is the bar the issue sets. Pushing the decorative skins to
        // AAA would mean flattening them to near-white text, which trades
        // the thing people picked the skin for against a threshold nobody
        // asked for — c64 at AAA is indistinguishable from plain white.
        if (ratio < 4.5) failures.push(`${skin.id} ${color} on ${surface} = ${ratio.toFixed(2)}:1`);
    }
    assert.deepEqual(failures, [], `primary text below AA:\n  ${failures.join('\n  ')}`);
});
