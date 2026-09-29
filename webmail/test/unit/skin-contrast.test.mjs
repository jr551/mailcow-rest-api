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

// --- Dark palettes are a LAYER STACK, not a list of greys ------------------
//
// Every contrast test above measures against --bg-surface alone. That was
// adequate while a dark palette was a single flat grey, and it stopped being
// adequate the moment dark mode grew a stack: the shipped Gmail dark palette
// had a --text-tertiary of #9aa0a6 that cleared 5.43:1 on --bg-surface and
// still failed AA on --bg-active (3.96:1), --bg-selected (3.72:1) and
// --bg-tag (3.96:1) — three sub-AA surfaces the suite never once measured.
// So these tests assert the STRUCTURE: that the dark surfaces form an
// ordered stack, that no two of them collapse onto one hex, and that each
// ink holds AA on every layer rather than only the one the suite used to
// look at.

// The layers a dark surface can occupy, in the order they are painted. The
// page is the canvas; everything else is a step above it.
const DARK_LAYERS = [
    '--bg-base', '--bg-surface', '--bg-surface-alt', '--bg-input',
    '--bg-elevated', '--bg-hover', '--bg-active', '--bg-tag'
];

// The pairs that MUST be ordered relative to each other, because each one is
// painted on top of another. --bg-selected is excluded on purpose: it is a
// tinted slab, so it is compared by separation below rather than by
// lightness, since a selection is meant to read by hue.
const MUST_CLIMB = [
    ['--bg-input', '--bg-elevated'],
    ['--bg-elevated', '--bg-hover'],
    ['--bg-hover', '--bg-active'],
    ['--bg-active', '--bg-tag']
];

test('dark surface layers are distinct, and the interaction states climb', () => {
    for (const skin of palettes().filter((p) => p.mode === 'dark')) {
        // (1) No two semantically different surfaces may share a hex. The
        // shipped Outlook dark palette had --bg-base === --bg-surface and
        // --bg-elevated === --bg-selected, which is what made the list
        // indistinguishable from the page behind it.
        const seen = new Map();
        for (const layer of DARK_LAYERS) {
            const value = skin[layer];
            if (!value) continue;
            const prior = seen.get(value);
            if (prior) {
                assert.fail(
                    `${skin.id} dark: ${layer} and ${prior} are both ${value} — two different`
                    + ' layers sharing one hex is exactly the collapse this stack exists to prevent'
                );
            }
            seen.set(value, layer);
        }
        // (2) Every adjacent pair on the ladder must be a real step, and
        // specifically must not go BACKWARDS. The old Outlook palette had
        // --bg-hover (#2a2a2a) darker than --bg-elevated (#2b2b2b), so
        // hovering a row inside a popover made it sink.
        for (const [lower, upper] of MUST_CLIMB) {
            const lo = skin[lower];
            const hi = skin[upper];
            if (!lo || !hi) continue;
            assert.ok(
                relativeLuminance(hi) > relativeLuminance(lo),
                `${skin.id} dark: ${upper} ${hi} is not a step above ${lower} ${lo}`
            );
        }
        // (3) An input must sit ABOVE the surface it is drawn on, with its
        // own border. The old Outlook value (#1b1b1b) was darker than its
        // own page, so every field read as a hole punched in the layout.
        for (const host of ['--bg-base', '--bg-surface', '--bg-surface-alt']) {
            const h = skin[host];
            if (!h) continue;
            assert.ok(
                relativeLuminance(skin['--bg-input']) > relativeLuminance(h),
                `${skin.id} dark: --bg-input ${skin['--bg-input']} is not above ${host} ${h}`
            );
        }
        // (4) A selection has to be visibly a selection. It is a tinted slab,
        // so brightness alone is the wrong measure — what matters is that it
        // separates from the surfaces it can be drawn on, whether by step or
        // by hue. A flat grey that merely matched --bg-elevated, as the old
        // Outlook value did, fails on both counts.
        for (const host of ['--bg-base', '--bg-surface', '--bg-surface-alt', '--bg-input']) {
            const h = skin[host];
            if (!h) continue;
            assert.ok(
                contrastRatio(skin['--bg-selected'], h) >= 1.08,
                `${skin.id} dark: --bg-selected ${skin['--bg-selected']} is indistinguishable from`
                + ` ${host} ${h} (${contrastRatio(skin['--bg-selected'], h).toFixed(2)}:1)`
            );
        }
        // (5) The borders have to separate the surfaces they draw on, and
        // they have to stay on their own ordered ramp rather than
        // collapsing to one tone.
        for (const border of ['--border-subtle', '--border-soft', '--border-strong']) {
            const b = skin[border];
            if (!b) continue;
            assert.ok(
                relativeLuminance(b) > relativeLuminance(skin['--bg-input']),
                `${skin.id} dark: ${border} ${b} is not above --bg-input ${skin['--bg-input']},`
                + ' so an input has no visible edge'
            );
        }
        const ramp = ['--border-subtle', '--border-soft', '--border-strong']
            .map((b) => skin[b])
            .filter(Boolean);
        for (let i = 1; i < ramp.length; i++) {
            assert.ok(
                relativeLuminance(ramp[i]) > relativeLuminance(ramp[i - 1]),
                `${skin.id} dark: the border ramp is not ordered (${ramp[i - 1]} then ${ramp[i]})`
            );
        }
        assert.equal(new Set(ramp).size, ramp.length, `${skin.id} dark: two border steps share a hex`);
    }
});

