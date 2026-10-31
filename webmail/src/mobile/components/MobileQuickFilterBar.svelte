<script lang="ts">
    import Icon from '../../components/Icon.svelte';
    import {
        OUTLOOK_FILTER_MENU,
        OUTLOOK_SORT_MENU,
        outlookFilterLabel,
        listSortLabel,
        type ListSort,
    } from '../../lib/list-quick-filters';
    import {
        settings,
        setListFilter,
        setListSort,
        type ListFilter,
    } from '../../lib/settings.svelte';

    let filterMenuOpen = $state(false);
    let sortMenuOpen = $state(false);

    function pickListFilter(f: ListFilter) {
        setListFilter(f);
        filterMenuOpen = false;
    }

    function pickListSort(s: ListSort) {
        setListSort(s);
        sortMenuOpen = false;
    }

    function toggleAiSort() {
        if (settings.listFilter === 'ai-sorted') {
            setListFilter('all');
        } else {
            setListFilter('ai-sorted');
        }
    }
</script>

<div class="mobile-quick-bar" data-testid="mobile-quick-filter-bar">
    {#if settings.aiFeatures}
        <button
            type="button"
            class="mq-chip"
            class:active={settings.listFilter === 'ai-sorted'}
            aria-pressed={settings.listFilter === 'ai-sorted'}
            data-testid="mobile-ai-sort-chip"
            onclick={toggleAiSort}
        >
            <Icon name="sparkles" size={14} />
            <span>AI sort</span>
        </button>
    {/if}
    <div class="mq-menu-wrap">
        <button
            type="button"
            class="mq-chip"
            class:active={settings.listFilter !== 'all' && settings.listFilter !== 'ai-sorted'}
            aria-haspopup="menu"
            aria-expanded={filterMenuOpen}
            data-testid="mobile-quick-filter-trigger"
            onclick={() => { sortMenuOpen = false; filterMenuOpen = !filterMenuOpen; }}
        >
            <Icon name="filter" size={14} />
            <span>Filter: {outlookFilterLabel(settings.listFilter)}</span>
            <Icon name="chevronDown" size={12} />
        </button>
        {#if filterMenuOpen}
            <ul class="mq-menu-panel" role="menu" data-testid="mobile-quick-filter-menu">
                {#each OUTLOOK_FILTER_MENU as f (f.value)}
                    <li role="none">
                        <button
                            type="button"
                            role="menuitemradio"
                            class:active={settings.listFilter === f.value}
                            aria-checked={settings.listFilter === f.value}
                            data-testid={`mobile-filter-${f.value}`}
                            onclick={() => pickListFilter(f.value)}
                        >{f.label}</button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
    <div class="mq-menu-wrap">
        <button
            type="button"
            class="mq-chip"
            class:active={settings.listSort !== 'date-desc'}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            disabled={settings.listFilter === 'ai-sorted'}
            data-testid="mobile-quick-sort-trigger"
            onclick={() => { filterMenuOpen = false; sortMenuOpen = !sortMenuOpen; }}
        >
            <Icon name="arrowUpDown" size={14} />
            <span>Sort: {listSortLabel(settings.listSort)}</span>
            <Icon name="chevronDown" size={12} />
        </button>
        {#if sortMenuOpen}
            <ul class="mq-menu-panel" role="menu" data-testid="mobile-quick-sort-menu">
                {#each OUTLOOK_SORT_MENU as s (s.value)}
                    <li role="none">
                        <button
                            type="button"
                            role="menuitemradio"
                            class:active={settings.listSort === s.value}
                            aria-checked={settings.listSort === s.value}
                            data-testid={`mobile-sort-${s.value}`}
                            onclick={() => pickListSort(s.value)}
                        >{s.label}</button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</div>

<style>
    .mobile-quick-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 8px 16px 0;
        flex: 0 0 auto;
    }
    .mq-menu-wrap {
        position: relative;
    }
    .mq-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-surface);
        color: var(--text-primary);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        max-width: min(100%, 220px);
    }
    .mq-chip span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .mq-chip:disabled {
        opacity: 0.45;
    }
    .mq-chip.active {
        border-color: color-mix(in srgb, var(--accent) 55%, var(--border-subtle));
        background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface));
        color: var(--accent-text);
    }
    .mq-menu-panel {
        position: absolute;
        z-index: 40;
        top: calc(100% + 4px);
        left: 0;
        min-width: 200px;
        max-height: min(60vh, 320px);
        overflow-y: auto;
        margin: 0;
        padding: 6px;
        list-style: none;
        border-radius: 12px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-elevated, var(--bg-surface));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    }
    .mq-menu-panel button {
        display: block;
        width: 100%;
        text-align: left;
        padding: 10px 12px;
        border: none;
        border-radius: 8px;
        background: transparent;
        font: inherit;
        font-size: 15px;
        color: var(--text-primary);
        cursor: pointer;
    }
    .mq-menu-panel button.active {
        font-weight: 600;
        color: var(--accent-text);
        background: color-mix(in srgb, var(--accent) 10%, transparent);
    }
</style>
