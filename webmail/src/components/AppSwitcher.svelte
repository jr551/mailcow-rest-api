<script lang="ts">
    // Thin left rail that flips the top-level surface between Mail,
    // Calendar, AI and Drive. Sits flush against the existing sidebar.
    import { ui } from '../lib/store.svelte';
    import { recordView } from '../lib/recent-views.svelte';
    import { settings } from '../lib/settings.svelte';
    import Icon from './Icon.svelte';

    function go(app: 'mail' | 'calendar' | 'ai' | 'drive', title: string) {
        if (ui.app === app) return;
        ui.app = app;
        if (app === 'calendar') recordView({ kind: 'calendar', title });
        else if (app === 'drive') recordView({ kind: 'drive', title });
        else if (app === 'ai') recordView({ kind: 'ai-thread', title });
        // Mail switches are tracked through the folder selection elsewhere.
    }
</script>

<!-- id is the target of the topbar toggle's aria-controls. -->
<div class="rail" id="app-switcher" data-testid="app-switcher" aria-label="App switcher">
    <button
        type="button"
        class="rail-btn"
        class:active={ui.app === 'mail'}
        title="Mail (m)"
        aria-pressed={ui.app === 'mail'}
        onclick={() => go('mail', 'Mail')}
        data-testid="app-switch-mail"
    >
        <Icon name="mail" size={20} />
        <span class="label">Mail</span>
    </button>
    <button
        type="button"
        class="rail-btn"
        class:active={ui.app === 'calendar'}
        title="Calendar"
        aria-pressed={ui.app === 'calendar'}
        onclick={() => go('calendar', 'Calendar')}
        data-testid="app-switch-calendar"
    >
        <Icon name="calendar" size={20} />
        <span class="label">Calendar</span>
    </button>
        <!-- Hidden entirely when AI is hard-off — the rail is a flex column,
             so removing the node leaves no dead space (unlike the panel
             ghosting). -->
        {#if settings.aiFeatures}
            <button
                type="button"
                class="rail-btn"
                class:active={ui.app === 'ai'}
                title="AI"
                aria-pressed={ui.app === 'ai'}
                onclick={() => go('ai', 'AI chat')}
                data-testid="app-switch-ai"
            >
                <Icon name="sparkles" size={20} />
                <span class="label">AI</span>
            </button>
        {/if}
    <button
        type="button"
        class="rail-btn"
        class:active={ui.app === 'drive'}
        title="Drive (d)"
        aria-pressed={ui.app === 'drive'}
        onclick={() => go('drive', 'Drive')}
        data-testid="app-switch-drive"
    >
        <Icon name="drive" size={20} />
        <span class="label">Drive</span>
    </button>
</div>

<svelte:window
    onkeydown={(e) => {
        const t = e.target as HTMLElement;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
        // CONTENTEDITABLE TOO. The compose body is a TipTap surface
        // (contenteditable), so without this any word containing "d" or "m"
        // — i.e. almost every sentence — switched the app to Drive or Mail
        // while the user was mid-typing. The keyup/keypress would then land
        // wherever the app went, which is how the character was lost.
        if (t && t.isContentEditable) return;
        if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey) ui.app = 'mail';
        if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey) ui.app = 'drive';
    }}
/>

<style>
    .rail {
        flex: 0 0 64px;
        max-width: 64px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 12px 6px;
        background: var(--bg-surface);
        border-right: 1px solid var(--border-subtle);
    }
    .rail-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 8px 4px;
        font-size: 10px;
        font-weight: 500;
        color: var(--text-tertiary);
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .rail-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    .rail-btn.active { background: var(--accent-soft); color: var(--accent-text); }
    .label { font-size: 10px; }
    @media (max-width: 600px) {
        .rail { flex-basis: 48px; max-width: 48px; padding: 8px 4px; }
        .label { display: none; }
    }
</style>
