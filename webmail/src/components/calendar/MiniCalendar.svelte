<script lang="ts">
    import {
        startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
        format, isSameMonth, isSameDay, addMonths
    } from 'date-fns';
    import Icon from '../Icon.svelte';

    interface Props {
        cursor: Date;
        selected: Date;
        onSelect: (d: Date) => void;
    }
    let { cursor, selected, onSelect }: Props = $props();

    let viewMonth = $state(new Date(cursor));
    $effect(() => { viewMonth = new Date(cursor); });

    let weeks = $derived.by(() => {
        const first = startOfMonth(viewMonth);
        const last = endOfMonth(viewMonth);
        const gridStart = startOfWeek(first, { weekStartsOn: 0 });
        const gridEnd = endOfWeek(last, { weekStartsOn: 0 });
        const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
        const out: Date[][] = [];
        for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
        return out;
    });
    const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    let today = new Date();
</script>

<div class="mini-cal" data-testid="mini-cal">
    <header class="mini-head">
        <span class="title">{format(viewMonth, 'MMMM yyyy')}</span>
        <div class="nav">
            <button type="button" class="icon-btn" onclick={() => (viewMonth = addMonths(viewMonth, -1))} aria-label="Previous month">
                <Icon name="chevronLeft" size={14} />
            </button>
            <button type="button" class="icon-btn" onclick={() => (viewMonth = addMonths(viewMonth, 1))} aria-label="Next month">
                <Icon name="chevronRight" size={14} />
            </button>
        </div>
    </header>
    <div class="grid">
        {#each dayLabels as l, i (i)}
            <span class="dow">{l}</span>
        {/each}
        {#each weeks as week, wi (wi)}
            {#each week as d (d.toISOString())}
                <button
                    type="button"
                    class="day"
                    class:other={!isSameMonth(d, viewMonth)}
                    class:selected={isSameDay(d, selected)}
                    class:today={isSameDay(d, today)}
                    onclick={() => onSelect(d)}
                >{d.getDate()}</button>
            {/each}
        {/each}
    </div>
</div>

<style>
    .mini-cal {
        font-size: 11px;
        color: var(--text-secondary);
    }
    .mini-head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 0 4px 6px;
    }
    .title { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
    .nav { display: inline-flex; gap: 2px; }
    .icon-btn {
        width: 22px; height: 22px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 50%;
        color: var(--text-tertiary);
    }
    .icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

    .grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 1px;
    }
    .dow {
        text-align: center;
        font-size: 10px;
        font-weight: 600;
        color: var(--text-tertiary);
        padding: 2px 0;
    }
    .day {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px;
        border-radius: 50%;
        font-size: 11.5px;
        color: var(--text-secondary);
        margin: 0 auto;
    }
    .day:hover { background: var(--bg-hover); color: var(--text-primary); }
    .day.other { color: var(--text-tertiary); opacity: 0.6; }
    .day.today {
        color: var(--accent-text);
        font-weight: 700;
    }
    .day.selected {
        background: var(--accent);
        color: var(--accent-on);
        font-weight: 600;
    }
    .day.today.selected { color: var(--accent-on); }
</style>
