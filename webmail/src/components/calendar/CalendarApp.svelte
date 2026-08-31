<script lang="ts">
    import { onMount } from 'svelte';
    import { addDays, addMonths, parseISO } from 'date-fns';
    import CalendarHeader, { type CalView } from './CalendarHeader.svelte';
    import CalendarSidebar from './CalendarSidebar.svelte';
    import MonthView from './MonthView.svelte';
    import ScheduleView from './ScheduleView.svelte';
    import EventModal from './EventModal.svelte';
    import { loadCalendar, type CalEvent, calendarStore } from '../../lib/calendar.svelte';

    let view = $state<CalView>('month');
    let cursor = $state<Date>(new Date());
    let search = $state('');
    let modalOpen = $state(false);
    let editing = $state<CalEvent | null>(null);
    let createDefault = $state<Date | null>(null);

    onMount(() => { loadCalendar(); });

    function go(direction: 1 | -1) {
        if (view === 'month') cursor = addMonths(cursor, direction);
        else cursor = addDays(cursor, 30 * direction); // schedule = 60-day window
    }

    function openCreate(d?: Date) {
        editing = null;
        createDefault = d ?? null;
        modalOpen = true;
    }
    function openEdit(e: CalEvent) {
        // The event id may carry an "@yyyymmdd" suffix when it was expanded
        // from a recurring rule — strip it to find the base event.
        const baseId = e.id.split('@')[0];
        const base = calendarStore.events.find((ev) => ev.id === baseId) ?? e;
        editing = base;
        modalOpen = true;
    }
    function closeModal() {
        modalOpen = false; editing = null; createDefault = null;
    }

    function onKeydown(e: KeyboardEvent) {
        // Skip when typing into form fields.
        const t = e.target as HTMLElement;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
        if (modalOpen) return;
        if (e.key === '1') view = 'month';
        else if (e.key === '2') view = 'schedule';
        else if (e.key === 't' || e.key === 'T') cursor = new Date();
        else if (e.key === 'c') openCreate();
    }

    let searchQuery = $derived(search.trim().toLowerCase());
</script>

<svelte:window onkeydown={onKeydown} />

<div class="cal-app" data-testid="cal-app">
    <CalendarHeader
        {view}
        {cursor}
        {search}
        onView={(v) => (view = v)}
        onPrev={() => go(-1)}
        onNext={() => go(1)}
        onToday={() => (cursor = new Date())}
        onSearch={(q) => (search = q)}
        onCreate={() => openCreate()}
    />
    <div class="body">
        <CalendarSidebar
            {cursor}
            selected={cursor}
            onSelect={(d) => (cursor = d)}
            onCreate={() => openCreate()}
        />
        <div class="main">
            {#if view === 'month'}
                <MonthView {cursor} search={searchQuery} onCreateOn={(d) => openCreate(d)} onOpenEvent={openEdit} />
            {:else}
                <ScheduleView {cursor} search={searchQuery} onOpenEvent={openEdit} />
            {/if}
        </div>
    </div>

    {#if modalOpen}
        <EventModal
            event={editing}
            defaultDate={createDefault}
            onClose={closeModal}
        />
    {/if}
</div>

<style>
    .cal-app { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; background: var(--bg-base); }
    .body { display: flex; flex: 1; min-height: 0; }
    .main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
</style>
