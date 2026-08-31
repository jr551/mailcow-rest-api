<script lang="ts">
    import { format } from 'date-fns';
    import Icon from '../Icon.svelte';

    // Day, Week and Year were listed as tabs but had no implementation —
    // selecting one showed a "coming next push" placeholder. Navigation
    // now exposes only views that render, so the selected tab always
    // corresponds to a usable one.
    export type CalView = 'month' | 'schedule';

    interface Props {
        view: CalView;
        cursor: Date;
        search: string;
        onView: (v: CalView) => void;
        onPrev: () => void;
        onNext: () => void;
        onToday: () => void;
        onSearch: (q: string) => void;
        onCreate: () => void;
    }
    let { view, cursor, search, onView, onPrev, onNext, onToday, onSearch, onCreate }: Props = $props();

    let label = $derived.by(() => {
        if (view === 'month') return format(cursor, 'MMMM yyyy');
        return format(cursor, 'MMMM yyyy');
    });
</script>

<header class="cal-header" data-testid="cal-header">
    <div class="left">
        <button type="button" class="btn btn-secondary today-btn" onclick={onToday} data-testid="cal-today">Today</button>
        <button type="button" class="icon-btn" onclick={onPrev} aria-label="Previous" data-testid="cal-prev">
            <Icon name="chevronLeft" size={18} />
        </button>
        <button type="button" class="icon-btn" onclick={onNext} aria-label="Next" data-testid="cal-next">
            <Icon name="chevronRight" size={18} />
        </button>
        <span class="period" data-testid="cal-period">{label}</span>
    </div>

    <div class="middle">
        <div class="search">
            <Icon name="search" size={14} />
            <input
                type="search"
                placeholder="Search events"
                value={search}
                oninput={(e) => onSearch((e.currentTarget as HTMLInputElement).value)}
                data-testid="cal-search"
            />
        </div>
    </div>

    <div class="right">
        <div class="view-switcher" role="tablist" aria-label="Calendar views">
            {#each [['month','Month','1'],['schedule','Schedule','2']] as [v,l,k] (v)}
                <button
                    type="button"
                    role="tab"
                    class="view-tab"
                    class:active={view === v}
                    aria-selected={view === v}
                    onclick={() => onView(v as CalView)}
                    title={`${l} (${k})`}
                    data-testid={`cal-view-${v}`}
                >{l}</button>
            {/each}
        </div>
        <button type="button" class="btn btn-primary create-btn" onclick={onCreate} data-testid="cal-create">
            <Icon name="plus" size={14} />
            <span>Create</span>
        </button>
    </div>
</header>

<style>
    .cal-header {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 16px;
        padding: 10px 16px;
        border-bottom: 1px solid var(--border-subtle);
        background: var(--bg-surface);
    }
    .left, .right { display: flex; align-items: center; gap: 8px; }
    .right { justify-content: flex-end; }
    .today-btn { padding: 5px 12px; font-size: 12.5px; border-radius: var(--radius-sm); }
    .icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; border-radius: 50%;
        color: var(--text-secondary);
    }
    .icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
    .period { font-size: 17px; font-weight: 500; color: var(--text-primary); margin-left: 6px; letter-spacing: -0.005em; }

    .middle { display: flex; justify-content: center; }
    .search {
        position: relative;
        display: flex; align-items: center; gap: 6px;
        background: var(--bg-surface-alt);
        border: 1px solid transparent;
        border-radius: 999px;
        padding: 6px 12px 6px 12px;
        width: 360px;
        max-width: 50vw;
        transition: background-color var(--transition-fast), border-color var(--transition-fast);
    }
    .search:focus-within { background: var(--bg-surface); border-color: var(--border-subtle); }
    .search input {
        flex: 1;
        background: transparent;
        border: 0;
        font-size: 13px;
        color: var(--text-primary);
        outline: none;
    }
    .view-switcher {
        display: inline-flex;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        padding: 2px;
    }
    .view-tab {
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
        border-radius: 999px;
        transition: background-color var(--transition-fast), color var(--transition-fast);
    }
    .view-tab:hover { color: var(--text-primary); }
    .view-tab.active { background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-sm); font-weight: 600; }
    .create-btn { padding: 7px 14px; font-size: 12.5px; border-radius: 999px; gap: 4px; }
</style>
