<script lang="ts">
    import { addDays, format, parseISO, isSameDay } from 'date-fns';
    import { eventsInRange, getCalendar, type CalEvent } from '../../lib/calendar.svelte';

    interface Props {
        cursor: Date;
        /** Lower-cased query from the calendar toolbar. Empty = all. */
        search?: string;
        onOpenEvent: (e: CalEvent) => void;
    }
    let { cursor, search = '', onOpenEvent }: Props = $props();

    // Show 60 days from cursor — typical Google "Schedule" range.
    let events = $derived.by(() => {
        const from = new Date(cursor);
        from.setHours(0, 0, 0, 0);
        const to = addDays(from, 60);
        const list = eventsInRange(from, to);
        const q = search.trim().toLowerCase();
        const byDay: { date: Date; events: CalEvent[] }[] = [];
        for (const e of list) {
            if (q && !matchesQuery(e, q)) continue;
            const d = parseISO(e.start);
            const last = byDay[byDay.length - 1];
            if (last && isSameDay(last.date, d)) last.events.push(e);
            else byDay.push({ date: d, events: [e] });
        }
        return byDay;
    });

    function matchesQuery(e: CalEvent, q: string): boolean {
        return [e.title, e.location, e.description]
            .filter(Boolean)
            .some((s) => (s as string).toLowerCase().includes(q));
    }

    function colorFor(e: CalEvent): string {
        return e.color || getCalendar(e.calendarId)?.color || '#1a73e8';
    }
</script>

<div class="schedule" data-testid="cal-schedule-view">
    {#if events.length === 0}
        <div class="empty">
            <p>No events in the next 60 days. Click <strong>Create</strong> to add one.</p>
        </div>
    {:else}
        <ul class="day-list">
            {#each events as day (day.date.toISOString())}
                <li class="day-block">
                    <div class="day-rail">
                        <div class="dow">{format(day.date, 'EEE')}</div>
                        <div class="dnum">{format(day.date, 'd')}</div>
                        <div class="month-tag">{format(day.date, 'MMM')}</div>
                    </div>
                    <ul class="evts">
                        {#each day.events as e (e.id)}
                            <li>
                                <button
                                    type="button"
                                    class="evt"
                                    onclick={() => onOpenEvent(e)}
                                    data-testid={`cal-schedule-evt-${e.id}`}
                                >
                                    <span class="dot" style={`background: ${colorFor(e)};`}></span>
                                    <span class="time">{e.allDay ? 'All day' : `${format(parseISO(e.start), 'h:mma').toLowerCase()} – ${format(parseISO(e.end), 'h:mma').toLowerCase()}`}</span>
                                    <span class="title truncate">{e.title}</span>
                                    {#if e.location}<span class="loc muted truncate">{e.location}</span>{/if}
                                </button>
                            </li>
                        {/each}
                    </ul>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .schedule { padding: 8px 16px 16px; height: 100%; overflow-y: auto; background: var(--bg-base); }
    .empty { padding: 60px 0; text-align: center; color: var(--text-tertiary); font-size: 13px; }
    .day-list { list-style: none; margin: 0; padding: 0; }
    .day-block {
        display: grid;
        grid-template-columns: 90px 1fr;
        gap: 12px;
        padding: 10px 0;
        border-bottom: 1px solid var(--border-subtle);
    }
    .day-rail { display: flex; flex-direction: column; align-items: flex-start; padding-top: 6px; }
    .dow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); font-weight: 600; }
    .dnum { font-size: 26px; font-weight: 400; color: var(--text-primary); line-height: 1; margin: 2px 0; }
    .month-tag { font-size: 11px; color: var(--text-tertiary); }
    .evts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .evt {
        display: flex; align-items: center; gap: 12px;
        width: 100%;
        padding: 6px 10px;
        background: var(--bg-surface);
        border: 1px solid transparent;
        border-radius: var(--radius-sm);
        font-size: 13px;
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
        transition: background-color var(--transition-fast), border-color var(--transition-fast);
    }
    .evt:hover { background: var(--bg-surface-alt); border-color: var(--border-subtle); }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .time { font-variant-numeric: tabular-nums; color: var(--text-secondary); width: 130px; flex-shrink: 0; }
    .title { font-weight: 500; flex: 1; min-width: 0; }
    .loc { color: var(--text-tertiary); font-size: 12px; max-width: 30%; flex-shrink: 0; }
</style>
