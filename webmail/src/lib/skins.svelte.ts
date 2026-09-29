// User-selectable visual skins.
//
// Two skins ship: Outlook and Gmail. Both are FULL skins — they define the
// entire palette (surfaces, text, borders, accent family, semantics, fonts,
// radii, shadows) rather than just tinting the accent, so they look the same
// regardless of the user's light/dark setting. `mobile/app.css` declares no
// custom properties of its own, which means a full skin's vars are the ONLY
// palette mobile sees: a partial skin would leave the mobile app unstyled.
//
// On top of whichever skin is active the user can layer a single accent hex
// (`accentOverride`). That is a layer, not a replacement — it re-derives the
// accent family over the skin's own surfaces, so retinting Outlook purple
// keeps Outlook's chrome, type and shape.
//
// Free-form user CSS (`customCss`) is injected after the per-skin extras so
// it always wins over both.

import { isDark, onEffectiveThemeChange } from './theme.svelte';

const STORAGE_KEY = 'webmail.skin.v1';

export interface Skin {
    id: string;
    label: string;
    description: string;
    swatch: string;          // small hex preview shown in the picker
    vars: Record<string, string>;
    /** The same skin in dark mode: surfaces, borders, text and shadows
     *  re-expressed for a dark pane, written INSTEAD of `vars` whenever the
     *  effective theme is dark. A skin without this keeps its light palette
     *  and effectively ignores the light/dark toggle.
     *
     *  Deliberately excludes the accent family and the semantic colours.
     *  The accent family is the user-owned layer (see accentOverrideVars)
     *  and the semantics have their own override path — letting darkVars
     *  restate them would put a skin and the accent layer in a fight over
     *  the same properties, and the layer must always win. */
    darkVars?: Record<string, string>;
    /** Extra CSS pasted into a per-skin <style>. Use `:root` and standard
     *  selectors freely — only present while this skin is on. This is where
     *  a skin does the work a var swap cannot: structural chrome, row
     *  behaviour, one-off button shapes. */
    extras?: {
        css?: string;
    };
    /** Mobile address-bar / browser chrome colour. */
    themeColor?: string;
    /** True when the skin's own chrome has no room for the ambient top-bar
     *  chips (Gmail's white topbar is already busy). The chips are hidden in
     *  the skin's extras CSS, but CSS alone can't reach the options menu —
     *  a sibling of the wrapper, not a child — so Layout also reads this and
     *  skips mounting them. See Layout.svelte's weatherChipVisible. */
    hidesAmbientChips?: boolean;
}

// Skin applied when the user has never picked one (and the fallback when a
// stored skin id no longer exists). Outlook is the shipping default.
const DEFAULT_SKIN_ID = 'outlook';

// Accent used before the user has ever dialled one in. Matches the Outlook
// command bar so a fresh install and the first picker render agree.
const DEFAULT_ACCENT = '#0078d4';

// Rules BOTH shipped skins carry, verbatim. These are not styling choices so
// much as structural agreements: neither Outlook-on-the-web nor Gmail marks an
// unread row with a dot (they use an edge bar and a bold sender respectively),
// and neither client has a counterpart for the push-to-talk mic FAB. Copy-
// pasting them into each skin's extras is how two entries end up disagreeing
// about the same selector, so they are declared once here and appended to
// every skin's CSS.
const SHARED_EXTRAS = `
    .voice-fab { display: none !important; }
    .row .unread-dot { display: none !important; }
`;

