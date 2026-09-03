// User-selectable visual skins. Two flavours:
//
//   1. Light "accent" skins (default, iceberg, forest, sunset, etc.) only
//      override the *accent* family of CSS vars. Light/dark mode still drives
//      the surfaces and text — these skins respect both modes.
//
//   2. "Full" skins (cat themes, retro themes) override the entire palette
//      including backgrounds, text, borders, fonts, radii and shadows. They
//      look the same regardless of the user's light/dark setting because
//      they bake their own complete palette.
//
// User can also pick a custom accent hue — that's stored separately and
// derived live from a single hex.

const STORAGE_KEY = 'webmail.skin.v1';

export interface Skin {
    id: string;
    label: string;
    description: string;
    swatch: string;          // small hex preview shown in the picker
    /** Full skins are opinionated palettes that ignore light/dark mode. */
    full?: boolean;
    vars: Record<string, string>;
    /** Optional fancy bits that only load when this skin is active:
     *  - fonts: Google Font href URLs (loaded as <link rel="stylesheet">).
     *  - css: extra CSS pasted into a per-skin <style>. Use `:root` and
     *    standard selectors freely — only present while this skin is on.
     */
    extras?: {
        fonts?: string[];
        css?: string;
    };
    /** Mobile address-bar / browser chrome colour. Defaults to --bg-base
     *  for full skins; accent-only skins fall back to whatever the
     *  underlying light/dark theme resolves to. */
    themeColor?: string;
}

// Helpful palette builders for the retro themes ----------------------------
// All retro themes share the same chunky-square chrome: zero radius, no soft
// shadows, just a thin hard line.
const SQUARE_CHROME = {
    '--radius-xs': '0px',
    '--radius-sm': '0px',
    '--radius-md': '0px',
    '--radius-lg': '0px',
    '--radius-xl': '0px',
    '--shadow-sm': '0 0 0 1px rgba(0,0,0,0.4)',
    '--shadow-md': '2px 2px 0 rgba(0,0,0,0.5)',
    '--shadow-lg': '3px 3px 0 rgba(0,0,0,0.6)',
    '--pill-padding': '2px 8px'
};

