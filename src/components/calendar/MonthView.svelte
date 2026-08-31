<script lang="ts">
    import {
        startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
        isSameDay, isSameMonth, format, parseISO
    } from 'date-fns';
    import { eventsInRange, getCalendar, type CalEvent } from '../../lib/calendar.svelte';

    interface Props {
        cursor: Date;
        /** Lower-cased search query from the toolbar. Empty = show all. */
        search?: string;
        onCreateOn: (d: Date) => void;
        onOpenEvent: (e: CalEvent) => void;
    }
    let { cursor, search = '', onCreateOn, onOpenEvent }: Props = $props();

    let weeks = $derived.by(() => {
        const first = startOfMonth(cursor);
        const last = endOfMonth(cursor);
        const gridStart = startOfWeek(first, { weekStartsOn: 0 });
        const gridEnd = endOfWeek(last, { weekStartsOn: 0 });
        const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
        const out: Date[][] = [];
        for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
        return out;
    });

    let monthEvents = $derived.by(() => {
        if (!weeks.length) return new Map<string, CalEvent[]>();
        const start = weeks[0][0];
        const end = weeks[weeks.length - 1][6];
        end.setHours(23, 59, 59, 999);
        const all = eventsInRange(start, end);
        const q = search.trim().toLowerCase();
        const byDay = new Map<string, CalEvent[]>();
        for (const e of all) {
            if (q && !matchesQuery(e, q)) continue;
            const key = format(parseISO(e.start), 'yyyy-MM-dd');
            if (!byDay.has(key)) byDay.set(key, []);
            byDay.get(key)!.push(e);
        }
        return byDay;
    });

    function matchesQuery(e: CalEvent, q: string): boolean {
        return [e.title, e.location, e.description]
            .filter(Boolean)
            .some((s) => (s as string).toLowerCase().includes(q));
    }

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let today = new Date();

    function colorFor(e: CalEvent): string {
        return e.color || getCalendar(e.calendarId)?.color || '#1a73e8';
    }
</script>

<div class="month" data-testid="cal-month-view">
    <div class="dow-row">
        {#each dayLabels as l (l)}
            <span class="dow">{l}</span>
        {/each}
    </div>
    <div class="grid">
        {#each weeks as week, wi (wi)}
            {#each week as d (d.toISOString())}
                {@const key = format(d, 'yyyy-MM-dd')}
                {@const dayEvents = monthEvents.get(key) || []}
                <div
                    class="cell"
                    class:other={!isSameMonth(d, cursor)}
                    role="button"
                    tabindex="0"
                    onclick={() => onCreateOn(d)}
                    onkeydown={(e) => { if (e.key === 'Enter') onCreateOn(d); }}
                    data-testid={`cal-cell-${key}`}
                >
                    <div class="cell-head">
                        <span class={`dnum ${isSameDay(d, today) ? 'today' : ''}`}>{d.getDate()}</span>
                    </div>
                    <ul class="ev-list">
                        {#each dayEvents.slice(0, 3) as e (e.id)}
                            <li>
                                <button
                                    type="button"
                                    class="evt"
                                    style={`background: ${colorFor(e)};`}
                                    onclick={(ev) => { ev.stopPropagation(); onOpenEvent(e); }}
                                    data-testid={`cal-evt-${e.id}`}
                                >
                                    <span class="evt-time">{e.allDay ? '' : format(parseISO(e.start), 'h:mma').toLowerCase()}</span>
                                    <span class="evt-title truncate">{e.title}</span>
                                </button>
                            </li>
                        {/each}
                        {#if dayEvents.length > 3}
                            <li class="more">+{dayEvents.length - 3} more</li>
                        {/if}
                    </ul>
                </div>
            {/each}
        {/each}
    </div>
</div>

<style>
    .month { display: flex; flex-direction: column; height: 100%; background: var(--bg-base); }
    .dow-row {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        border-bottom: 1px solid var(--border-subtle);
    }
    .dow {
        text-align: center;
        padding: 8px 0;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        border-right: 1px solid var(--border-subtle);
    }
    .dow:last-child { border-right: 0; }
    .grid {
        flex: 1;
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        grid-auto-rows: minmax(110px, 1fr);
    }
    .cell {
        position: relative;
        border-right: 1px solid var(--border-subtle);
        border-bottom: 1px solid var(--border-subtle);
        padding: 4px 4px 6px;
        min-width: 0;
        background: var(--bg-base);
        cursor: pointer;
        transition: background-color var(--transition-fast);
    }
    .cell:hover { background: var(--bg-surface-alt); }
    .cell.other { background: var(--bg-surface-alt); }
    .cell.other .dnum { color: var(--text-tertiary); }
    .cell:nth-child(7n) { border-right: 0; }
    .cell-head { display: flex; justify-content: center; }
    .dnum {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 22px; height: 22px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
        margin-top: 2px;
        padding: 0 6px;
    }
    .dnum.today {
        background: var(--accent);
        color: var(--accent-on);
        border-radius: 999px;
        font-weight: 700;
    }

    .ev-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .evt {
        display: flex;
        align-items: center;
        gap: 5px;
        width: 100%;
        padding: 2px 6px;
        font-size: 11px;
        color: #fff;
        border-radius: 3px;
        text-align: left;
        cursor: pointer;
    }
    .evt-time { font-weight: 600; opacity: 0.95; flex-shrink: 0; }
    .evt-title { font-weight: 500; }
    .more {
        font-size: 10.5px;
        color: var(--text-tertiary);
        padding: 2px 6px;
        font-weight: 500;
    }
</style>