export const SKINS: Skin[] = [
    // ─── Microsoft Outlook on the web ────────────────────────────────────
    // The default skin — see DEFAULT_SKIN_ID above. Every colour is a real
    // OWA/Fluent token, and nothing structural is baked in, so layering a
    // different accent over it retints the whole chrome rather than just the
    // buttons inside it.
    {
        id: 'outlook',
        label: 'Outlook',
        description: 'Microsoft Outlook on the web — azure chrome, Segoe UI, white surfaces.',
        swatch: '#0078d4',
        hidesAmbientChips: true,
        extras: {
            css: `
                /* Azure command bar. The bar paints from --accent and its
                 * underline from the darker hover shade, so the accent
                 * picker retints the chrome as a whole. */
                .topbar {
                    background: var(--accent) !important;
                    border-bottom: 1px solid var(--accent-hover) !important;
                }
                .topbar .brand-mark { color: #fff !important; }
                .topbar .brand-sub { color: rgba(255,255,255,0.75) !important; }
                .topbar .logo { background: rgba(255,255,255,0.18) !important; }
                .topbar .btn-ghost,
                .topbar .theme-toggle { color: #fff !important; }
                .topbar .btn-ghost:hover,
                .topbar .theme-toggle:hover {
                    background: rgba(255,255,255,0.15) !important;
                    color: #fff !important;
                }
                /* The search box stays the white OWA field in every accent AND
                 * in dark mode; only the scope toggle inside it takes the
                 * accent colour.
                 *
                 * This block is deliberately NOT tokenised, even now that the
                 * skin has a dark palette. OWA dark keeps a light input on the
                 * accent bar, so the rendering is authentic — and the obvious
                 * "fix" is a trap: --bg-input is #1b1b1b in the dark set, so
                 * swapping the background to that token while leaving the text
                 * at #242424 collapses the field to 1.11:1, versus the 15.52:1
                 * measured here. Background, input text, placeholder and the
                 * scope-button border all have to move together, or not at
                 * all. Measured in a real browser at #ffffff / #242424. */
                .topbar .search-wrap {
                    background: #ffffff !important;
                    border: 1px solid #ffffff !important;
                }
                .topbar .search-wrap input { color: #242424 !important; }
                .topbar .search-wrap input::placeholder { color: #616161 !important; }
                .topbar .search-scope-btn {
                    color: var(--accent-text) !important;
                    border-color: #c8c6c4 !important;
                }
                .topbar .muted { color: rgba(255,255,255,0.85) !important; }

                /* Signed-in user next to the brand, like OWA's header. */
                .topbar .brand-user {
                    display: inline-flex !important;
                    color: #fff !important;
                    margin-left: 4px;
                }
                .topbar .brand-user-emoji { font-size: 14px; }

                /* OWA's topbar carries no ambient chips — weather and the
                 * calendar ticker stay hidden under this skin even when the
                 * user has them enabled. The skin's hidesAmbientChips flag
                 * makes Layout skip mounting them at all; this rule covers
                 * the opt-in case where the weather chip comes back. */
                .topbar .weather-wrap, .topbar .cal-wrap { display: none !important; }

                /* OWA marks unread rows with a blue edge bar and a blue
                 * bolded subject — no dot, no tint. */
                .row.unread { box-shadow: inset 3px 0 0 var(--accent) !important; }
                .row.unread .subject { color: var(--accent-text) !important; }

                /* OWA folder counts are plain blue numerals, not pills. */
                .folder .count {
                    background: transparent !important;
                    color: var(--accent) !important;
                    padding: 0 !important;
                    min-width: 0 !important;
                }
                .folder.active .count {
                    background: transparent !important;
                    color: var(--accent-text) !important;
                }

                /* OWA is flat: rows, folders and buttons don't lift. */
                .btn:hover, .row:hover, .folder:hover { transform: none !important; }
            ` + SHARED_EXTRAS
        },
        themeColor: '#0078d4',
        vars: {
            // OWA surfaces are white on white; hover is Fluent neutralLighter
            // and selection is the classic OWA light-blue row.
            '--bg-base': '#ffffff',
            '--bg-surface': '#ffffff',
            '--bg-surface-alt': '#faf9f8',
            '--bg-elevated': '#ffffff',
            '--bg-hover': '#f3f2f1',
            '--bg-active': '#edebe9',
            '--bg-selected': '#deecf9',
            '--bg-overlay': 'rgba(0, 0, 0, 0.4)',
            '--bg-input': '#ffffff',
            '--bg-tag': '#f0f0f0',

            '--text-primary': '#242424',
            '--text-secondary': '#424242',
            '--text-tertiary': '#616161',
            '--text-on-accent': '#ffffff',
            '--text-link': '#0078d4',

            '--border-subtle': '#ededed',
            '--border-soft': '#e0e0e0',
            '--border-strong': '#c8c6c4',
            // Outlook ties the focus ring to its accent; the accent layer
            // re-derives this so a re-tinted bar still has a matching ring.
            '--border-focus': '#0078d4',

            // Communication blue family: base, hover shade, pale wash,
            // link-safe dark shade.
            '--accent': '#0078d4',
            '--accent-hover': '#106ebe',
            '--accent-soft': '#eff6fc',
            '--accent-text': '#005a9e',
            '--unread-dot': '#0078d4',

            // Fluent semantics; the star becomes the OWA flag red.
            '--danger': '#a4262c',
            '--danger-soft': '#f7e6e8',
            '--success': '#107c10',
            '--success-soft': '#dff6dd',
            '--warning': '#bc4b09',
            '--warning-soft': '#fff4ce',
            '--star': '#c50f1f',

            '--font-sans': `'Segoe UI', 'Segoe UI Variable Text', 'Segoe UI Web (West European)',
                -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif`,

            // Fluent shape: near-square chrome, 4px controls.
            '--radius-xs': '2px',
            '--radius-sm': '4px',
            '--radius-md': '4px',
            '--radius-lg': '6px',
            '--radius-xl': '8px',

            // Fluent elevations (flat hairline → dialog shadow).
            '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.06)',
            '--shadow-md': '0 3.2px 7.2px rgba(0, 0, 0, 0.132), 0 0.6px 1.8px rgba(0, 0, 0, 0.108)',
            '--shadow-lg': '0 12px 28px rgba(0, 0, 0, 0.24), 0 2px 8px rgba(0, 0, 0, 0.16)',
            '--pill-padding': '2px 8px'
        },

        // Fluent dark. The command bar stays the communication blue — OWA's
        // dark theme does not neutralise it — and every neutral steps onto
        // Fluent's neutralLighter ramp. Surfaces sit a hair ABOVE black
        // rather than at it: pure black reads as an "OLED gimmick" instead
        // of Fluent, and on a near-black pane a dark hairline is invisible,
        // so the borders have to do the separating.
        //
        // No accent or semantic tokens: those are the user's layer.
        darkVars: {
            '--bg-base': '#1f1f1f',
            '--bg-surface': '#1f1f1f',
            '--bg-surface-alt': '#252525',
            '--bg-elevated': '#2b2b2b',
            '--bg-hover': '#2a2a2a',
            '--bg-active': '#323232',
            '--bg-selected': '#2b2b2b',
            '--bg-overlay': 'rgba(0, 0, 0, 0.62)',
            '--bg-input': '#1b1b1b',
            '--bg-tag': '#2d2d2d',

            '--text-primary': '#f3f2f1',
            '--text-secondary': '#d2d0ce',
            '--text-tertiary': '#a19f9d',
            '--text-on-accent': '#ffffff',
            // OWA dark uses the lighter communication blue for links so they
            // clear AA on the dark pane.
            '--text-link': '#6cb2f7',

            // Dark borders go LIGHTER than the surface, not darker.
            '--border-subtle': '#2d2d2d',
            '--border-soft': '#3b3a39',
            '--border-strong': '#57534f',
            // Outlook couples the focus ring to the accent; darkVars leaves
            // it to the accent layer so a re-tinted bar keeps a matching ring.
            '--border-focus': '#0078d4',

            // A black shadow on a near-black pane is invisible, so the depth
            // has to come from a light rim plus a soft ambient. Same geometry
            // as the light skin, re-expressed.
            '--shadow-sm': '0 0 1px rgba(255, 255, 255, 0.04), 0 1px 2px rgba(0, 0, 0, 0.5)',
            '--shadow-md': '0 0 1px rgba(255, 255, 255, 0.05), 0 3.2px 7.2px rgba(0, 0, 0, 0.55), 0 0.6px 1.8px rgba(0, 0, 0, 0.45)',
            '--shadow-lg': '0 0 1px rgba(255, 255, 255, 0.08), 0 12px 28px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.5)'
        }
    },

    // ─── Gmail ───────────────────────────────────────────────────────────
    // A faithful copy of the real client, not a generic blue theme. The
    // distinguishing marks all live in extras.css because no var swap can
    // produce them: the pill-shaped search field, the red rounded Compose
    // button, Gmail's 8px row rhythm, and its habit of bolding the *sender*
    // (not the subject) on unread rows.
    //
    // Gmail's topbar is white — the same white as the list surface — so the
    // vars alone do that job and no topbar background is forced here.
    {
        id: 'gmail',
        label: 'Gmail',
        description: 'Google Gmail — red accent, rounded cards, white on light grey.',
        swatch: '#ea4335',
        extras: {
            css: `
                /* Gmail's header is white — the same white as the list
                 * surface, which is what --bg-surface already resolves to,
                 * so no background is forced here. Only the hairline is
                 * pinned, because Layout's own topbar border would
                 * otherwise come from the light/dark theme's own ramp. */
                .topbar {
                    border-bottom: 1px solid var(--border-soft) !important;
                }
                .topbar .btn-ghost:hover,
                .topbar .theme-toggle:hover { background: var(--bg-hover) !important; }

                /* Gmail's search field is a soft-grey rounded box — the one
                 * rounded shape in the whole header. */
                .topbar .search-wrap {
                    background: var(--bg-hover) !important;
                    border: 1px solid var(--border-soft) !important;
                    border-radius: var(--radius-md) !important;
                    padding: 0 16px !important;
                }
                .topbar .search-wrap:focus-within {
                    background: var(--bg-input) !important;
                    border-color: var(--accent-soft) !important;
                    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent) !important;
                }
                .topbar .search-scope-btn {
                    color: var(--text-link) !important;
                    border-color: var(--border-strong) !important;
                    border-radius: 999px !important;
                }
                .topbar .search-scope-btn.active {
                    background: var(--text-link) !important;
                    color: var(--text-on-accent) !important;
                    border-color: var(--text-link) !important;
                }

                /* Gmail's left nav: plain grey section labels (not shouty
                 * uppercase), rounded pills, and no accent bar. The active
                 * folder is Gmail's pale blue — the red is reserved for
                 * Compose and destructive actions. */
                .nav-section {
                    color: var(--text-secondary) !important;
                    font-size: 11px !important;
                    letter-spacing: 0.04em !important;
                    text-transform: none !important;
                    margin: 12px 12px 4px !important;
                }
                .folder {
                    border-radius: 999px !important;
                    padding: 6px 12px !important;
                    margin: 1px 6px !important;
                    color: var(--text-primary) !important;
                }
                .folder:hover { background: var(--bg-hover) !important; }
                .folder.active {
                    background: var(--bg-selected) !important;
                    color: var(--accent-text) !important;
                    box-shadow: none !important;
                }
                /* Unread mailboxes: bold name, grey count badge. */
                .folder .count {
                    background: var(--bg-tag) !important;
                    color: var(--text-secondary) !important;
                    font-weight: 700 !important;
                }
                .folder.active .count {
                    background: var(--bg-surface) !important;
                    color: var(--accent-text) !important;
                }

                /* Gmail's Compose: a red pill with the pencil glyph, alone
                 * at the top of the nav. */
                .compose-row .compose {
                    background: var(--accent-text) !important;
                    color: var(--text-on-accent) !important;
                    border-radius: 999px !important;
                    padding: 12px 18px !important;
                    font-size: 14px !important;
                    box-shadow: var(--shadow-sm) !important;
                }
                .compose-row .compose:hover {
                    background: var(--accent) !important;
                    box-shadow: var(--shadow-md) !important;
                    transform: none !important;
                }
                /* The refresh button beside Compose stays a neutral chip —
                 * three stacked red buttons is not Gmail. */
                .compose-row .refresh-btn {
                    background: var(--bg-surface) !important;
                    border: 1px solid var(--border-strong) !important;
                    border-radius: 999px !important;
                    color: var(--text-secondary) !important;
                }

                /* Gmail rows: 8px cards on a grey page, no hairline, no lift
                 * on hover — just a wash. */
                .rows { padding: 8px !important; }
                .row {
                    border-radius: var(--radius-md) !important;
                    border-bottom: none !important;
                    padding: 10px 12px !important;
                    box-shadow: none !important;
                }
                .row:hover {
                    background: var(--bg-hover) !important;
                    transform: none !important;
                    box-shadow: none !important;
                }
                .row.selected,
                .row.bulk-selected {
                    background: var(--bg-selected) !important;
                    box-shadow: none !important;
                }
                /* Gmail bolds the SENDER on unread, not the subject. */
                .row.unread .from { font-weight: 700 !important; color: var(--text-primary) !important; }
                .row:not(.unread) .from { font-weight: 400 !important; color: var(--text-secondary) !important; }

                /* Unlike OWA's sparse blue command bar, Gmail's header is
                 * white with room to spare, so the weather chip and calendar
                 * ticker stay VISIBLE here: both build from light surfaces
                 * with high-contrast text (the lowest pairing here is the
                 * ticker's --text-secondary on --bg-surface-alt at 5.74:1),
                 * so they read cleanly against it. */
            ` + SHARED_EXTRAS
        },
        themeColor: '#ffffff',
        vars: {
            // White cards on Gmail's light grey. #f8f9fa is the grey; #ffffff
            // stays the surface, which is why --bg-base is white too — the
            // grey lives in --bg-surface-alt / --bg-hover, matching how
            // Gmail's list pane and its hover wash relate.
            '--bg-base': '#ffffff',
            '--bg-surface': '#ffffff',
            '--bg-surface-alt': '#f8f9fa',
            '--bg-elevated': '#ffffff',
            '--bg-hover': '#f8f9fa',
            '--bg-active': '#f1f3f4',
            '--bg-selected': '#d3e3fd',
            '--bg-overlay': 'rgba(32, 33, 36, 0.4)',
            '--bg-input': '#ffffff',
            '--bg-tag': '#e8eaed',

            // Gmail's text ramp. Its own grey #80868b is only 3.68:1 on
            // white — fine for a decorative nav label, too low for text, so
            // the tertiary token steps one notch down the ramp to #70757a
            // (4.65:1, AA).
            '--text-primary': '#202124',
            '--text-secondary': '#5f6368',
            '--text-tertiary': '#70757a',
            '--text-on-accent': '#ffffff',
            // Gmail's links are Google's blue, not the red brand accent.
            '--text-link': '#1a73e8',

            // Google's grey border ramp.
            '--border-subtle': '#f1f3f4',
            '--border-soft': '#e0e0e0',
            '--border-strong': '#dadce0',
            '--border-focus': '#ea4335',

            // The Gmail brand red family: #EA4335 base, #D93025 hover,
            // #FCE8E6 pale wash, #C5221F the link-safe dark shade.
            '--accent': '#ea4335',
            '--accent-hover': '#d93025',
            '--accent-soft': '#fce8e6',
            '--accent-text': '#c5221f',
            '--unread-dot': '#ea4335',

            // Google's semantics. The star is Google's yellow, not the red
            // Outlook flag.
            '--danger': '#d93025',
            '--danger-soft': '#fce8e6',
            '--success': '#188038',
            '--success-soft': '#e6f4ea',
            '--warning': '#e37400',
            '--warning-soft': '#fef7e0',
            '--star': '#f4b400',

            // Roboto where the OS has it (Android, ChromeOS, most Linux),
            // else the platform UI face. Deliberately NOT a Google Fonts
            // <link>: the skin shouldn't phone home just to render.
            '--font-sans': `Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif`,

            // Gmail's shape language: 8px cards, 24px dialogs.
            '--radius-xs': '4px',
            '--radius-sm': '8px',
            '--radius-md': '8px',
            '--radius-lg': '8px',
            '--radius-xl': '24px',

            // Google's Material elevations.
            '--shadow-sm': '0 1px 2px 0 rgba(60, 64, 67, 0.3), 0 1px 3px 1px rgba(60, 64, 67, 0.15)',
            '--shadow-md': '0 1px 3px 0 rgba(60, 64, 67, 0.3), 0 4px 8px 3px rgba(60, 64, 67, 0.15)',
            '--shadow-lg': '0 4px 4px 0 rgba(60, 64, 67, 0.3), 0 8px 12px 6px rgba(60, 64, 67, 0.15)',
            '--pill-padding': '4px 12px'
        },

        // Material dark. Gmail's dark theme inverts the relationship between
        // the list and the page: the page goes to the DARK grey (#202124) and
        // the message list stays a step LIGHTER (#292a2d), so rows read as
        // cards on a darker canvas — the light palette's white-on-grey,
        // inverted. Google's dark greys are also genuinely desaturated, not
        // just dimmed.
        //
        // No accent or semantic tokens: those are the user's layer. The
        // Compose button keeps its own red in extras.css, which is where
        // Gmail's dark Compose actually lives too.
        darkVars: {
            '--bg-base': '#202124',
            '--bg-surface': '#292a2d',
            '--bg-surface-alt': '#202124',
            '--bg-elevated': '#35363a',
            '--bg-hover': '#303134',
            '--bg-active': '#3c4043',
            // Gmail's dark selection is a desaturated blue, not the pale
            // #D3E3FD of the light theme.
            '--bg-selected': '#394457',
            '--bg-overlay': 'rgba(0, 0, 0, 0.7)',
            '--bg-input': '#292a2d',
            '--bg-tag': '#3c4043',

            '--text-primary': '#e3e3e3',
            '--text-secondary': '#bdc1c6',
            '--text-tertiary': '#9aa0a6',
            '--text-on-accent': '#ffffff',
            // Google lightens its link blue for dark; #8ab4f8 is their own
            // dark-theme link colour and clears AA on both #202124 and
            // #292a2d.
            '--text-link': '#8ab4f8',

            // Material dark dividers are lighter than the surface, for the
            // same reason: a dark hairline on a dark pane is invisible.
            '--border-subtle': '#3c4043',
            '--border-soft': '#4a4d51',
            '--border-strong': '#5f6368',
            '--border-focus': '#ea4335',

            // Material dark elevations: a stronger ambient with almost no
            // directional key light, so depth comes from the overlay rather
            // than a cast shadow.
            '--shadow-sm': '0 1px 2px 0 rgba(0, 0, 0, 0.6), 0 1px 3px 1px rgba(0, 0, 0, 0.3)',
            '--shadow-md': '0 1px 3px 0 rgba(0, 0, 0, 0.6), 0 4px 8px 3px rgba(0, 0, 0, 0.3)',
            '--shadow-lg': '0 4px 4px 0 rgba(0, 0, 0, 0.6), 0 8px 12px 6px rgba(0, 0, 0, 0.3)'
        }
    }
];