test('dark text holds AA on EVERY layer, not just --bg-surface', () => {
    // The regression this is here for: Gmail's dark --text-tertiary of
    // #9aa0a6 measured 5.43:1 on --bg-surface and failed on three other
    // layers the suite never looked at. A layered palette has to be audited
    // layer by layer, because the ink that is fine on a page is not
    // necessarily fine on a tag pill.
    const failures = [];
    for (const skin of palettes().filter((p) => p.mode === 'dark')) {
        for (const layer of DARK_LAYERS) {
            const bg = skin[layer];
            if (!bg) continue;
            for (const ink of ['--text-primary', '--text-secondary', '--text-tertiary']) {
                const color = skin[ink];
                if (!color) continue;
                const ratio = contrastRatio(color, bg);
                if (ratio < 4.5) {
                    failures.push(`${skin.id} dark ${ink} ${color} on ${layer} ${bg} = ${ratio.toFixed(2)}:1`);
                }
            }
        }
    }
    assert.deepEqual(failures, [], `dark text below AA on some layer:\n  ${failures.join('\n  ')}`);
});

test('the Gmail dark inversion holds, and the two skins are genuinely different palettes', () => {
    // Gmail's dark theme INVERTS the light palette's page/list relationship:
    // the page is the dark canvas and the message list is a step LIGHTER on
    // it. Outlook does the opposite — a card-style list on a darker page — so
    // the same token means the opposite thing on the two skins, and both are
    // correct. That relationship lives in a comment today, which is exactly
    // the kind of thing a re-tune silently inverts. Assert it instead.
    const dark = palettes().filter((p) => p.mode === 'dark');
    const outlook = dark.find((p) => p.id === 'outlook');
    const gmail = dark.find((p) => p.id === 'gmail');
    assert.ok(outlook && gmail, 'expected both shipped skins to declare a dark palette');

    // Gmail: the list is a step lighter than the page it sits on.
    assert.ok(
        relativeLuminance(gmail['--bg-surface']) > relativeLuminance(gmail['--bg-base']),
        `gmail dark: --bg-surface ${gmail['--bg-surface']} must be LIGHTER than the page`
        + ` --bg-base ${gmail['--bg-base']} — the inversion is the whole point of Gmail's dark theme`
    );
    // Outlook: the page is the darker of the two, the card-style list is above it.
    assert.ok(
        relativeLuminance(outlook['--bg-base']) < relativeLuminance(outlook['--bg-surface']),
        `outlook dark: --bg-base ${outlook['--bg-base']} must be the page, below the list surface`
        + ` ${outlook['--bg-surface']}`
    );
    // The two skins must not ship the same ladder, or "Gmail dark" is Outlook
    // dark with a different name.
    assert.notEqual(
        outlook['--bg-surface'], gmail['--bg-surface'],
        'both dark skins ship the same --bg-surface'
    );
});

