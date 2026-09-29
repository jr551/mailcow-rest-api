<script lang="ts">
    // The topbar appearance control: a light/dark/auto mode switch AND a
    // palette of accents, in one popover.
    //
    // It used to be a bare button that cycled the mode on click, which
    // satisfied "does the app have a dark mode" and nothing else — you
    // could reach dark but there was no way to pick an accent from the
    // topbar at all, and Settings buried the one colour input behind four
    // navigation steps. Requirement: both capabilities in one control, with
    // neither lost.
    //
    // The popover follows the convention the rest of the topbar already
    // uses (see WeatherChip / Layout's account menu): a plain absolutely
    // positioned panel, an mousedown listener on document to dismiss, and
    // Escape to close. The one thing it borrows from the modal layer is
    // trapFocus, because a popover that the user can Tab straight out of
    // while it is still visually open is a keyboard trap in the other
    // direction — worse than no trap, because focus lands somewhere
    // unrelated and the panel is still on screen.

    import { onDestroy } from 'svelte';
    import { themeState, setTheme, effectiveTheme, type Theme } from '../lib/theme.svelte';
    import { skinState, setCustomAccent, SKINS } from '../lib/skins.svelte';
    import { ACCENT_SWATCHES, defaultSwatchFor } from '../lib/accents';
    import { trapFocus } from '../lib/focus-trap';
    import Icon from './Icon.svelte';
    import type { IconName } from '../lib/icons';

    // `as const` (not a cast to IconName) so the literal union survives: a
    // plain `icon: string` here widens to string and Icon's `name` prop —
    // which is a union of the real registry keys — rejects it. Typing it as
    // the domain union keeps the compiler checking that these icon names
    // actually exist, and keeps renaming a registry key a compile error here
    // rather than a blank box at runtime.
    const MODES = [
        { value: 'auto',  label: 'Auto',  icon: 'monitor' },
        { value: 'light', label: 'Light', icon: 'sun' },
        { value: 'dark',  label: 'Dark',  icon: 'moon' }
    ] as const satisfies readonly { value: Theme; label: string; icon: IconName }[];

    const labels: Record<Theme, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };

    let open = $state(false);
    let panelEl: HTMLDivElement | undefined = $state();
    let triggerEl: HTMLButtonElement | undefined = $state();
    let stopTrap: (() => void) | undefined;

    const activeSkin = $derived(SKINS.find((s) => s.id === skinState.skinId) ?? null);
    const defaultSwatch = $derived(activeSkin ? defaultSwatchFor(activeSkin.id) : null);

    // The icon shows the user's CHOICE, not the resolved mode, so that
    // picking "Auto" is visibly still Auto rather than silently displaying
    // whichever mode the OS happens to be in. The trigger's title and
    // accessible name spell out the resolved mode as well, because under Auto
    // the icon alone is ambiguous about what is actually on screen.
    const icon = $derived(themeState.theme === 'dark' ? 'moon' : themeState.theme === 'light' ? 'sun' : 'monitor');
    const resolved = $derived(effectiveTheme());

    const accentName = $derived(
        ACCENT_SWATCHES.find((s) => s.hex.toLowerCase() === (skinState.accentOverride ?? '').toLowerCase())?.label
    );

    const triggerLabel = $derived(
        `Appearance — ${labels[themeState.theme]} mode`
        + ` (showing ${labels[resolved]}),`
        + ` accent ${accentName ?? (skinState.accentOverride ? skinState.accentOverride : `${activeSkin?.label ?? 'skin'} default`)}`
    );

    function openPanel() {
        if (open) return;
        open = true;
        // The panel is conditionally rendered, so bind:this only lands after
        // the next flush — hence the microtask before arming the trap.
        queueMicrotask(() => {
            if (panelEl) stopTrap = trapFocus(panelEl);
        });
    }

    function closePanel(returnFocus = true) {
        if (!open) return;
        open = false;
        stopTrap?.();
        stopTrap = undefined;
        // Escape and the scrim-click both dismiss; in both cases the user's
        // focus is somewhere that is about to disappear, so hand it back to
        // the trigger rather than letting it fall to <body>.
        if (returnFocus) triggerEl?.focus();
    }

    function toggle() {
        if (open) closePanel(false);
        else openPanel();
    }

    function pick(hex: string) {
        setCustomAccent(hex);
    }

    function resetAccent() {
        setCustomAccent(null);
    }

    /**
     * Roving arrow-key navigation for a radiogroup, per the WAI-ARIA
     * authoring practices. The roving tabindex is only half the pattern —
     * without the arrows, "exactly one swatch is in the tab order" leaves a
     * keyboard user unable to reach the other thirteen at all, since Tab
     * would step straight past them. Selection follows focus, as the pattern
     * requires, so arrowing through previews the accent live.
     *
     * Radios only respond to the axis they are laid out on, and the swatch
     * grid is 5 columns wide, so Up/Down move by a full row.
     */
    function onRadioKey(e: KeyboardEvent, group: 'mode' | 'accent') {
        const horizontal = group === 'mode';
        const keys: Record<string, number> = horizontal
            ? { ArrowRight: 1, ArrowLeft: -1 }
            : { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 5, ArrowUp: -5 };
        const step = keys[e.key];
        if (!step) return;
        e.preventDefault();

        const current = e.currentTarget as HTMLElement;
        const group_ = current.closest('[role="radiogroup"]');
        if (!group_) return;
        const items = Array.from(group_.querySelectorAll<HTMLElement>('[role="radio"]'));
        const at = items.indexOf(current);
        if (at === -1) return;
        // Wrap, so arrowing off either end is not a dead end.
        const next = items[(at + step + items.length) % items.length];
        next.focus();
        next.click();
    }

    onDestroy(() => stopTrap?.());
