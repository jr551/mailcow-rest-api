<script lang="ts">
    import { mobileState, navigate } from '../lib/store.svelte';
    import Icon from '../../components/Icon.svelte';

    const tabs = [
        { key: 'inbox' as const, label: 'Mail', icon: 'inbox' as const },
        { key: 'folders' as const, label: 'Folders', icon: 'folder' as const },
        { key: 'ai' as const, label: 'AI', icon: 'sparkles' as const },
        { key: 'drive' as const, label: 'Drive', icon: 'drive' as const },
        { key: 'settings' as const, label: 'Settings', icon: 'settings' as const },
    ];
</script>

<nav class="bottom-nav no-select">
    {#each tabs as t}
        <button
            type="button"
            class="nav-item"
            class:active={mobileState.view === t.key}
            onclick={() => navigate(t.key)}
        >
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
        </button>
    {/each}
</nav>
