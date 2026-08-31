<script lang="ts">
    import { onMount } from 'svelte';
    import Icon from '../Icon.svelte';
    import { trapFocus } from '../../lib/focus-trap';
    import { showToast } from '../../lib/store.svelte';
    import {
        addEvent, updateEvent, deleteEvent, calendarStore, resolveDefaultCalendarId, getCalendar,
        EVENT_COLORS, type CalEvent, type Recurrence
    } from '../../lib/calendar.svelte';
    import { format, parseISO } from 'date-fns';

    interface Props {
        // null → create mode; an event → edit mode.
        event: CalEvent | null;
        // Optional default day for create mode.
        defaultDate?: Date | null;
        // Optional partial seed (e.g. AI-suggested) used to prefill create mode.
        seed?: Partial<CalEvent> | null;
        onClose: () => void;
        onSaved?: (e: CalEvent) => void;
    }
    let { event, defaultDate = null, seed = null, onClose, onSaved }: Props = $props();

    function defaultStart(): { date: string; time: string } {
        const d = defaultDate ?? new Date();
        const now = new Date();
        // Default to next half-hour slot today, or 9:00 if a different day.
        const target = new Date(d);
        if (defaultDate && d.toDateString() !== now.toDateString()) {
            target.setHours(9, 0, 0, 0);
        } else {
            target.setMinutes(target.getMinutes() < 30 ? 30 : 60, 0, 0);
            target.setSeconds(0, 0);
        }
        return { date: format(target, 'yyyy-MM-dd'), time: format(target, 'HH:mm') };
    }
    function defaultEnd(startDateStr: string, startTimeStr: string): { date: string; time: string } {
        const dt = parseISO(`${startDateStr}T${startTimeStr}:00`);
        const end = new Date(dt.getTime() + 30 * 60000);
        return { date: format(end, 'yyyy-MM-dd'), time: format(end, 'HH:mm') };
    }

    const initialDates = defaultStart();
    const endDefaults = defaultEnd(initialDates.date, initialDates.time);

    function fmtDate(iso: string | undefined, fallback: string): string {
        if (!iso) return fallback;
        try { return format(parseISO(iso), 'yyyy-MM-dd'); } catch { return fallback; }
    }
    function fmtTime(iso: string | undefined, fallback: string): string {
        if (!iso) return fallback;
        try { return format(parseISO(iso), 'HH:mm'); } catch { return fallback; }
    }

    // event > seed > defaults
    const src = event ?? seed ?? null;

    let title = $state(src?.title ?? '');
    let location = $state(src?.location ?? '');
    let description = $state(src?.description ?? '');
    let startDate = $state(fmtDate(src?.start, initialDates.date));
    let startTime = $state(fmtTime(src?.start, initialDates.time));
    let endDate = $state(fmtDate(src?.end, endDefaults.date));
    let endTime = $state(fmtTime(src?.end, endDefaults.time));
    let allDay = $state(!!src?.allDay);
    let calendarId = $state(
        src?.calendarId ?? resolveDefaultCalendarId()
    );
    let color = $state<string | undefined>(src?.color);
    let recurrence = $state<Recurrence>(src?.recurrence ?? 'none');
    let saving = $state(false);

    const readOnly = $derived.by(() => {
        if (!event) return false;
        const cal = getCalendar(event.calendarId);
        return !!cal?.readOnly;
    });

    let dialogEl: HTMLDivElement | undefined = $state();
    onMount(() => { if (dialogEl) return trapFocus(dialogEl); });

    function build(): Omit<CalEvent, 'id' | 'createdAt' | 'updatedAt'> | null {
        const t = title.trim();
        if (!t) { showToast('error', 'Title is required'); return null; }
        // Convert local date/time inputs to full ISO 8601 so the server
        // doesn't reject them for missing timezone.
        const startISO = allDay ? startDate : new Date(`${startDate}T${startTime}:00`).toISOString();
        const endISO = allDay ? endDate : new Date(`${endDate}T${endTime}:00`).toISOString();
        if (parseISO(startISO) > parseISO(endISO)) {
            showToast('error', 'End must be after start');
            return null;
        }
        return {
            calendarId, title: t, location: location.trim() || undefined,
            description: description.trim() || undefined,
            start: startISO, end: endISO, allDay, color, recurrence
        };
    }

    async function save() {
        const payload = build();
        if (!payload) return;
        saving = true;
        try {
            const result = event ? await updateEvent(event.id, payload) : await addEvent(payload);
            if (result) {
                onSaved?.(result);
                showToast('success', event ? 'Event updated' : 'Event created');
                onClose();
            } else {
                showToast('error', 'Save failed');
            }
        } catch (err) {
            showToast('error', (err as Error).message || 'Save failed');
        } finally { saving = false; }
    }

    async function remove() {
        if (!event) return;
        try {
            if (await deleteEvent(event.id)) {
                showToast('success', 'Event deleted');
                onClose();
            }
        } catch (err) {
            showToast('error', (err as Error).message || 'Delete failed');
        }
    }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
    <div bind:this={dialogEl} class="dialog fade-in" role="dialog" aria-modal="true" aria-labelledby="evt-title" data-testid="cal-event-modal">
        <header class="head">
            <h2 id="evt-title">{event ? (readOnly ? 'View event' : 'Edit event') : 'New event'}</h2>
            <button type="button" class="btn btn-ghost" onclick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
        </header>
        <div class="body" class:read-only={readOnly}>
            {#if readOnly}
                <div class="ro-banner">This calendar is read-only</div>
            {/if}
            <input
                type="text"
                class="title-input"
                placeholder="Add title"
                bind:value={title}
                readonly={readOnly}
                data-testid="cal-evt-title"
            />

            <div class="row">
                <label class="all-day">
                    <input type="checkbox" bind:checked={allDay} disabled={readOnly} data-testid="cal-evt-allday" />
                    All day
                </label>
            </div>

            <div class="row two">
                <label class="field">
                    <span>Start</span>
                    <div class="dt">
                        <input type="date" bind:value={startDate} readonly={readOnly} data-testid="cal-evt-start-date" />
                        {#if !allDay}<input type="time" bind:value={startTime} readonly={readOnly} data-testid="cal-evt-start-time" />{/if}
                    </div>
                </label>
                <label class="field">
                    <span>End</span>
                    <div class="dt">
                        <input type="date" bind:value={endDate} readonly={readOnly} data-testid="cal-evt-end-date" />
                        {#if !allDay}<input type="time" bind:value={endTime} readonly={readOnly} data-testid="cal-evt-end-time" />{/if}
                    </div>
                </label>
            </div>

            <label class="field">
                <span>Repeat</span>
                <select bind:value={recurrence} disabled={readOnly} data-testid="cal-evt-recurrence">
                    <option value="none">Doesn't repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                </select>
            </label>

            <label class="field">
                <span>Location</span>
                <input type="text" placeholder="Add location" bind:value={location} readonly={readOnly} data-testid="cal-evt-location" />
            </label>

            <label class="field">
                <span>Description</span>
                <textarea rows="3" placeholder="Add description" bind:value={description} readonly={readOnly} data-testid="cal-evt-description"></textarea>
            </label>

            <label class="field">
                <span>Calendar</span>
                <select bind:value={calendarId} disabled={readOnly} data-testid="cal-evt-calendar">
                    {#each calendarStore.calendars as cal (cal.id)}
                        <option value={cal.id}>{cal.name}</option>
                    {/each}
                </select>
            </label>

            <div class="field">
                <span>Colour</span>
                <div class="color-grid">
                    <button
                        type="button"
                        class={`swatch ${color === undefined ? 'sel' : ''}`}
                        title="Calendar default"
                        onclick={() => { if (!readOnly) color = undefined; }}
                        style="background: var(--bg-surface-alt);"
                        disabled={readOnly}
                    >×</button>
                    {#each EVENT_COLORS as c (c.value)}
                        <button
                            type="button"
                            class={`swatch ${color === c.value ? 'sel' : ''}`}
                            title={c.name}
                            style={`background: ${c.value};`}
                            onclick={() => { if (!readOnly) color = c.value; }}
                            disabled={readOnly}
                        ></button>
                    {/each}
                </div>
            </div>
        </div>
        <footer class="foot">
            <div>
                {#if event && !readOnly}
                    <button type="button" class="btn btn-ghost danger" onclick={remove} data-testid="cal-evt-delete">Delete</button>
                {/if}
            </div>
            <div class="foot-right">
                <button type="button" class="btn btn-ghost" onclick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
                {#if !readOnly}
                    <button type="button" class="btn btn-primary" onclick={save} disabled={saving} data-testid="cal-evt-save">
                        {saving ? 'Saving…' : (event ? 'Save' : 'Create')}
                    </button>
                {/if}
            </div>
        </footer>
    </div>
</div>

<style>
    .overlay {
        position: fixed; inset: 0;
        background: var(--bg-overlay);
        display: flex; align-items: center; justify-content: center;
        padding: 20px; z-index: 70;
        backdrop-filter: blur(2px);
    }
    .dialog {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(540px, 100%);
        max-height: calc(100vh - 40px);
        display: flex; flex-direction: column;
        overflow: hidden;
    }
    .head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.005em; }
    .body {
        padding: 16px 18px;
        overflow-y: auto;
        display: flex; flex-direction: column; gap: 12px;
    }
    .title-input {
        width: 100%;
        font-size: 18px;
        font-weight: 500;
        padding: 6px 0;
        border: 0;
        border-bottom: 2px solid var(--border-subtle);
        background: transparent;
        color: var(--text-primary);
    }
    .title-input:focus {
        outline: none;
        border-bottom-color: var(--accent);
    }
    .row.two {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
    }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field > span { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-tertiary); }
    .field input[type=text], .field input[type=date], .field input[type=time], .field select, .field textarea {
        padding: 7px 10px;
        font-size: 13px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-family: inherit;
    }
    .dt { display: flex; gap: 8px; }
    .dt input[type=date] { flex: 1; }
    .all-day { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }

    .color-grid { display: flex; flex-wrap: wrap; gap: 6px; }
    .swatch {
        width: 24px; height: 24px;
        border-radius: 50%;
        border: 2px solid transparent;
        font-size: 12px;
        line-height: 1;
        color: var(--text-secondary);
        cursor: pointer;
    }
    .swatch.sel { border-color: var(--accent); }

    .foot {
        display: flex; justify-content: space-between; align-items: center;
        padding: 12px 18px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .foot-right { display: flex; gap: 6px; }
    .danger { color: #c33; }
    .read-only .title-input,
    .read-only input[readonly],
    .read-only textarea[readonly],
    .read-only select:disabled {
        opacity: 0.7;
        cursor: not-allowed;
    }
    .read-only .swatch:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
    .ro-banner {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-tertiary);
        background: var(--bg-surface-alt);
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        text-align: center;
    }
</style>