const MONO_FONT = `'IBM Plex Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

export const SKINS: Skin[] = [
    {
        id: 'default',
        label: 'Indigo',
        description: 'Calm indigo — the original.',
        swatch: '#5b8def',
        vars: {
            '--accent': '#5b8def',
            '--accent-hover': '#4977dc',
            '--accent-soft': '#e6efff',
            '--accent-text': '#1f5cdb',
            '--unread-dot': '#5b8def',
            '--danger': '#c0392b',
            '--danger-soft': '#fde0db',
            '--success': '#2d9560',
            '--success-soft': '#dff5e8',
            '--warning': '#c98b15',
            '--warning-soft': '#fbf2da',
            '--star': '#f0a821'
        }
    },
    {
        id: 'iceberg',
        label: 'Iceberg',
        description: 'Cool teal — quiet but distinctive.',
        swatch: '#14b8a6',
        vars: {
            '--accent': '#14b8a6',
            '--accent-hover': '#0d9488',
            '--accent-soft': '#ccfbf1',
            '--accent-text': '#0f766e',
            '--unread-dot': '#14b8a6',
            '--danger': '#e05252',
            '--danger-soft': '#fce8e8',
            '--success': '#0d9488',
            '--success-soft': '#ccfbf1',
            '--warning': '#d97706',
            '--warning-soft': '#fef3c7',
            '--star': '#f59e0b'
        }
    },
    {
        id: 'forest',
        label: 'Forest',
        description: 'Earthy green — easy on the eyes.',
        swatch: '#16a34a',
        vars: {
            '--accent': '#16a34a',
            '--accent-hover': '#15803d',
            '--accent-soft': '#dcfce7',
            '--accent-text': '#15803d',
            '--unread-dot': '#16a34a',
            '--danger': '#b91c1c',
            '--danger-soft': '#fee2e2',
            '--success': '#15803d',
            '--success-soft': '#dcfce7',
            '--warning': '#a16207',
            '--warning-soft': '#fef9c3',
            '--star': '#eab308'
        }
    },
    {
        id: 'sunset',
        label: 'Sunset',
        description: 'Warm coral — playful and bright.',
        swatch: '#f97316',
        vars: {
            '--accent': '#f97316',
            '--accent-hover': '#ea580c',
            '--accent-soft': '#ffedd5',
            '--accent-text': '#c2410c',
            '--unread-dot': '#f97316',
            '--danger': '#dc2626',
            '--danger-soft': '#fee2e2',
            '--success': '#16a34a',
            '--success-soft': '#dcfce7',
            '--warning': '#eab308',
            '--warning-soft': '#fef9c3',
            '--star': '#fbbf24'
        }
    },
    {
        id: 'royal',
        label: 'Royal',
        description: 'Deep purple — Proton-flavoured.',
        swatch: '#8b5cf6',
        vars: {
            '--accent': '#8b5cf6',
            '--accent-hover': '#7c3aed',
            '--accent-soft': '#ede9fe',
            '--accent-text': '#6d28d9',
            '--unread-dot': '#8b5cf6',
            '--danger': '#ef4444',
            '--danger-soft': '#fee2e2',
            '--success': '#10b981',
            '--success-soft': '#d1fae5',
            '--warning': '#f59e0b',
            '--warning-soft': '#fef3c7',
            '--star': '#fbbf24'
        }
    },
    {
        id: 'slate',
        label: 'Slate',
        description: 'Monochrome — accent fades into the chrome.',
        swatch: '#475569',
        vars: {
            '--accent': '#475569',
            '--accent-hover': '#334155',
            '--accent-soft': '#e2e8f0',
            '--accent-text': '#1e293b',
            '--unread-dot': '#475569',
            '--danger': '#991b1b',
            '--danger-soft': '#fee2e2',
            '--success': '#166534',
            '--success-soft': '#dcfce7',
            '--warning': '#854d0e',
            '--warning-soft': '#fef9c3',
            '--star': '#ca8a04'
        }
    },
    {
        id: 'rose',
        label: 'Rose',
        description: 'Pink accent — warm and friendly.',
        swatch: '#ec4899',
        vars: {
            '--accent': '#ec4899',
            '--accent-hover': '#db2777',
            '--accent-soft': '#fce7f3',
            '--accent-text': '#be185d',
            '--unread-dot': '#ec4899',
            '--danger': '#dc2626',
            '--danger-soft': '#fee2e2',
            '--success': '#059669',
            '--success-soft': '#d1fae5',
            '--warning': '#d97706',
            '--warning-soft': '#fef3c7',
            '--star': '#f59e0b'
        }
    },
    {
        id: 'ember',
        label: 'Ember',
        description: 'Crimson — bold, high-contrast.',
        swatch: '#dc2626',
        vars: {
            '--accent': '#dc2626',
            '--accent-hover': '#b91c1c',
            '--accent-soft': '#fee2e2',
            '--accent-text': '#991b1b',
            '--unread-dot': '#dc2626',
            '--danger': '#b91c1c',
            '--danger-soft': '#fee2e2',
            '--success': '#16a34a',
            '--success-soft': '#dcfce7',
            '--warning': '#ca8a04',
            '--warning-soft': '#fef3c7',
            '--star': '#fbbf24'
        }
    },
    {
        id: 'midnight',
        label: 'Midnight',
        description: 'Navy and gold — refined and serious.',
        swatch: '#1e3a8a',
        vars: {
            '--accent': '#3b82f6',
            '--accent-hover': '#2563eb',
            '--accent-soft': '#dbeafe',
            '--accent-text': '#1e40af',
            '--unread-dot': '#3b82f6',
            '--danger': '#ef4444',
            '--danger-soft': '#fee2e2',
            '--success': '#10b981',
            '--success-soft': '#d1fae5',
            '--warning': '#f59e0b',
            '--warning-soft': '#fef3c7',
            '--star': '#fbbf24'
        }
    },
    {
        id: 'lemon',
        label: 'Lemon',
        description: 'Zesty lime on charcoal — high energy.',
        swatch: '#84cc16',
        vars: {
            '--accent': '#84cc16',
            '--accent-hover': '#65a30d',
            '--accent-soft': '#ecfccb',
            '--accent-text': '#3f6212',
            '--unread-dot': '#84cc16',
            '--danger': '#f43f5e',
            '--danger-soft': '#ffe4e6',
            '--success': '#10b981',
            '--success-soft': '#d1fae5',
            '--warning': '#f97316',
            '--warning-soft': '#ffedd5',
            '--star': '#eab308'
        }
    },
    {
        id: 'berry',
        label: 'Berry',
        description: 'Plum and raspberry — rich and moody.',
        swatch: '#a855f7',
        vars: {
            '--accent': '#a855f7',
            '--accent-hover': '#9333ea',
            '--accent-soft': '#f3e8ff',
            '--accent-text': '#6b21a8',
            '--unread-dot': '#a855f7',
            '--danger': '#e11d48',
            '--danger-soft': '#ffe4e6',
            '--success': '#10b981',
            '--success-soft': '#d1fae5',
            '--warning': '#f59e0b',
            '--warning-soft': '#fef3c7',
            '--star': '#fbbf24'
        }
    },
    {
        id: 'ocean',
        label: 'Ocean',
        description: 'Deep cyan and coral — tropical contrast.',
        swatch: '#06b6d4',
        vars: {
            '--accent': '#06b6d4',
            '--accent-hover': '#0891b2',
            '--accent-soft': '#cffafe',
            '--accent-text': '#155e75',
            '--unread-dot': '#06b6d4',
            '--danger': '#f43f5e',
            '--danger-soft': '#ffe4e6',
            '--success': '#22c55e',
            '--success-soft': '#dcfce7',
            '--warning': '#f97316',
            '--warning-soft': '#ffedd5',
            '--star': '#fbbf24'
        }
    },
    {
        id: 'neon',
        label: 'Neon',
        description: 'Electric magenta — high visibility, cyberpunk energy.',
        swatch: '#ff00ff',
        vars: {
            '--accent': '#d946ef',
            '--accent-hover': '#c026d3',
            '--accent-soft': '#fae8ff',
            '--accent-text': '#a21caf',
            '--unread-dot': '#d946ef',
            '--danger': '#ef4444',
            '--danger-soft': '#fee2e2',
            '--success': '#22c55e',
            '--success-soft': '#dcfce7',
            '--warning': '#f59e0b',
            '--warning-soft': '#fef3c7',
            '--star': '#fbbf24'
        }
    },
    {
        id: 'candy',
        label: 'Candy',
        description: 'Pastel pink and mint — soft, playful, friendly.',
        swatch: '#f472b6',
        vars: {
            '--accent': '#f472b6',
            '--accent-hover': '#ec4899',
            '--accent-soft': '#fce7f3',
            '--accent-text': '#be185d',
            '--unread-dot': '#f472b6',
            '--danger': '#ef4444',
            '--danger-soft': '#fee2e2',
            '--success': '#34d399',
            '--success-soft': '#d1fae5',
            '--warning': '#fbbf24',
            '--warning-soft': '#fef9c3',
            '--star': '#f59e0b'
        }
    },
    {
        id: 'earth',
        label: 'Earth',
        description: 'Terracotta and sage — warm, natural, grounded.',
        swatch: '#c2410c',
        vars: {
            '--accent': '#c2410c',
            '--accent-hover': '#9a3412',
            '--accent-soft': '#ffedd5',
            '--accent-text': '#7c2d12',
            '--unread-dot': '#c2410c',
            '--danger': '#b91c1c',
            '--danger-soft': '#fee2e2',
            '--success': '#15803d',
            '--success-soft': '#dcfce7',
            '--warning': '#a16207',
            '--warning-soft': '#fef9c3',
            '--star': '#ca8a04'
        }
    },
    {
        id: 'vampire',
        label: 'Vampire',
        description: 'Crimson on charcoal — dark, dramatic, gothic.',
        swatch: '#e11d48',
        vars: {
            '--accent': '#e11d48',
            '--accent-hover': '#be123c',
            '--accent-soft': '#ffe4e6',
            '--accent-text': '#9f1239',
            '--unread-dot': '#e11d48',
            '--danger': '#dc2626',
            '--danger-soft': '#fee2e2',
            '--success': '#16a34a',
            '--success-soft': '#dcfce7',
            '--warning': '#d97706',
            '--warning-soft': '#fef3c7',
            '--star': '#fbbf24'
        }
    },

    // ─── Cats (full luxury palettes) ──────────────────────────────────────
    {
        id: 'persian',
        label: 'Persian',
        description: 'Pearl, cream and champagne gold — opulent salon.',
        swatch: '#c9a961',
        full: true,
        extras: {
            fonts: [
                'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Inter:wght@400;500;600&display=swap'
            ],
            css: `
                /* Subtle damask wash on the page background. */
                body {
                    background:
                        radial-gradient(circle at 15% 10%, rgba(201,169,97,0.08), transparent 55%),
                        radial-gradient(circle at 85% 85%, rgba(201,169,97,0.06), transparent 55%),
                        var(--bg-base) !important;
                }
                /* Body copy stays sans-serif; headings/labels go full Garamond. */
                body, input, textarea, select, button { font-family: 'Inter', system-ui, sans-serif !important; }
                h1, h2, h3, h4, .brand, [data-theme-display],
                .skin-label, .compose-subject input, .message-subject {
                    font-family: 'Cormorant Garamond', 'Georgia', serif !important;
                    letter-spacing: 0.01em;
                }
            `
        },
        vars: {
            '--bg-base': '#f3ead6',
            '--bg-surface': '#fffaee',
            '--bg-surface-alt': '#f7eecf',
            '--bg-elevated': '#ffffff',
            '--bg-hover': '#f0e3b8',
            '--bg-active': '#e8d59a',
            '--bg-selected': '#f5e6b8',
            '--bg-overlay': 'rgba(60, 40, 10, 0.45)',
            '--bg-input': '#fffaee',
            '--bg-tag': '#f0e3b8',
            '--text-primary': '#3d2c0a',
            '--text-secondary': '#6b4f12',
            '--text-tertiary': '#826b33',
            '--text-on-accent': '#fffaee',
            '--text-link': '#7a5e22',
            '--border-subtle': '#e9dab7',
            '--border-soft': '#d6c397',
            '--border-strong': '#b8a06b',
            '--border-focus': '#c9a961',
            '--accent': '#c9a961',
            '--accent-hover': '#a88a44',
            '--accent-soft': '#faf3df',
            '--accent-text': '#7a5e22',
            '--unread-dot': '#c9a961',
            '--danger': '#9a3412',
            '--danger-soft': '#fde4d3',
            '--success': '#7d9b76',
            '--success-soft': '#eaf3e7',
            '--warning': '#b45309',
            '--warning-soft': '#fef3c7',
            '--star': '#f59e0b',
            '--font-sans': `'Cormorant Garamond', 'Georgia', 'Times New Roman', serif`,
            '--radius-xs': '6px',
            '--radius-sm': '8px',
            '--radius-md': '14px',
            '--radius-lg': '20px',
            '--radius-xl': '28px',
            '--shadow-sm': '0 1px 3px rgba(120, 90, 30, 0.18)',
            '--shadow-md': '0 8px 22px rgba(120, 90, 30, 0.22), 0 2px 6px rgba(120, 90, 30, 0.10)',
            '--shadow-lg': '0 26px 60px rgba(120, 90, 30, 0.34), 0 8px 18px rgba(120, 90, 30, 0.18)'
        }
    },
    {
        id: 'bengal',
        label: 'Bengal',
        description: 'Copper, amber and deep coffee — wild luxury.',
        swatch: '#c87532',
        full: true,
        vars: {
            '--bg-base': '#1c1410',
            '--bg-surface': '#2a1f18',
            '--bg-surface-alt': '#241a13',
            '--bg-elevated': '#34281e',
            '--bg-hover': '#3d3024',
            '--bg-active': '#4a3a2a',
            '--bg-selected': '#4d2f15',
            '--bg-overlay': 'rgba(0, 0, 0, 0.7)',
            '--bg-input': '#16100c',
            '--bg-tag': '#3d3024',
            '--text-primary': '#f5e9d4',
            '--text-secondary': '#d6b896',
            '--text-tertiary': '#a08767',
            '--text-on-accent': '#1c1410',
            '--text-link': '#e69b58',
            '--border-subtle': '#3d2f24',
            '--border-soft': '#4d3d2f',
            '--border-strong': '#6b5440',
            '--border-focus': '#c87532',
            '--accent': '#c87532',
            '--accent-hover': '#e69b58',
            '--accent-soft': '#3d2516',
            '--accent-text': '#e69b58',
            '--unread-dot': '#c87532',
            '--danger': '#ef6a52',
            '--danger-soft': '#3a1810',
            '--success': '#9bc06f',
            '--success-soft': '#1f2a14',
            '--warning': '#e6a456',
            '--warning-soft': '#352510',
            '--star': '#f0c14b',
            '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.6)',
            '--shadow-md': '0 8px 20px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4)',
            '--shadow-lg': '0 26px 60px rgba(0, 0, 0, 0.7), 0 8px 18px rgba(0, 0, 0, 0.45)'
        }
    },
    {
        id: 'russian-blue',
        label: 'Russian Blue',
        description: 'Silver-blue with jade eyes — quiet aristocracy.',
        swatch: '#6b8caf',
        full: true,
        vars: {
            '--bg-base': '#e8edf2',
            '--bg-surface': '#ffffff',
            '--bg-surface-alt': '#f0f4f8',
            '--bg-elevated': '#ffffff',
            '--bg-hover': '#dde4ec',
            '--bg-active': '#cfd9e4',
            '--bg-selected': '#dbe7f3',
            '--bg-overlay': 'rgba(30, 45, 65, 0.5)',
            '--bg-input': '#ffffff',
            '--bg-tag': '#dde4ec',
            '--text-primary': '#1f2937',
            '--text-secondary': '#475569',
            '--text-tertiary': '#64748b',
            '--text-on-accent': '#ffffff',
            '--text-link': '#3e5573',
            '--border-subtle': '#d6dde6',
            '--border-soft': '#bcc7d4',
            '--border-strong': '#94a3b8',
            '--border-focus': '#6b8caf',
            '--accent': '#6b8caf',
            '--accent-hover': '#547092',
            '--accent-soft': '#e7eef6',
            '--accent-text': '#3e5573',
            '--unread-dot': '#7ab38a',
            '--danger': '#be123c',
            '--danger-soft': '#ffe4e6',
            '--success': '#7ab38a',
            '--success-soft': '#dff5e8',
            '--warning': '#b45309',
            '--warning-soft': '#fef3c7',
            '--star': '#7ab38a',
            '--shadow-sm': '0 1px 2px rgba(60, 80, 100, 0.10)',
            '--shadow-md': '0 6px 18px rgba(60, 80, 100, 0.14)',
            '--shadow-lg': '0 22px 50px rgba(60, 80, 100, 0.22)'
        }
    },
    {
        id: 'siamese',
        label: 'Siamese',
        description: 'Cream and chocolate with sapphire eyes.',
        swatch: '#1e40af',
        full: true,
        vars: {
            '--bg-base': '#f3e6c4',
            '--bg-surface': '#fffaee',
            '--bg-surface-alt': '#f7eccd',
            '--bg-elevated': '#ffffff',
            '--bg-hover': '#ebd9a8',
            '--bg-active': '#dcc88a',
            '--bg-selected': '#dbe4ff',
            '--bg-overlay': 'rgba(60, 36, 16, 0.5)',
            '--bg-input': '#fffaee',
            '--bg-tag': '#ebd9a8',
            '--text-primary': '#3d2410',
            '--text-secondary': '#6b4423',
            '--text-tertiary': '#8b6841',
            '--text-on-accent': '#fffaee',
            '--text-link': '#1e40af',
            '--border-subtle': '#e5d2a8',
            '--border-soft': '#d0b884',
            '--border-strong': '#a98c5a',
            '--border-focus': '#1e40af',
            '--accent': '#1e40af',
            '--accent-hover': '#1e3a8a',
            '--accent-soft': '#dbeafe',
            '--accent-text': '#1e3a8a',
            '--unread-dot': '#1e40af',
            '--danger': '#9f1239',
            '--danger-soft': '#ffe4e6',
            '--success': '#047857',
            '--success-soft': '#d1fae5',
            '--warning': '#92400e',
            '--warning-soft': '#fef3c7',
            '--star': '#1e40af',
            '--shadow-sm': '0 1px 3px rgba(80, 50, 15, 0.16)',
            '--shadow-md': '0 8px 20px rgba(80, 50, 15, 0.20)',
            '--shadow-lg': '0 24px 56px rgba(80, 50, 15, 0.30)'
        }
    },
    {
        id: 'tuxedo',
        label: 'Tuxedo',
        description: 'Black tie and gold leaf — formal occasion.',
        swatch: '#c4a657',
        full: true,
        extras: {
            fonts: [
                'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap'
            ],
            css: `
                /* Faint gold radial spotlight to suggest a chandelier. */
                body {
                    background:
                        radial-gradient(circle at 50% -10%, rgba(196,166,87,0.10), transparent 60%),
                        radial-gradient(circle at 100% 100%, rgba(196,166,87,0.06), transparent 50%),
                        var(--bg-base) !important;
                }
                body, input, textarea, select, button { font-family: 'Inter', system-ui, sans-serif !important; }
                h1, h2, h3, h4, .brand, .compose-subject input, .message-subject {
                    font-family: 'Cormorant Garamond', 'Didot', 'Georgia', serif !important;
                    letter-spacing: 0.02em;
                    font-weight: 500;
                }
                /* Gold hairline under headers. */
                h1, h2 { border-bottom: 1px solid rgba(196,166,87,0.35); padding-bottom: 4px; }
            `
        },
        vars: {
            '--bg-base': '#0a0a0a',
            '--bg-surface': '#141414',
            '--bg-surface-alt': '#0f0f0f',
            '--bg-elevated': '#1c1c1c',
            '--bg-hover': '#1f1c12',
            '--bg-active': '#2a2410',
            '--bg-selected': '#3a2f0d',
            '--bg-overlay': 'rgba(0, 0, 0, 0.85)',
            '--bg-input': '#0a0a0a',
            '--bg-tag': '#1f1c12',
            '--text-primary': '#f5f0e0',
            '--text-secondary': '#c4a657',
            '--text-tertiary': '#98844f',
            '--text-on-accent': '#0a0a0a',
            '--text-link': '#facc15',
            '--border-subtle': '#1f1c12',
            '--border-soft': '#3a2f0d',
            '--border-strong': '#6b541e',
            '--border-focus': '#c4a657',
            '--accent': '#c4a657',
            '--accent-hover': '#facc15',
            '--accent-soft': '#2a2410',
            '--accent-text': '#facc15',
            '--unread-dot': '#c4a657',
            '--danger': '#f87171',
            '--danger-soft': '#3a1410',
            '--success': '#86efac',
            '--success-soft': '#0d2a14',
            '--warning': '#fcd34d',
            '--warning-soft': '#3a2810',
            '--star': '#facc15',
            '--font-sans': `'Cormorant Garamond', 'Georgia', 'Didot', serif`,
            '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.7)',
            '--shadow-md': '0 8px 20px rgba(0, 0, 0, 0.65), 0 2px 6px rgba(0, 0, 0, 0.5)',
            '--shadow-lg': '0 28px 60px rgba(0, 0, 0, 0.85), 0 8px 18px rgba(0, 0, 0, 0.6)'
        }
    },

    // ─── Retro computers (full square-chrome palettes) ────────────────────
    {
        id: 'amiga',
        label: 'Amiga Workbench',
        description: 'Workbench 1.x blue-gray with orange title bars.',
        swatch: '#ff8800',
        full: true,
        extras: {
            fonts: [
                'https://fonts.googleapis.com/css2?family=VT323&display=swap'
            ],
            css: `
                body, input, textarea, select, button {
                    font-family: 'VT323', 'IBM Plex Mono', monospace !important;
                    font-size: 16px !important;
                }
                /* Workbench dotted-pattern background. */
                body {
                    background:
                        radial-gradient(rgba(0,0,0,0.18) 1px, transparent 1px) 0 0/4px 4px,
                        var(--bg-base) !important;
                }
                /* Chunky black border on every card / surface. */
                .card, .panel, .surface, .modal, .dialog, [class*='-card'], [class*='-panel'] {
                    border: 2px solid #000 !important;
                    border-radius: 0 !important;
                }
                input, textarea, select {
                    border: 2px solid #000 !important;
                    border-radius: 0 !important;
                }
                /* Buttons get the chunky outset bevel. */
                .btn, button.btn-primary, button.btn-secondary {
                    border: 2px solid #000 !important;
                    border-radius: 0 !important;
                    box-shadow: inset -2px -2px 0 #555, inset 2px 2px 0 #fff !important;
                }
                .btn:active { box-shadow: inset 2px 2px 0 #555, inset -2px -2px 0 #fff !important; transform: none !important; }
                /* Workbench-style chunky square scrollbars. */
                * { scrollbar-color: #000 #aaaaaa; scrollbar-width: auto; }
                *::-webkit-scrollbar { width: 16px; height: 16px; background: #aaaaaa; }
                *::-webkit-scrollbar-thumb { background: #000; border: 2px solid #aaaaaa; border-radius: 0; }
                *::-webkit-scrollbar-corner { background: #aaaaaa; }
            `
        },
        vars: {
            ...SQUARE_CHROME,
            '--bg-base': '#6e7e9e',
            '--bg-surface': '#aaaaaa',
            '--bg-surface-alt': '#999999',
            '--bg-elevated': '#bbbbbb',
            '--bg-hover': '#c4c4c4',
            '--bg-active': '#888888',
            '--bg-selected': '#ff8800',
            '--bg-overlay': 'rgba(0, 0, 0, 0.6)',
            '--bg-input': '#ffffff',
            '--bg-tag': '#999999',
            '--text-primary': '#000000',
            '--text-secondary': '#000000',
            '--text-tertiary': '#222222',
            '--text-on-accent': '#000000',
            '--text-link': '#0000aa',
            '--border-subtle': '#000000',
            '--border-soft': '#000000',
            '--border-strong': '#000000',
            '--border-focus': '#ff8800',
            '--accent': '#ff8800',
            '--accent-hover': '#cc6c00',
            '--accent-soft': '#ffd9a8',
            '--accent-text': '#000000',
            '--unread-dot': '#ff8800',
            '--danger': '#d22020',
            '--danger-soft': '#f7c2c2',
            '--success': '#218821',
            '--success-soft': '#bce5bc',
            '--warning': '#ff8800',
            '--warning-soft': '#ffd9a8',
            '--star': '#ffcc00',
            '--font-sans': `'Topaz', 'IBM Plex Mono', ${MONO_FONT}`,
            '--font-mono': `'Topaz', ${MONO_FONT}`
        }
    },
    {
        id: 'dos-amber',
        label: 'DOS Amber',
        description: 'Amber phosphor on black — warm CRT glow.',
        swatch: '#ffb000',
        full: true,
        extras: {
            fonts: [
                'https://fonts.googleapis.com/css2?family=VT323&display=swap'
            ],
            css: `
                body, input, textarea, select, button {
                    font-family: 'VT323', 'IBM Plex Mono', monospace !important;
                    font-size: 17px !important;
                }
                /* CRT scanlines + faint phosphor glow. */
                body::before {
                    content: '';
                    position: fixed; inset: 0;
                    pointer-events: none;
                    background: repeating-linear-gradient(
                        to bottom,
                        rgba(255,176,0,0.04) 0,
                        rgba(255,176,0,0.04) 1px,
                        transparent 1px,
                        transparent 3px
                    );
                    z-index: 9999;
                }
                body, .text-primary, h1, h2, h3, h4, .message-subject {
                    text-shadow: 0 0 3px rgba(255,176,0,0.55), 0 0 8px rgba(255,176,0,0.25);
                }
                .card, .panel, .surface, [class*='-card'], [class*='-panel'] {
                    border: 1px solid var(--border-soft) !important;
                    border-radius: 0 !important;
                }
                /* Phosphor scrollbars. */
                * { scrollbar-color: #ffb000 #000; scrollbar-width: thin; }
                *::-webkit-scrollbar { width: 12px; height: 12px; background: #000; }
                *::-webkit-scrollbar-thumb { background: #ffb000; border: 2px solid #000; border-radius: 0; box-shadow: 0 0 4px rgba(255,176,0,0.4); }
                *::-webkit-scrollbar-corner { background: #000; }
            `
        },
        vars: {
            ...SQUARE_CHROME,
            '--bg-base': '#000000',
            '--bg-surface': '#000000',
            '--bg-surface-alt': '#0a0600',
            '--bg-elevated': '#110a00',
            '--bg-hover': '#1a1000',
            '--bg-active': '#221600',
            '--bg-selected': '#ffb000',
            '--bg-overlay': 'rgba(0, 0, 0, 0.92)',
            '--bg-input': '#000000',
            '--bg-tag': '#221600',
            '--text-primary': '#ffb000',
            '--text-secondary': '#cc8800',
            '--text-tertiary': '#9f6f0f',
            '--text-on-accent': '#000000',
            '--text-link': '#ffd97a',
            '--border-subtle': '#663700',
            '--border-soft': '#885900',
            '--border-strong': '#cc8800',
            '--border-focus': '#ffb000',
            '--accent': '#ffb000',
            '--accent-hover': '#ffd97a',
            '--accent-soft': '#332100',
            '--accent-text': '#ffd97a',
            '--unread-dot': '#ffb000',
            '--danger': '#ff5050',
            '--danger-soft': '#3a0a0a',
            '--success': '#88dd88',
            '--success-soft': '#0a2a0a',
            '--warning': '#ffd97a',
            '--warning-soft': '#332100',
            '--star': '#ffd97a',
            '--font-sans': MONO_FONT,
            '--font-mono': MONO_FONT,
            '--shadow-sm': '0 0 4px rgba(255, 176, 0, 0.4)',
            '--shadow-md': '0 0 12px rgba(255, 176, 0, 0.5)',
            '--shadow-lg': '0 0 28px rgba(255, 176, 0, 0.55)'
        }
    },
    {
        id: 'dos-green',
        label: 'DOS Green',
        description: 'Green phosphor — terminal nostalgia.',
        swatch: '#2bd62b',
        full: true,
        extras: {
            fonts: [
                'https://fonts.googleapis.com/css2?family=VT323&display=swap'
            ],
            css: `
                body, input, textarea, select, button {
                    font-family: 'VT323', 'IBM Plex Mono', monospace !important;
                    font-size: 17px !important;
                }
                body::before {
                    content: '';
                    position: fixed; inset: 0;
                    pointer-events: none;
                    background: repeating-linear-gradient(
                        to bottom,
                        rgba(43,214,43,0.05) 0,
                        rgba(43,214,43,0.05) 1px,
                        transparent 1px,
                        transparent 3px
                    );
                    z-index: 9999;
                }
                body, .text-primary, h1, h2, h3, h4, .message-subject {
                    text-shadow: 0 0 3px rgba(43,214,43,0.55), 0 0 8px rgba(43,214,43,0.25);
                }
                .card, .panel, .surface, [class*='-card'], [class*='-panel'] {
                    border: 1px solid var(--border-soft) !important;
                    border-radius: 0 !important;
                }
                * { scrollbar-color: #2bd62b #000; scrollbar-width: thin; }
                *::-webkit-scrollbar { width: 12px; height: 12px; background: #000; }
                *::-webkit-scrollbar-thumb { background: #2bd62b; border: 2px solid #000; border-radius: 0; box-shadow: 0 0 4px rgba(43,214,43,0.4); }
                *::-webkit-scrollbar-corner { background: #000; }
            `
        },
        vars: {
            ...SQUARE_CHROME,
            '--bg-base': '#000000',
            '--bg-surface': '#000000',
            '--bg-surface-alt': '#000a00',
            '--bg-elevated': '#001000',
            '--bg-hover': '#001a00',
            '--bg-active': '#002a00',
            '--bg-selected': '#2bd62b',
            '--bg-overlay': 'rgba(0, 0, 0, 0.92)',
            '--bg-input': '#000000',
            '--bg-tag': '#001f00',
            '--text-primary': '#2bd62b',
            '--text-secondary': '#1ea71e',
            '--text-tertiary': '#498549',
            '--text-on-accent': '#000000',
            '--text-link': '#aaff00',
            '--border-subtle': '#0a3d0a',
            '--border-soft': '#166316',
            '--border-strong': '#1ea71e',
            '--border-focus': '#2bd62b',
            '--accent': '#2bd62b',
            '--accent-hover': '#aaff00',
            '--accent-soft': '#001a00',
            '--accent-text': '#aaff00',
            '--unread-dot': '#2bd62b',
            '--danger': '#ff5050',
            '--danger-soft': '#3a0a0a',
            '--success': '#2bd62b',
            '--success-soft': '#001a00',
            '--warning': '#ffaa00',
            '--warning-soft': '#2a1a00',
            '--star': '#aaff00',
            '--font-sans': MONO_FONT,
            '--font-mono': MONO_FONT,
            '--shadow-sm': '0 0 4px rgba(43, 214, 43, 0.4)',
            '--shadow-md': '0 0 12px rgba(43, 214, 43, 0.5)',
            '--shadow-lg': '0 0 28px rgba(43, 214, 43, 0.55)'
        }
    },
    {
        id: 'c64',
        label: 'Commodore 64',
        description: 'Light blue on navy — 8-bit royalty.',
        swatch: '#7869c4',
        full: true,
        extras: {
            fonts: [
                'https://fonts.googleapis.com/css2?family=VT323&display=swap'
            ],
            css: `
                body, input, textarea, select, button {
                    font-family: 'VT323', 'IBM Plex Mono', monospace !important;
                    font-size: 17px !important;
                    text-transform: uppercase;
                }
                /* Iconic light-blue border around the whole screen. */
                body {
                    border: 12px solid #7869c4 !important;
                    box-sizing: border-box;
                }
                /* Subtle scanlines for the CRT vibe. */
                body::before {
                    content: '';
                    position: fixed; inset: 0;
                    pointer-events: none;
                    background: repeating-linear-gradient(
                        to bottom,
                        rgba(184,176,240,0.04) 0,
                        rgba(184,176,240,0.04) 1px,
                        transparent 1px,
                        transparent 3px
                    );
                    z-index: 9999;
                }
                .card, .panel, .surface, [class*='-card'], [class*='-panel'] {
                    border: 1px solid var(--border-soft) !important;
                    border-radius: 0 !important;
                }
                * { scrollbar-color: #b8b0f0 #4641c4; scrollbar-width: auto; }
                *::-webkit-scrollbar { width: 14px; height: 14px; background: #4641c4; }
                *::-webkit-scrollbar-thumb { background: #b8b0f0; border: 2px solid #4641c4; border-radius: 0; }
                *::-webkit-scrollbar-corner { background: #4641c4; }
            `
        },
        vars: {
            ...SQUARE_CHROME,
            '--bg-base': '#7869c4',
            '--bg-surface': '#4641c4',
            '--bg-surface-alt': '#3d3aa8',
            '--bg-elevated': '#5b51c9',
            '--bg-hover': '#5b51c9',
            '--bg-active': '#3d3aa8',
            '--bg-selected': '#b8b0f0',
            '--bg-overlay': 'rgba(20, 15, 60, 0.7)',
            '--bg-input': '#3d3aa8',
            '--bg-tag': '#5b51c9',
            '--text-primary': '#dfdcf8',
            '--text-secondary': '#ccc8f3',
            '--text-tertiary': '#cdcae8',
            '--text-on-accent': '#4641c4',
            '--text-link': '#ffffff',
            '--border-subtle': '#5b51c9',
            '--border-soft': '#7869c4',
            '--border-strong': '#b8b0f0',
            '--border-focus': '#b8b0f0',
            '--accent': '#b8b0f0',
            '--accent-hover': '#ffffff',
            '--accent-soft': '#5b51c9',
            '--accent-text': '#ffffff',
            '--unread-dot': '#b8b0f0',
            '--danger': '#ff8a8a',
            '--danger-soft': '#3a1818',
            '--success': '#90ee90',
            '--success-soft': '#1a3a1a',
            '--warning': '#ffe066',
            '--warning-soft': '#3a3018',
            '--star': '#ffe066',
            '--font-sans': MONO_FONT,
            '--font-mono': MONO_FONT
        }
    },
    {
        id: 'win95',
        label: 'Windows 95',
        description: 'Teal desktop, silver chrome, navy selection.',
        swatch: '#008080',
        full: true,
        extras: {
            css: `
                body, input, textarea, select, button {
                    font-family: 'MS Sans Serif', 'Tahoma', 'Geneva', sans-serif !important;
                    font-size: 12px !important;
                }
                /* Classic Plus! teal cloth pattern on the desktop. */
                body {
                    background:
                        repeating-linear-gradient(45deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 4px),
                        var(--bg-base) !important;
                }
                /* Chiseled bevel — the signature Win95 look. */
                .card, .panel, .surface, .modal, .dialog, [class*='-card'], [class*='-panel'] {
                    border: none !important;
                    border-radius: 0 !important;
                    box-shadow:
                        inset -1px -1px 0 #404040,
                        inset 1px 1px 0 #ffffff !important;
                }
                input, textarea, select {
                    border: none !important;
                    border-radius: 0 !important;
                    box-shadow:
                        inset 1px 1px 0 #404040,
                        inset -1px -1px 0 #ffffff !important;
                    padding: 3px 5px !important;
                }
                .btn, button.btn-primary, button.btn-secondary {
                    border: 1px solid #000 !important;
                    border-radius: 0 !important;
                    background: #c0c0c0 !important;
                    color: #000 !important;
                    box-shadow:
                        inset -1px -1px 0 #404040,
                        inset 1px 1px 0 #ffffff !important;
                    padding: 4px 14px !important;
                }
                .btn:active {
                    box-shadow:
                        inset 1px 1px 0 #404040,
                        inset -1px -1px 0 #ffffff !important;
                    transform: none !important;
                }
                /* Iconic chunky Win95 scrollbar — silver thumb on a dotted track. */
                * { scrollbar-color: #c0c0c0 #d4d0c8; scrollbar-width: auto; }
                *::-webkit-scrollbar { width: 17px; height: 17px; background: #d4d0c8; }
                *::-webkit-scrollbar-track {
                    background:
                        repeating-linear-gradient(45deg, #c0c0c0 0 1px, #d4d0c8 1px 2px);
                }
                *::-webkit-scrollbar-thumb {
                    background: #c0c0c0;
                    border-radius: 0;
                    box-shadow:
                        inset -1px -1px 0 #404040,
                        inset 1px 1px 0 #ffffff,
                        inset -2px -2px 0 #808080,
                        inset 2px 2px 0 #dfdfdf;
                }
                *::-webkit-scrollbar-corner { background: #d4d0c8; }
            `
        },
        vars: {
            ...SQUARE_CHROME,
            '--bg-base': '#008080',
            '--bg-surface': '#c0c0c0',
            '--bg-surface-alt': '#bcbcbc',
            '--bg-elevated': '#c0c0c0',
            '--bg-hover': '#d4d0c8',
            '--bg-active': '#a0a0a0',
            '--bg-selected': '#000080',
            '--bg-overlay': 'rgba(0, 0, 0, 0.55)',
            '--bg-input': '#ffffff',
            '--bg-tag': '#d4d0c8',
            '--text-primary': '#000000',
            '--text-secondary': '#000000',
            '--text-tertiary': '#3a3a3a',
            '--text-on-accent': '#ffffff',
            '--text-link': '#0000aa',
            '--border-subtle': '#808080',
            '--border-soft': '#404040',
            '--border-strong': '#000000',
            '--border-focus': '#000080',
            '--accent': '#000080',
            '--accent-hover': '#0000c8',
            '--accent-soft': '#d4d0c8',
            '--accent-text': '#000080',
            '--unread-dot': '#000080',
            '--danger': '#800000',
            '--danger-soft': '#f4d6d6',
            '--success': '#006400',
            '--success-soft': '#d6ecd6',
            '--warning': '#808000',
            '--warning-soft': '#ececc7',
            '--star': '#ffcc00',
            '--font-sans': `'MS Sans Serif', 'Tahoma', 'Geneva', sans-serif`,
            '--shadow-sm': 'inset -1px -1px 0 #404040, inset 1px 1px 0 #ffffff',
            '--shadow-md': 'inset -1px -1px 0 #404040, inset 1px 1px 0 #ffffff, 2px 2px 0 rgba(0,0,0,0.4)',
            '--shadow-lg': 'inset -1px -1px 0 #404040, inset 1px 1px 0 #ffffff, 4px 4px 0 rgba(0,0,0,0.5)'
        }
    },

    // ─── Microsoft Outlook on the web (full spitting-image palette) ───────
    {
        id: 'outlook',
        label: 'Outlook',
        description: 'Microsoft Outlook on the web — azure chrome, Segoe UI, white surfaces.',
        swatch: '#0078d4',
        full: true,
        extras: {
            css: `
                /* Azure command bar. The topbar is the OWA header: brand and
                 * ghost icons go white, the search box becomes the white
                 * OWA search field, the user chip already paints itself
                 * with --bg-base (white) so it reads as the OWA avatar. */
                .topbar {
                    background: #0078d4 !important;
                    border-bottom: 1px solid #106ebe !important;
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
                .topbar .search-wrap {
                    background: #ffffff !important;
                    border: 1px solid #ffffff !important;
                }
                .topbar .search-wrap input { color: #242424 !important; }
                .topbar .search-wrap input::placeholder { color: #616161 !important; }
                .topbar .search-scope-btn { color: #0078d4 !important; border-color: #c8c6c4 !important; }
                .topbar .muted { color: rgba(255,255,255,0.85) !important; }

                /* OWA marks unread rows with a blue edge bar and a blue
                 * bolded subject — no dot, no tint. */
                .row.unread { box-shadow: inset 3px 0 0 var(--accent) !important; }
                .row.unread .subject { color: var(--accent-text) !important; }

                /* OWA is flat: rows, folders and buttons don't lift. */
                .btn:hover, .row:hover, .folder:hover { transform: none !important; }
            `
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
            '--bg-selected': '#cfe4fa',
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
        }
    },

    // ─── Photo themes (load real images at runtime) ───────────────────────
    // These hit third-party endpoints (cataas.com / loremflickr.com) the
    // first time the theme activates, then the browser caches them. Opt-in
    // and clearly described so users know they're paying with a network
    // fetch.
    {
        id: 'cat-photos',
        label: 'Cat Photos',
        description: 'Pink + cream salon with real cat portraits in the chrome. Loads images from cataas.com.',
        swatch: '#f97391',
        full: true,
        extras: {
            fonts: [
                'https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap'
            ],
            css: `
                body, input, textarea, select, button { font-family: 'Quicksand', system-ui, sans-serif !important; }
                /* Soft pink wash + faint paw-print pattern across the page. */
                body {
                    background:
                        radial-gradient(circle at 12% 18%, rgba(249,115,145,0.10), transparent 55%),
                        radial-gradient(circle at 90% 92%, rgba(249,115,145,0.10), transparent 55%),
                        var(--bg-base) !important;
                }
                /* Random cataas portrait wedged into the bottom-right corner —
                   non-blocking, decorative, doesn't intercept clicks. */
                body::after {
                    content: '';
                    position: fixed;
                    right: 14px;
                    bottom: 14px;
                    width: 96px;
                    height: 96px;
                    border-radius: 50%;
                    background-image: url('https://cataas.com/cat?width=192&height=192');
                    background-size: cover;
                    background-position: center;
                    border: 3px solid #f97391;
                    box-shadow: 0 6px 18px rgba(249,115,145,0.35), 0 0 0 4px rgba(249,115,145,0.18);
                    pointer-events: none;
                    z-index: 40;
                    opacity: 0.95;
                }
                /* Smaller portrait in the empty-state of message panes for fun. */
                .empty-state::before, .placeholder::before {
                    content: '';
                    display: block;
                    width: 140px;
                    height: 140px;
                    margin: 0 auto 12px;
                    border-radius: 50%;
                    background-image: url('https://cataas.com/cat/cute?width=280&height=280');
                    background-size: cover;
                    background-position: center;
                    border: 4px solid #f97391;
                    box-shadow: 0 8px 22px rgba(249,115,145,0.25);
                }
                * { scrollbar-color: #f97391 #fff5f7; scrollbar-width: thin; }
                *::-webkit-scrollbar-thumb { background: #f97391; }
            `
        },
        themeColor: '#fff5f7',
        vars: {
            '--bg-base': '#fff5f7',
            '--bg-surface': '#ffffff',
            '--bg-surface-alt': '#fde9ed',
            '--bg-elevated': '#ffffff',
            '--bg-hover': '#fad9df',
            '--bg-active': '#f5c4cd',
            '--bg-selected': '#fad9df',
            '--bg-overlay': 'rgba(80, 30, 50, 0.45)',
            '--bg-input': '#ffffff',
            '--bg-tag': '#fde9ed',
            '--text-primary': '#3a1923',
            '--text-secondary': '#7a3349',
            '--text-tertiary': '#a36175',
            '--text-on-accent': '#ffffff',
            '--text-link': '#be1b4a',
            '--border-subtle': '#f7d3da',
            '--border-soft': '#f0a8b6',
            '--border-strong': '#dd6f86',
            '--border-focus': '#f97391',
            '--accent': '#f97391',
            '--accent-hover': '#e85276',
            '--accent-soft': '#fde9ed',
            '--accent-text': '#be1b4a',
            '--unread-dot': '#f97391',
            '--danger': '#c0392b',
            '--danger-soft': '#fde0db',
            '--success': '#7ab38a',
            '--success-soft': '#dff5e8',
            '--warning': '#d97706',
            '--warning-soft': '#fef3c7',
            '--star': '#f59e0b',
            '--radius-md': '14px',
            '--radius-lg': '20px',
            '--radius-xl': '28px',
            '--shadow-sm': '0 1px 3px rgba(249,115,145,0.18)',
            '--shadow-md': '0 8px 22px rgba(249,115,145,0.20), 0 2px 6px rgba(249,115,145,0.10)',
            '--shadow-lg': '0 26px 60px rgba(249,115,145,0.30), 0 8px 18px rgba(249,115,145,0.18)'
        }
    },
    {
        id: 'hamster',
        label: 'Hamster',
        description: 'Warm caramel + sunflower seeds with hamster portraits. Loads images from loremflickr.com.',
        swatch: '#d97a3a',
        full: true,
        extras: {
            fonts: [
                'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap'
            ],
            css: `
                body, input, textarea, select, button { font-family: 'Nunito', system-ui, sans-serif !important; }
                /* Tiny sunflower-seed pattern repeating across the page. */
                body {
                    background:
                        radial-gradient(ellipse 4px 7px at 25% 30%, rgba(120,72,30,0.10), transparent 60%),
                        radial-gradient(ellipse 4px 7px at 75% 70%, rgba(120,72,30,0.10), transparent 60%),
                        radial-gradient(circle at 12% 18%, rgba(217,122,58,0.08), transparent 55%),
                        radial-gradient(circle at 90% 92%, rgba(217,122,58,0.10), transparent 55%),
                        var(--bg-base) !important;
                    background-size: 24px 24px, 24px 24px, auto, auto !important;
                }
                /* Round hamster portrait in the corner. */
                body::after {
                    content: '';
                    position: fixed;
                    right: 14px;
                    bottom: 14px;
                    width: 96px;
                    height: 96px;
                    border-radius: 50%;
                    background-image: url('https://loremflickr.com/192/192/hamster');
                    background-size: cover;
                    background-position: center;
                    border: 3px solid #d97a3a;
                    box-shadow: 0 6px 18px rgba(217,122,58,0.35), 0 0 0 4px rgba(217,122,58,0.20);
                    pointer-events: none;
                    z-index: 40;
                    opacity: 0.95;
                }
                .empty-state::before, .placeholder::before {
                    content: '';
                    display: block;
                    width: 140px;
                    height: 140px;
                    margin: 0 auto 12px;
                    border-radius: 50%;
                    background-image: url('https://loremflickr.com/280/280/hamster,cute');
                    background-size: cover;
                    background-position: center;
                    border: 4px solid #d97a3a;
                    box-shadow: 0 8px 22px rgba(217,122,58,0.25);
                }
                * { scrollbar-color: #d97a3a #fbf2e6; scrollbar-width: thin; }
                *::-webkit-scrollbar-thumb { background: #d97a3a; }
            `
        },
        themeColor: '#fbf2e6',
        vars: {
            '--bg-base': '#fbf2e6',
            '--bg-surface': '#fff9ee',
            '--bg-surface-alt': '#f5e6cc',
            '--bg-elevated': '#ffffff',
            '--bg-hover': '#f0d9b3',
            '--bg-active': '#e8c692',
            '--bg-selected': '#f0d9b3',
            '--bg-overlay': 'rgba(80, 50, 20, 0.45)',
            '--bg-input': '#ffffff',
            '--bg-tag': '#f5e6cc',
            '--text-primary': '#3a2410',
            '--text-secondary': '#6b4423',
            '--text-tertiary': '#8b6841',
            '--text-on-accent': '#ffffff',
            '--text-link': '#a4521b',
            '--border-subtle': '#ecd9b6',
            '--border-soft': '#d6b884',
            '--border-strong': '#a98c5a',
            '--border-focus': '#d97a3a',
            '--accent': '#d97a3a',
            '--accent-hover': '#b85a1f',
            '--accent-soft': '#fde6cb',
            '--accent-text': '#a4521b',
            '--unread-dot': '#d97a3a',
            '--danger': '#9a3412',
            '--danger-soft': '#fde4d3',
            '--success': '#7d9b3a',
            '--success-soft': '#eaf3d6',
            '--warning': '#b45309',
            '--warning-soft': '#fef3c7',
            '--star': '#eab308',
            '--radius-md': '14px',
            '--radius-lg': '20px',
            '--radius-xl': '28px',
            '--shadow-sm': '0 1px 3px rgba(120,72,30,0.18)',
            '--shadow-md': '0 8px 22px rgba(120,72,30,0.20), 0 2px 6px rgba(120,72,30,0.10)',
            '--shadow-lg': '0 26px 60px rgba(120,72,30,0.30), 0 8px 18px rgba(120,72,30,0.18)'
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

function customSkinVars(accentHex: string, overrides?: Partial<Record<string, string>>): Record<string, string> | null {
    const base = hslAccent(accentHex);
    if (!base) return null;
    const { h, s, l } = base;
    const accent = base.str;
    const hover = `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${Math.max(0, l - 8).toFixed(1)}%)`;
    const soft = `hsl(${h.toFixed(1)} ${Math.min(100, s + 5).toFixed(1)}% ${Math.min(95, l + 32).toFixed(1)}%)`;
    const text = `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${Math.max(15, l - 18).toFixed(1)}%)`;
    return {
        '--accent': accent,
        '--accent-hover': hover,
        '--accent-soft': soft,
        '--accent-text': text,
        '--unread-dot': accent,
        '--danger': overrides?.['--danger'] || '#c0392b',
        '--danger-soft': overrides?.['--danger-soft'] || '#fde0db',
        '--success': overrides?.['--success'] || '#2d9560',
        '--success-soft': overrides?.['--success-soft'] || '#dff5e8',
        '--warning': overrides?.['--warning'] || '#c98b15',
        '--warning-soft': overrides?.['--warning-soft'] || '#fbf2da',
        '--star': overrides?.['--star'] || '#f0a821'
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
    skinId: string;
    customAccent: string;
    semantics: SemanticOverrides;
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
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            const sem = parsed.semantics || {};
            return {
                skinId: typeof parsed.skinId === 'string' ? parsed.skinId : 'default',
                customAccent: typeof parsed.customAccent === 'string' ? parsed.customAccent : '#5b8def',
                semantics: {
                    danger: typeof sem.danger === 'string' ? sem.danger : defaultSemantics.danger,
                    dangerSoft: typeof sem.dangerSoft === 'string' ? sem.dangerSoft : defaultSemantics.dangerSoft,
                    success: typeof sem.success === 'string' ? sem.success : defaultSemantics.success,
                    successSoft: typeof sem.successSoft === 'string' ? sem.successSoft : defaultSemantics.successSoft,
                    warning: typeof sem.warning === 'string' ? sem.warning : defaultSemantics.warning,
                    warningSoft: typeof sem.warningSoft === 'string' ? sem.warningSoft : defaultSemantics.warningSoft,
                    star: typeof sem.star === 'string' ? sem.star : defaultSemantics.star
                },
                customCss: typeof parsed.customCss === 'string' ? parsed.customCss.slice(0, 50_000) : ''
            };
        }
    } catch { /* noop */ }
    return { skinId: 'default', customAccent: '#5b8def', semantics: { ...defaultSemantics }, customCss: '' };
}

function persist(s: SkinState) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota */ }
}

const state = $state<SkinState>(load());

export const skinState = state;

// Every var any skin might set. Listed here so we always reset cleanly when
// switching from a fully-themed skin (cat / retro) back to an accent-only one.
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

// Per-skin extras (custom fonts + CSS effects). Lazily loaded only when a
// skin that defines them is active; cleaned up when the user switches away
// so we never carry dead Google Fonts / glow effects between themes.
const SKIN_EXTRAS_STYLE_ID = 'webmail-skin-extras';
const SKIN_EXTRAS_FONT_ID_PREFIX = 'webmail-skin-font-';

function applyExtras(skin: Skin | null) {
    if (typeof document === 'undefined') return;

    // Drop previous skin's font links so unused webfonts stop fetching.
    document.querySelectorAll(`link[id^="${SKIN_EXTRAS_FONT_ID_PREFIX}"]`).forEach((el) => el.remove());

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

    const fonts = skin?.extras?.fonts || [];
    for (let i = 0; i < fonts.length; i++) {
        const link = document.createElement('link');
        link.id = `${SKIN_EXTRAS_FONT_ID_PREFIX}${i}`;
        link.rel = 'stylesheet';
        link.href = fonts[i];
        document.head.appendChild(link);
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
        // Accent-only skin or custom — fall back to the computed body bg
        // so the address bar tracks whatever the current theme resolves to.
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

export function applyCurrentSkin() {
    if (typeof document === 'undefined') return;
    if (state.skinId === 'custom') {
        const vars = customSkinVars(state.customAccent, buildOverrides(state.semantics));
        if (vars) applyVars(vars);
        applyExtras(null);
        return;
    }
    const skin = SKINS.find((s) => s.id === state.skinId) || SKINS[0];
    applyVars(skin.vars);
    applyExtras(skin);
}

export function setSkin(id: string) {
    state.skinId = id;
    persist(state);
    applyCurrentSkin();
}

export function setCustomAccent(hex: string) {
    state.customAccent = hex;
    state.skinId = 'custom';
    persist(state);
    applyCurrentSkin();
}

export function setSemantic(patch: Partial<SemanticOverrides>) {
    state.semantics = { ...state.semantics, ...patch };
    state.skinId = 'custom';
    persist(state);
    applyCurrentSkin();
}

export function resetSemantics() {
    state.semantics = { ...defaultSemantics };
    state.skinId = 'custom';
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
