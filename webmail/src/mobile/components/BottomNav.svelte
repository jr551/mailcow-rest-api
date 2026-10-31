<script lang="ts">
    import { mobileState, navigate } from '../lib/store.svelte';
    import Icon from '../../components/Icon.svelte';
    import { settings } from '../../lib/settings.svelte';
    import { MOBILE_APP_NAV_LABEL } from '../../lib/mobile-mail-landmarks';

    // The AI tab is dropped from the list entirely when AI is hard-off.
    // The nav is a flex row, so removing the item re-flows the remaining
    // tabs to fill the width — no dead slot left behind.
    const tabs = [
        { key: 'inbox' as const, label: 'Mail', icon: 'inbox' as const },
        { key: 'folders' as const, label: 'Folders', icon: 'folder' as const },
        { key: 'ai' as const, label: 'AI', icon: 'sparkles' as const },
        { key: 'drive' as const, label: 'Drive', icon: 'drive' as const },
        { key: 'settings' as const, label: 'Settings', icon: 'settings' as const },
    ];
    const visibleTabs = $derived(tabs.filter((t) => t.key !== 'ai' || settings.aiFeatures));
</script>

<nav class="bottom-nav no-select" aria-label={MOBILE_APP_NAV_LABEL}>
    {#each visibleTabs as t (t.key)}
        <button
            type="button"
            class="nav-item"
            class:active={mobileState.view === t.key}
            aria-current={mobileState.view === t.key ? 'page' : undefined}
            onclick={() => navigate(t.key)}
        >
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
        </button>
    {/each}
</nav>