// Hex → HSL parts (h, s%, l%) for live custom-skin generation.
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
    const m = /^#?([0-9a-f]{3,8})$/i.exec(hex.trim());
    if (!m) return null;
    let s = m[1];
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length === 4) s = s.split('').map((c) => c + c).join('').slice(0, 6);
    if (s.length !== 6 && s.length !== 8) return null;
    const r = parseInt(s.slice(0, 2), 16) / 255;
    const g = parseInt(s.slice(2, 4), 16) / 255;
    const b = parseInt(s.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, sat = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
            case g: h = ((b - r) / d + 2); break;
            case b: h = ((r - g) / d + 4); break;
        }
        h *= 60;
    }
    return { h, s: sat * 100, l: l * 100 };
}

function hslAccent(hex: string): { h: number; s: number; l: number; str: string } | null {
    const hsl = hexToHsl(hex);
    if (!hsl) return null;
    const str = `hsl(${hsl.h.toFixed(1)} ${hsl.s.toFixed(1)}% ${hsl.l.toFixed(1)}%)`;
    return { ...hsl, str };
}

// The accent LAYER. Takes the user's hex and re-derives the accent family
// over whatever skin is active, so the surfaces, type and shape stay the
// skin's own. Applied as a second pass of inline vars on top of the skin's
// vars (see applyCurrentSkin) rather than as a replacement palette — that
// distinction is the whole point of the picker.
//
// `--border-focus` and `--unread-dot` ride along because Outlook ties its
// focus ring and its unread edge bar to the accent; leaving them behind
// would strand a blue focus ring on a red toolbar.
function accentOverrideVars(accentHex: string): Record<string, string> | null {
    const base = hslAccent(accentHex);
    if (!base) return null;
    const { h, s, l } = base;
    return {
        '--accent': base.str,
        '--accent-hover': `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${Math.max(0, l - 8).toFixed(1)}%)`,
        '--accent-soft': `hsl(${h.toFixed(1)} ${Math.min(100, s + 5).toFixed(1)}% ${Math.min(95, l + 32).toFixed(1)}%)`,
        '--accent-text': `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${Math.max(15, l - 18).toFixed(1)}%)`,
        '--unread-dot': base.str,
        '--border-focus': base.str
    };
}