</script>

<div class="theme-toggle-host">
    <button
        type="button"
        class="theme-toggle"
        bind:this={triggerEl}
        title={triggerLabel}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="theme-toggle"
        onclick={toggle}
    >
        <Icon name={icon} size={16} />
        <span class="hidden-on-narrow">{labels[themeState.theme]}</span>
    </button>

    {#if open}
        <!-- The scrim is decorative: it makes the click-outside target a real
             element instead of a document listener, and it is not in the tab
             order, so it cannot become a focus trap of its own. -->
        <div class="appearance-scrim" onclick={() => closePanel(false)} aria-hidden="true"></div>

        <div
            class="appearance-panel"
            bind:this={panelEl}
            role="dialog"
            aria-label="Appearance"
            data-testid="appearance-panel"
            onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } }}
        >
            <div class="panel-head">
                <span class="panel-title" id="appearance-title">Appearance</span>
                <button
                    type="button"
                    class="panel-close"
                    aria-label="Close appearance"
                    onclick={() => closePanel()}
                >
                    <Icon name="close" size={13} />
                </button>
            </div>

            <section class="panel-section" aria-labelledby="appearance-mode-label">
                <h3 class="section-label" id="appearance-mode-label">Mode</h3>
                <!-- A radiogroup rather than three buttons: one of the three is
                     always true, and a screen reader should say so instead of
                     announcing three unrelated toggles. -->
                <div class="mode-switch" role="radiogroup" aria-label="Colour mode">
                    {#each MODES as m (m.value)}
                        <button
                            type="button"
                            role="radio"
                            class="mode-btn"
                            class:active={themeState.theme === m.value}
                            aria-checked={themeState.theme === m.value}
                            tabindex={themeState.theme === m.value ? 0 : -1}
                            data-testid={`appearance-mode-${m.value}`}
                            onkeydown={(e) => onRadioKey(e, 'mode')}
                            onclick={() => setTheme(m.value)}
                        >
                            <Icon name={m.icon} size={13} />
                            <span>{m.label}</span>
                        </button>
                    {/each}
                </div>
            </section>

            <section class="panel-section" aria-labelledby="appearance-accent-label">
                <h3 class="section-label" id="appearance-accent-label">
                    Accent
                    {#if activeSkin}
                        <!-- Spelled out because the same hex means different
                             things over Outlook and Gmail: the layer re-derives
                             over whatever skin is live, and a user who retints
                             Outlook then switches skin should be able to predict
                             what they are about to see. -->
                        <span class="section-note">over {activeSkin.label}</span>
                    {/if}
                </h3>

                <div class="swatches" role="radiogroup" aria-label={`Accent colour${activeSkin ? ` over the ${activeSkin.label} skin` : ''}`}>
                    <!-- Roving tabindex. The `i === 0` fallback below matters:
                         with no override layered, NO swatch is selected, so a
                         naive `selected ? 0 : -1` would leave the entire row
                         out of the tab order and a keyboard user could never
                         reach the accents at all. -->
                    {#each ACCENT_SWATCHES as s, i (s.id)}
                        {@const selected = (skinState.accentOverride ?? '').toLowerCase() === s.hex.toLowerCase()}
                        <button
                            type="button"
                            role="radio"
                            class="swatch"
                            class:selected
                            aria-checked={selected}
                            tabindex={selected || (skinState.accentOverride === null && i === 0) ? 0 : -1}
                            title={s.label}
                            data-testid={`accent-${s.id}`}
                            onkeydown={(e) => onRadioKey(e, 'accent')}
                            onclick={() => pick(s.hex)}
                        >
                            <span class="swatch-chip" style={`background:${s.hex}`} aria-hidden="true"></span>
                            <span class="swatch-name" aria-hidden="true">{s.label}</span>
                            <span class="sr-only">
                                {s.label}{s.isDefaultFor ? `, the ${activeSkin?.label ?? ''} default` : ''}
                            </span>
                        </button>
                    {/each}
                </div>

                {#if defaultSwatch}
                    <button
                        type="button"
                        class="reset-btn"
                        data-testid="appearance-accent-reset"
                        disabled={skinState.accentOverride === null}
                        onclick={resetAccent}
                    >
                        <Icon name="refresh" size={12} />
                        <span>
                            {skinState.accentOverride === null
                                ? `Using the ${activeSkin?.label ?? 'skin'} default`
                                : `Back to ${activeSkin?.label ?? 'skin'} default`}
                        </span>
                    </button>
                {/if}
            </section>
        </div>
    {/if}
</div>

<style>
    /* The panel is absolutely placed against this component's own wrapper.
     * Scoped (not :global) because the wrapper lives inside the component —
     * Svelte hashes both, and the panel can then never be orphaned from its
     * anchor the way a viewport-anchored one would be in a flex topbar. */
    .theme-toggle-host { position: relative; display: inline-flex; }
    .theme-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .theme-toggle:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* The scrim covers the viewport and sits under the panel, so a click
     * anywhere else dismisses without a document listener. It must not eat
     * clicks meant for the panel, hence the panel's higher z-index. */
    .appearance-scrim {
        position: fixed;
        inset: 0;
        z-index: 80;
    }
    .appearance-panel {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        z-index: 81;
        width: 268px;
        padding: 10px;
        /* Mixed the same way Layout's account menu mixes, for the same
         * reason: pure white on the off-white app bg reads as a glow. */
        background: color-mix(in srgb, var(--bg-elevated) 92%, var(--bg-base));
        border: 1px solid var(--border-soft);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        animation: fade-in 140ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
    }
    .panel-title {
        margin: 0;
        font-size: 12.5px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--text-primary);
    }
    .panel-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: var(--radius-xs);
        color: var(--text-tertiary);
    }
    .panel-close:hover { background: var(--bg-hover); color: var(--text-primary); }

    .panel-section + .panel-section {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--border-subtle);
    }
    .section-label {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin: 0 0 6px;
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
    }
    .section-note {
        font-size: 10.5px;
        font-weight: 500;
        text-transform: none;
        letter-spacing: 0;
        color: var(--accent-text);
    }

    .mode-switch {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 3px;
        padding: 3px;
        background: var(--bg-surface-alt);
        border-radius: var(--radius-sm);
    }
    .mode-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 6px 4px;
        border-radius: var(--radius-xs);
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .mode-btn:hover { color: var(--text-primary); }
    .mode-btn.active {
        background: var(--bg-elevated);
        color: var(--accent-text);
        font-weight: 600;
        box-shadow: var(--shadow-sm);
    }

    .swatches {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 4px;
    }
    .swatch {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 5px 2px;
        border-radius: var(--radius-sm);
        border: 1px solid transparent;
        transition: border-color var(--transition-fast), background-color var(--transition-fast);
    }
    .swatch:hover { background: var(--bg-hover); }
    .swatch.selected {
        border-color: var(--accent);
        background: var(--accent-soft);
    }
    .swatch-chip {
        display: block;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        /* The inner hairline is what keeps a swatch distinguishable from the
         * panel it sits on in DARK mode, where several of the lifted
         * accents are only ~3:1 against the surface. The selected ring is
         * drawn by the button above, not here, so the two states compose. */
        box-shadow: inset 0 0 0 1px var(--bg-elevated), 0 0 0 1px var(--border-subtle);
    }
    .swatch.selected .swatch-chip { box-shadow: inset 0 0 0 1px var(--bg-elevated), 0 0 0 2px var(--text-on-accent); }
    .swatch-name {
        font-size: 8.5px;
        line-height: 1.1;
        text-align: center;
        color: var(--text-tertiary);
    }
    .swatch.selected .swatch-name { color: var(--accent-text); font-weight: 600; }

    .reset-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 8px;
        padding: 6px 8px;
        width: 100%;
        border-radius: var(--radius-sm);
        font-size: 11.5px;
        font-weight: 500;
        color: var(--text-secondary);
        border: 1px solid var(--border-subtle);
    }
    .reset-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .reset-btn:disabled { opacity: 0.55; cursor: default; }

    /* Visually hidden, still announced. The swatch names are rendered
     * aria-hidden on purpose so the button's own name is one clean string
     * rather than the chip's colour and the label read as two things. */
    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
    }

    @media (max-width: 720px) {
        .hidden-on-narrow { display: none; }
    }
</style>
