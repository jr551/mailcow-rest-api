// The curated accent palette offered by the topbar picker.
//
// Every entry is a real hex the user can pick in one click, and every entry
// has been MEASURED — not eyeballed — against BOTH shipped skins' surface
// tokens, in BOTH palettes, by test/unit/skin-contrast.test.mjs. Two things
// make a swatch legal there, and a colour only has to clear the one that
// applies to how it is actually used:
//
//   1. As TEXT (--accent-text: accent-coloured labels, links, the selected
//      folder count) it must clear WCAG AA, 4.5:1, against every surface of
//      the active skin in the active mode.
//   2. As a MARK (--accent: the Outlook command bar, the focus ring, the
//      selected swatch's ring) it must clear 3:1, the non-text threshold in
//      WCAG 1.4.11.
//
// A third constraint is subtler and is why this is a hand-curated list rather
// than a hue slider: the Outlook command bar paints its own labels from
// --text-on-accent, so an accent also has to leave room for a legible ink ON
// TOP of itself. Gmail's red is the case that forces this — white on #ea4335
// is 3.92:1, so the layer flips to near-black ink there and nowhere else.
//
// Ordering is a rough hue sweep (blues → teals → greens → warm → reds →
// magentas → violets → neutrals) so the row reads as a gradient rather than a
// random list. The two shipped skin defaults are included as real entries so
// "back to the skin's own colour" is one click away without the user having
// to remember a hex, and both are labelled as defaults so the choice is
// legible instead of merely available.
//
// ADDING OR EDITING A SWATCH? Run the unit suite. It re-derives every entry
// from skins.svelte.ts's own arithmetic and fails on any that drops below
// threshold, so a "prettier" hex that happens to go unreadable in dark mode
// cannot be committed silently.

export interface AccentSwatch {
    /** Stable id for testids and as the keyed each-block identity. */
    id: string;
    /** Shown under the chip and used as the button's accessible name. */
    label: string;
    /** The hex handed to setCustomAccent. */
    hex: string;
    /**
     * The id of the skin whose own default this is, or null. Drives the
     * "Back to <skin> default" reset affordance, so a user is never trapped
     * in a hand-tuned state they cannot name.
     */
    isDefaultFor: string | null;
}

export const ACCENT_SWATCHES: AccentSwatch[] = [
    { id: 'sky',     label: 'Sky',          hex: '#0369a1', isDefaultFor: null },
    { id: 'azure',   label: 'Outlook blue', hex: '#0078d4', isDefaultFor: 'outlook' },
    { id: 'teal',    label: 'Teal',         hex: '#0f766e', isDefaultFor: null },
    { id: 'emerald', label: 'Emerald',      hex: '#00875a', isDefaultFor: null },
    { id: 'forest',  label: 'Forest',       hex: '#2d6a4f', isDefaultFor: null },
    { id: 'amber',   label: 'Amber',        hex: '#b45309', isDefaultFor: null },
    { id: 'gold',    label: 'Gold',         hex: '#a16207', isDefaultFor: null },
    { id: 'crimson', label: 'Crimson',      hex: '#a4262c', isDefaultFor: null },
    { id: 'gmail',   label: 'Gmail red',    hex: '#ea4335', isDefaultFor: 'gmail' },
    { id: 'rose',    label: 'Rose',         hex: '#c2185b', isDefaultFor: null },
    { id: 'plum',    label: 'Plum',         hex: '#8e2f6e', isDefaultFor: null },
    { id: 'violet',  label: 'Violet',       hex: '#6b3fa0', isDefaultFor: null },
    { id: 'indigo',  label: 'Indigo',       hex: '#3f51b5', isDefaultFor: null },
    { id: 'slate',   label: 'Slate',        hex: '#475569', isDefaultFor: null }
];

/**
 * The swatch that returns the active skin to its own colour, or null when a
 * skin ships no default we know about. Never null in practice — both shipped
 * skins declare one — but the picker degrades to "no reset button" rather
 * than rendering a button that does nothing if a future skin does not.
 */
export function defaultSwatchFor(skinId: string): AccentSwatch | null {
    return ACCENT_SWATCHES.find((s) => s.isDefaultFor === skinId) ?? null;
}