interface SemanticOverrides {
    danger: string;
    dangerSoft: string;
    success: string;
    successSoft: string;
    warning: string;
    warningSoft: string;
    star: string;
}

interface SkinState {
    /** Always the id of a real entry in SKINS — `load()` rewrites anything
     *  else, so the picker highlights a tile and Layout's gates agree. */
    skinId: string;
    /** The last accent hex the user dialled in. Kept even when no override
     *  is active so the colour input always has something to show. */
    customAccent: string;
    /** The accent hex currently LAYERED over the skin, or null for the
     *  skin's own accent. This replaces the old 'custom' pseudo-skin, which
     *  discarded the whole skin just to change a hue. */
    accentOverride: string | null;
    semantics: SemanticOverrides;
    /** True once the user has touched a semantic colour. Lets Settings show
     *  the semantic chips to someone who only changed an accent, and lets a
     *  reset tuck them away again. */
    semanticsEdited: boolean;
    /** Free-form CSS the user wrote in Settings → Appearance. Injected
     *  into a single <style id="webmail-custom-css"> on :root so it
     *  applies to the whole SPA and survives re-renders. */
    customCss: string;
}

const defaultSemantics: SemanticOverrides = {
    danger: '#c0392b',
    dangerSoft: '#fde0db',
    success: '#2d9560',
    successSoft: '#dff5e8',
    warning: '#c98b15',
    warningSoft: '#fbf2da',
    star: '#f0a821'
};

