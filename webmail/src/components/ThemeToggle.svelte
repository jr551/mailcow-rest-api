<script lang="ts">
    import { themeState, setTheme, nextTheme } from '../lib/theme.svelte';
    import Icon from './Icon.svelte';

    function cycle() {
        setTheme(nextTheme(themeState.theme));
    }

    const labels = { auto: 'Auto', light: 'Light', dark: 'Dark' } as const;
    const icon = $derived(themeState.theme === 'dark' ? 'moon' : themeState.theme === 'light' ? 'sun' : 'monitor');
</script>

<button
    type="button"
    class="theme-toggle"
    title={`Theme: ${labels[themeState.theme]} (click to cycle)`}
    aria-label={`Switch theme (currently ${labels[themeState.theme]})`}
    onclick={cycle}
>
    <Icon name={icon} size={16} />
    <span class="hidden-on-narrow">{labels[themeState.theme]}</span>
</button>

<style>
    .theme-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .theme-toggle:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    @media (max-width: 720px) {
        .hidden-on-narrow { display: none; }
    }
</style>