// --- The accent palette ---------------------------------------------------
//
// The skins above are checked as shipped. The ACCENT LAYER on top of them is
// a separate derivation (accentOverrideVars in skins.svelte.ts) and was
// originally mode-blind: it computed one family from one lightness and used it
// unchanged in both palettes, so on a near-black pane an accent text of
// #004478 sat on #1f1f1f at 1.41:1. The topbar picker is the thing that made
// that reachable — one click, any hex — so the palette it offers is checked
// here against the same real surface tokens.
//
// The derivation is re-implemented below rather than imported. That is
// deliberate: importing the implementation would make the assertion test the
// exact code it is meant to audit, and a subtle typo in the formula would
// cancel out on both sides. The two are kept honest by `deriveMatchesSource`,
// which asserts this copy still agrees with the shipped constants.

const accSrc = src;

// hsl() string -> {h,s,l} as the source would compute it.
function parseHsl(str) {
    const m = /^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/.exec(str.trim());
    return m ? { h: +m[1], s: +m[2], l: +m[3] } : null;
}
function parseHex(hex) {
    const raw = hex.replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    return {
        h: 0,
        r: parseInt(full.slice(0, 2), 16) / 255,
        g: parseInt(full.slice(2, 4), 16) / 255,
        b: parseInt(full.slice(4, 6), 16) / 255
    };
}
function hslToHex({ h, s, l }) {
    const sn = s / 100;
    const ln = l / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = sn * Math.min(ln, 1 - ln);
    const f = (n) => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (v) => Math.round(Math.max(0, Math.min(255, v * 255))).toString(16).padStart(2, '0');
    return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
/** Resolve either a #hex or an hsl() token to a #hex so contrast is measurable. */
function toHex(token) {
    if (token.startsWith('#')) return token;
    const p = parseHsl(token);
    return p ? hslToHex(p) : null;
}

function hexToHsl(hex) {
    const { r, g, b } = parseHex(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (max === g) h = ((b - r) / d + 2) * 60;
        else h = ((r - g) / d + 4) * 60;
    }
    return { h, s: s * 100, l: l * 100 };
}

// A faithful copy of accentOverrideVars, in both branches. `deriveMatchesSource`
// below is what stops the two drifting apart.
function deriveAccent(hex, dark) {
    const { h, s, l } = hexToHsl(hex);
    const pct = (v) => `${v.toFixed(1)}%`;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // Mirrors the source's contrastRatio, which accepts hsl() as well as hex.
    // Comparing an hsl() token with the hex-only maths yields NaN >= NaN,
    // which is false — that bug shipped once already, so the copy has to
    // resolve tokens the same way or it would "verify" a different function.
    const onAccent = (fill) =>
        contrastRatio('#ffffff', toHex(fill)) >= contrastRatio('#141414', toHex(fill)) ? '#ffffff' : '#141414';
    // The modern space-separated hsl() the source emits. Every component
    // carries its own %: dropping the saturation's is what made this copy
    // return null from toHex and take the whole palette suite with it.
    const hs = `${h.toFixed(1)} ${s.toFixed(1)}%`;
    if (!dark) {
        return {
            '--accent': `hsl(${hs} ${pct(l)})`,
            '--accent-hover': `hsl(${hs} ${pct(clamp(l - 8, 0, 100))})`,
            '--accent-soft': `hsl(${h.toFixed(1)} ${Math.min(100, s + 5).toFixed(1)}% ${pct(clamp(l + 32, 0, 95))})`,
            '--accent-text': `hsl(${hs} ${pct(clamp(l - 18, 15, 100))})`,
            '--text-on-accent': onAccent(`hsl(${hs} ${pct(l)})`)
        };
    }
    const barL = clamp(l + 20, 58, 74);
    const bar = `hsl(${hs} ${pct(barL)})`;
    return {
        '--accent': bar,
        '--accent-hover': `hsl(${hs} ${pct(clamp(barL + 8, 0, 90))})`,
        '--accent-soft': `hsl(${h.toFixed(1)} ${pct(s * 0.5)} 15.0%)`,
        '--accent-text': `hsl(${hs} ${pct(clamp(l + 40, 70, 84))})`,
        '--text-on-accent': onAccent(bar)
    };
}

const swatchSrc = readFileSync(new URL('../../src/lib/accents.ts', import.meta.url), 'utf8');

/** The palette, read from the module the picker actually renders. */
function swatches() {
    return [...swatchSrc.matchAll(/\{ id: '([a-z]+)',\s*label: '([^']+)',\s*hex: '(#[0-9a-f]{6})',\s*isDefaultFor: (null|'[a-z]+')/g)]
        .map((m) => ({ id: m[1], label: m[2], hex: m[3], isDefaultFor: m[4] === 'null' ? null : m[4].slice(1, -1) }));
}

test('the accent palette is non-empty and its ids are unique', () => {
    const list = swatches();
    assert.ok(list.length >= 8, `expected a real palette, parsed ${list.length}`);
    const ids = new Set(list.map((s) => s.id));
    assert.equal(ids.size, list.length, 'duplicate swatch id — the keyed each-block would drop a colour');
    const hexes = new Set(list.map((s) => s.hex.toLowerCase()));
    assert.equal(hexes.size, list.length, 'duplicate hex — the picker would show the same colour twice');
});

test('every shipped skin has a swatch, and it is that skin\'s real default', () => {
    // A skin whose default is not one click away is a user who retints the
    // chrome and then has no way back that they can find.
    const list = swatches();
    for (const skin of SKIN_ARRAY()) {
        const mine = list.filter((s) => s.isDefaultFor === skin.id);
        assert.equal(mine.length, 1, `${skin.id} needs exactly one default swatch, found ${mine.length}`);
        // The swatch must agree with the skin's own declared swatch, or the
        // "Outlook blue" chip would not actually restore Outlook blue.
        assert.equal(
            mine[0].hex.toLowerCase(),
            skin.swatch.toLowerCase(),
            `${skin.id}'s default swatch (${mine[0].hex}) is not the skin's own ${skin.swatch}`
        );
    }
});

/** Skin id + declared swatch, read from the SKINS array. */
function SKIN_ARRAY() {
    const start = accSrc.indexOf('export const SKINS: Skin[] = [');
    assert.notEqual(start, -1, 'could not find the SKINS array');
    return accSrc.slice(start).split(/\n    \{\n/).slice(1)
        .map((entry) => ({
            id: (entry.match(/id:\s*'([^']+)'/) || [])[1],
            swatch: (entry.match(/swatch:\s*'(#[0-9a-fA-F]+)'/) || [])[1]
        }))
        .filter((s) => s.id && s.swatch);
}

test('the suite\'s deriveAccent really is the shipped accentOverrideVars', () => {
    // Marker-grepping for constants was the first attempt at this tripwire and
    // it is worthless: it passed while the suite audited arithmetic the source
    // no longer used, so BOTH the mode-blind regression and the NaN-ink
    // regression above went green. Asserting that a string appears in the
    // file cannot tell you the function computes what the copy computes.
    //
    // Instead: load the shipped function out of the source and RUN it, then
    // require token-for-token equality with the copy. Skins.svelte.ts is
    // TypeScript, so the annotations are stripped and the module-scope
    // dependencies it needs (hexToHsl, hslAccent, the two contrast helpers and
    // isDark) are lifted in alongside it. A real difference in the shipped
    // code now fails here instead of hiding behind a stale copy.
    const start = accSrc.indexOf('function accentOverrideVars');
    assert.notEqual(start, -1, 'could not find accentOverrideVars');
    let depth = 0;
    let end = accSrc.indexOf('{', start);
    for (let i = end; i < accSrc.length; i++) {
        if (accSrc[i] === '{') depth++;
        else if (accSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const fnBody = accSrc.slice(start, end + 1);
    const helpers = accSrc.slice(
        accSrc.indexOf('function hexToHsl'),
        accSrc.indexOf('// The ink a label uses when it sits ON')
    );
    const contrast = accSrc.slice(
        accSrc.indexOf('// The ink a label uses when it sits ON'),
        accSrc.indexOf('// The accent LAYER')
    );
    const js = [
        helpers, contrast,
        'let DARK = false;',
        'const isDark = () => DARK;',
        fnBody,
        'return { setDark: (v) => { DARK = v; }, run: (h) => accentOverrideVars(h) };'
    ].join('\n')
        .replace(/: Record<string, string>(\s*\|\s*null)?/g, '')
        .replace(/: \{ h: number; s: number; l: number(; str: string)? \}\s*\|\s*null/g, '')
        .replace(/: number(\s*\|\s*null)?/g, '')
        .replace(/: string(\s*\|\s*null)?/g, '')
        .replace(/\((hex|fill|accentHex|token): string\)/g, '($1)');

    // eslint-disable-next-line no-new-func
    const shipped = new Function(js)();
    const swatchList = swatches();
    for (const dark of [false, true]) {
        shipped.setDark(dark);
        for (const s of swatchList) {
            const real = shipped.run(s.hex);
            const copy = deriveAccent(s.hex, dark);
            for (const token of Object.keys(copy)) {
                assert.equal(
                    real[token], copy[token],
                    `${s.label} (${s.hex}) in ${dark ? 'dark' : 'light'}: the suite's deriveAccent no longer`
                    + ` matches the shipped accentOverrideVars for ${token}`
                    + ` — it would be auditing stale arithmetic, not the code that runs.`
                );
            }
        }
    }
});

test('every accent swatch stays readable as TEXT on both skins, in both modes', () => {
    // The regression this exists for: the original mode-blind derivation put
    // #004478 on #1f1f1f (1.41:1) and the picker made that one click away.
    const failures = [];
    for (const skin of palettes()) {
        const surface = skin['--bg-surface'] || skin['--bg-base'];
        if (!surface) continue;
        const dark = skin.mode === 'dark';
        for (const s of swatches()) {
            const text = toHex(deriveAccent(s.hex, dark)['--accent-text']);
            if (!text) { failures.push(`${s.id}: unparseable accent-text`); continue; }
            const ratio = contrastRatio(text, surface);
            if (ratio < 4.5) {
                failures.push(`${skin.id}/${skin.mode} ${s.label} (${s.hex}) accent-text ${text} on ${surface} = ${ratio.toFixed(2)}:1`);
            }
        }
    }
    assert.deepEqual(failures, [], `accent text below AA:\n  ${failures.join('\n  ')}`);
});

test('accent text stays readable on its own soft wash (active pills, chips)', () => {
    // A pale --accent-soft is a light slab on a dark pane; the dark branch
    // deliberately swaps it for a dark tint of the same hue instead.
    const failures = [];
    for (const dark of [false, true]) {
        for (const s of swatches()) {
            const v = deriveAccent(s.hex, dark);
            const text = toHex(v['--accent-text']);
            const soft = toHex(v['--accent-soft']);
            if (!text || !soft) { failures.push(`${s.id}: unparseable`); continue; }
            const ratio = contrastRatio(text, soft);
            if (ratio < 4.5) failures.push(`${dark ? 'dark' : 'light'} ${s.label} ${text} on soft ${soft} = ${ratio.toFixed(2)}:1`);
        }
    }
    assert.deepEqual(failures, [], `accent text on its own wash below AA:\n  ${failures.join('\n  ')}`);
});

test('the accent bar and its ink are legible as a MARK and as text on it (WCAG 1.4.11 / AA)', () => {
    // Outlook's command bar paints --accent and labels it with
    // --text-on-accent, so the accent has to work as a surface AND carry a
    // readable label. This is the constraint that rules out a naive hue
    // slider: Gmail red has no white ink that reaches AA.
    const failures = [];
    for (const skin of palettes()) {
        const surface = skin['--bg-surface'] || skin['--bg-base'];
        if (!surface) continue;
        const dark = skin.mode === 'dark';
        for (const s of swatches()) {
            const v = deriveAccent(s.hex, dark);
            const bar = toHex(v['--accent']);
            const ink = v['--text-on-accent'];
            if (!bar) { failures.push(`${s.id}: unparseable accent`); continue; }
            const asMark = contrastRatio(bar, surface);
            if (asMark < 3.0) failures.push(`${skin.id}/${skin.mode} ${s.label} bar ${bar} on ${surface} = ${asMark.toFixed(2)}:1 (needs 3:1 as a mark)`);
            const asLabel = contrastRatio(ink, bar);
            if (asLabel < 4.5) failures.push(`${skin.id}/${skin.mode} ${s.label} ink ${ink} on bar ${bar} = ${asLabel.toFixed(2)}:1 (needs 4.5:1 as text)`);
        }
    }
    assert.deepEqual(failures, [], `accent bar illegible:\n  ${failures.join('\n  ')}`);
});

test('the on-accent ink is the BETTER of the two, not merely a legible one', () => {
    // A contrast threshold alone is too weak to catch the bug this layer
    // actually had. The ink choice used to compare an hsl() token with a
    // hex-only luminance, which is `NaN >= NaN` — always false — so every
    // swatch silently got the near-black ink. Both inks clear AA on most
    // bars, so every other test here stayed green while Outlook's blue
    // command bar was wearing near-black labels at 2.5:1 in the other
    // direction. This asserts the CHOICE: the ink must be whichever of
    // white / near-black actually measures higher against the fill.
    const failures = [];
    for (const dark of [false, true]) {
        for (const s of swatches()) {
            const v = deriveAccent(s.hex, dark);
            const bar = toHex(v['--accent']);
            const ink = v['--text-on-accent'];
            if (!bar) continue;
            const white = contrastRatio('#ffffff', bar);
            const nearBlack = contrastRatio('#141414', bar);
            const expected = white >= nearBlack ? '#ffffff' : '#141414';
            if (ink !== expected) {
                failures.push(
                    `${dark ? 'dark' : 'light'} ${s.label} (${s.hex}): bar ${bar} took ink ${ink},`
                    + ` but white is ${white.toFixed(2)}:1 and #141414 is ${nearBlack.toFixed(2)}:1`
                    + ` — expected ${expected}`
                );
            }
        }
    }
    assert.deepEqual(failures, [], `on-accent ink is not the better one:\n  ${failures.join('\n  ')}`);
});

test('the on-accent ink really is the better of the two in the SHIPPED code', () => {
    // Same assertion, run against accentOverrideVars lifted out of
    // skins.svelte.ts rather than the suite's copy — the copy is proved
    // identical by the test above, but running the real thing keeps the
    // NaN class of bug from hiding behind that proof.
    const start = accSrc.indexOf('function accentOverrideVars');
    let depth = 0;
    let end = accSrc.indexOf('{', start);
    for (let i = end; i < accSrc.length; i++) {
        if (accSrc[i] === '{') depth++;
        else if (accSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const js = [
        accSrc.slice(accSrc.indexOf('function hexToHsl'), accSrc.indexOf('// The ink a label uses when it sits ON')),
        accSrc.slice(accSrc.indexOf('// The ink a label uses when it sits ON'), accSrc.indexOf('// The accent LAYER')),
        'let DARK = false;',
        'const isDark = () => DARK;',
        accSrc.slice(start, end + 1),
        'return { setDark: (v) => { DARK = v; }, run: (h) => accentOverrideVars(h) };'
    ].join('\n')
        .replace(/: Record<string, string>(\s*\|\s*null)?/g, '')
        .replace(/: \{ h: number; s: number; l: number(; str: string)? \}\s*\|\s*null/g, '')
        .replace(/: number(\s*\|\s*null)?/g, '')
        .replace(/: string(\s*\|\s*null)?/g, '')
        .replace(/\((hex|fill|accentHex|token): string\)/g, '($1)');
    // eslint-disable-next-line no-new-func
    const shipped = new Function(js)();
    const failures = [];
    for (const dark of [false, true]) {
        shipped.setDark(dark);
        for (const s of swatches()) {
            const v = shipped.run(s.hex);
            const bar = toHex(v['--accent']);
            if (!bar) { failures.push(`${s.id}: unparseable bar`); continue; }
            const white = contrastRatio('#ffffff', bar);
            const nearBlack = contrastRatio('#141414', bar);
            const expected = white >= nearBlack ? '#ffffff' : '#141414';
            if (v['--text-on-accent'] !== expected) {
                failures.push(
                    `${dark ? 'dark' : 'light'} ${s.label} (${s.hex}): shipped code took ${v['--text-on-accent']},`
                    + ` expected ${expected} (white ${white.toFixed(2)}:1, #141414 ${nearBlack.toFixed(2)}:1)`
                );
            }
        }
    }
    assert.deepEqual(failures, [], `shipped on-accent ink is not the better one:\n  ${failures.join('\n  ')}`);
});

test('the accent layer actually differs between light and dark', () => {
    // If the two branches ever converge, the picker silently stops working
    // in dark mode again — the original bug, wearing a different hat.
    for (const s of swatches()) {
        const l = toHex(deriveAccent(s.hex, false)['--accent-text']);
        const d = toHex(deriveAccent(s.hex, true)['--accent-text']);
        assert.notEqual(l, d, `${s.id} (${s.hex}) derives the same accent-text in light and dark`);
    }
});