function load(): SkinState {
    const fresh: SkinState = {
        skinId: DEFAULT_SKIN_ID,
        customAccent: DEFAULT_ACCENT,
        accentOverride: null,
        semantics: { ...defaultSemantics },
        semanticsEdited: false,
        customCss: ''
    };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return fresh;
        const parsed = JSON.parse(raw) || {};
        const sem = parsed.semantics || {};

        // Legacy migration. 'custom' used to be a pseudo-skin carrying only
        // an accent hex and an accent-only palette. Fold it into the default
        // skin with that hex kept as an accent override, so a user who
        // dialled in a colour keeps it instead of silently reverting to
        // Outlook blue on upgrade.
        const legacyCustom = parsed.skinId === 'custom';
        const storedId = legacyCustom ? DEFAULT_SKIN_ID : parsed.skinId;

        // Stale ids — a deleted skin, or hand-edited localStorage — must not
        // survive. applyCurrentSkin falls back to the default skin's vars,
        // but a dead id left in state highlighted no tile in the picker and
        // made Layout's skin gates read a skin that isn't there.
        const skinId = SKINS.some((s) => s.id === storedId) ? storedId : DEFAULT_SKIN_ID;

        const storedAccent = typeof parsed.customAccent === 'string' ? parsed.customAccent : DEFAULT_ACCENT;
        const accentOverride = legacyCustom
            ? storedAccent
            : (typeof parsed.accentOverride === 'string' ? parsed.accentOverride : null);

        const next: SkinState = {
            skinId,
            customAccent: accentOverride ?? storedAccent,
            accentOverride,
            semantics: {
                danger: typeof sem.danger === 'string' ? sem.danger : defaultSemantics.danger,
                dangerSoft: typeof sem.dangerSoft === 'string' ? sem.dangerSoft : defaultSemantics.dangerSoft,
                success: typeof sem.success === 'string' ? sem.success : defaultSemantics.success,
                successSoft: typeof sem.successSoft === 'string' ? sem.successSoft : defaultSemantics.successSoft,
                warning: typeof sem.warning === 'string' ? sem.warning : defaultSemantics.warning,
                warningSoft: typeof sem.warningSoft === 'string' ? sem.warningSoft : defaultSemantics.warningSoft,
                star: typeof sem.star === 'string' ? sem.star : defaultSemantics.star
            },
            // Pre-cut state had no flag. Infer it: only semantics keys that
            // differ from the defaults count, since an empty `semantics: {}`
            // is just what every client wrote, not evidence of an edit.
            semanticsEdited: typeof parsed.semanticsEdited === 'boolean'
                ? parsed.semanticsEdited
                : Object.keys(defaultSemantics).some((k) => {
                    const key = k as keyof SemanticOverrides;
                    return sem[key] !== undefined && sem[key] !== defaultSemantics[key];
                }),
            customCss: typeof parsed.customCss === 'string' ? parsed.customCss.slice(0, 50_000) : ''
        };

        // Re-write storage when the shape changed so the migration happens
        // once instead of on every boot.
        if (JSON.stringify(next) !== raw) persist(next);
        return next;
    } catch { /* noop */ }
    return fresh;
}

function persist(s: SkinState) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

const state = $state<SkinState>(load());

export const skinState = state;

// Every var a skin might set, listed so switching skins always resets
// cleanly rather than leaving the previous skin's inline values behind.
const ALL_SKIN_VARS = [
    // accent family
    '--accent', '--accent-hover', '--accent-soft', '--accent-text',
    '--unread-dot', '--star',
    '--danger', '--danger-soft',
    '--success', '--success-soft',
    '--warning', '--warning-soft',
    // surfaces
    '--bg-base', '--bg-surface', '--bg-surface-alt', '--bg-elevated',
    '--bg-hover', '--bg-active', '--bg-selected', '--bg-overlay',
    '--bg-input', '--bg-tag',
    // text
    '--text-primary', '--text-secondary', '--text-tertiary',
    '--text-on-accent', '--text-link',
    // borders
    '--border-subtle', '--border-soft', '--border-strong', '--border-focus',
    // typography & shape
    '--font-sans', '--font-mono',
    '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
    '--shadow-sm', '--shadow-md', '--shadow-lg',
    '--pill-padding'
];

function applyVars(vars: Record<string, string>) {
    const root = document.documentElement;
    for (const v of ALL_SKIN_VARS) root.style.removeProperty(v);
    for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
}

// Per-skin extras. Lazily loaded only when a skin that defines them is
// active, and cleared when the user switches away so a previous skin's
// structural rules never leak into the next one. There is deliberately no
// webfont loading here any more: both shipped skins use a locally
// resolvable font stack, so no skin asks the network for type.
const SKIN_EXTRAS_STYLE_ID = 'webmail-skin-extras';

function applyExtras(skin: Skin | null) {
    if (typeof document === 'undefined') return;

    let styleEl = document.getElementById(SKIN_EXTRAS_STYLE_ID);
    const css = skin?.extras?.css?.trim() || '';

    if (css) {
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = SKIN_EXTRAS_STYLE_ID;
            // Append AFTER the user-customCss style so user overrides still win.
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = css;
    } else if (styleEl) {
        styleEl.textContent = '';
    }

    // Body class for CSS that wants to scope rules to a specific skin.
    const root = document.documentElement;
    Array.from(root.classList).filter((c) => c.startsWith('skin-')).forEach((c) => root.classList.remove(c));
    if (skin) root.classList.add(`skin-${skin.id}`);

    // Browser chrome colour (mobile address bar / desktop window border on
    // some browsers) follows the skin's background. The static index.html
    // has prefers-color-scheme variants — we strip those and add a single
    // dynamic one so the address bar matches whatever skin is active.
    syncThemeColorMeta(skin);
}

function syncThemeColorMeta(skin: Skin | null) {
    const head = document.head;
    if (!head) return;
    // Remove any existing theme-color metas (the static prefers-color-scheme
    // pair set in index.html, plus any we added previously).
    Array.from(head.querySelectorAll('meta[name="theme-color"]')).forEach((el) => el.remove());

    let color = '';
    if (skin?.themeColor) {
        color = skin.themeColor;
    } else if (skin?.vars['--bg-base']) {
        color = skin.vars['--bg-base'];
    } else {
        // No declared themeColor — fall back to whatever the live palette
        // resolves to so the address bar still tracks the current theme.
        try {
            color = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim() || '';
        } catch { /* noop */ }
    }
    if (!color) return;
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', color);
    head.appendChild(meta);
}

function buildOverrides(sem: SemanticOverrides): Record<string, string> {
    return {
        '--danger': sem.danger,
        '--danger-soft': sem.dangerSoft,
        '--success': sem.success,
        '--success-soft': sem.successSoft,
        '--warning': sem.warning,
        '--warning-soft': sem.warningSoft,
        '--star': sem.star
    };
}

// Resolve the active skin. `load()` normalises the stored id, but this stays
// defensive: a bad id must still render a real skin, never a blank page.
function activeSkin(): Skin {
    return SKINS.find((s) => s.id === state.skinId)
        || SKINS.find((s) => s.id === DEFAULT_SKIN_ID)
        || SKINS[0];
}

// Module-private: the only legitimate callers are the setters below and the
// effective-theme watcher. Exporting it just widens the surface something
// else could call out of order.
function applyCurrentSkin() {
    if (typeof document === 'undefined') return;
    const skin = activeSkin();

    // Palette selection is a VALUE SWAP on the same vars, not a second
    // hardcoded dark block. That matters: these are inline styles on
    // <html>, so any dark set written as a separate inline rule would beat
    // app.css and break the accent layer's ability to retint the skin.
    // Swapping the values keeps the accent layer as the last word.
    const base = (isDark() && skin.darkVars) ? { ...skin.vars, ...skin.darkVars } : skin.vars;

    // Merge order matters: the skin lays down the whole palette, then the
    // user's semantic overrides, then the accent layer. The accent goes last
    // so it always wins over anything the skin declared for the accent
    // family — that is the whole point of "chooseable accent colours".
    // Everything is written in one pass so a stale var from the previous
    // skin, or from the other theme mode, can never linger in the inline
    // style.
    const vars: Record<string, string> = {
        ...base,
        ...buildOverrides(state.semantics)
    };
    const accent = state.accentOverride
        ? accentOverrideVars(state.accentOverride)
        : null;
    if (accent) Object.assign(vars, accent);

    applyVars(vars);
    applyExtras(skin);
}

// Re-apply when the effective mode moves, so flipping the OS while on
// 'auto' repaints the skin without a reload. `onEffectiveThemeChange` fires
// for an explicit toggle as well, so this covers the whole matrix.
onEffectiveThemeChange(() => applyCurrentSkin());

export function isKnownSkin(id: string): boolean {
    return SKINS.some((s) => s.id === id);
}

export function setSkin(id: string) {
    state.skinId = isKnownSkin(id) ? id : DEFAULT_SKIN_ID;
    persist(state);
    applyCurrentSkin();
}

// Layer an accent over the ACTIVE skin rather than replacing it. Passing
// null (or an unparseable hex) clears the layer and hands the skin's own
// accent back.
export function setCustomAccent(hex: string | null) {
    state.accentOverride = hex && hslAccent(hex) ? hex : null;
    if (state.accentOverride) state.customAccent = state.accentOverride;
    persist(state);
    applyCurrentSkin();
}

export function setSemantic(patch: Partial<SemanticOverrides>) {
    state.semantics = { ...state.semantics, ...patch };
    state.semanticsEdited = true;
    persist(state);
    applyCurrentSkin();
}

export function resetSemantics() {
    state.semantics = { ...defaultSemantics };
    state.semanticsEdited = false;
    persist(state);
    applyCurrentSkin();
}

// --- Custom CSS injection -------------------------------------------------
const CUSTOM_CSS_ID = 'webmail-custom-css';

export function setCustomCss(css: string) {
    state.customCss = (css || '').slice(0, 50_000);
    persist(state);
    applyCustomCss();
}

function applyCustomCss() {
    if (typeof document === 'undefined') return;
    let el = document.getElementById(CUSTOM_CSS_ID);
    if (!el) {
        el = document.createElement('style');
        el.id = CUSTOM_CSS_ID;
        document.head.appendChild(el);
    }
    el.textContent = state.customCss || '';
}

// Apply on first import so the page never flashes the default theme before
// the user's chosen skin lands.
if (typeof document !== 'undefined') {
    applyCurrentSkin();
    applyCustomCss();
}
