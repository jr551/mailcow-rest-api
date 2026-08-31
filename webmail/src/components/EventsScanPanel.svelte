<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import {
        listCalendars,
        listCalendarEvents,
        createCalendarEvent,
        getMessage,
        type MessageListItem,
        type NormalizedCalendar,
        type NormalizedEvent
    } from '../lib/api';
    import { getMessageBody, putMessageBody } from '../lib/cache';
    import { getSession } from '../lib/auth.svelte';
    import { ui, showToast } from '../lib/store.svelte';
    import { scanForEventsClient, type EventSuggestion, type ScanInputMessage } from '../lib/scan-events-client';
    import Icon from './Icon.svelte';

    interface Props {
        messages: MessageListItem[];
        open: boolean;
        onClose: () => void;
    }
    let { messages, open, onClose }: Props = $props();

    interface Row extends EventSuggestion {
        existingEvent?: NormalizedEvent | null;
        selected: boolean;
    }

    let calendars = $state<NormalizedCalendar[]>([]);
    let calendarId = $state<string>('');
    let scanning = $state(false);
    let scanError = $state<string | null>(null);
    let progress = $state<{ done: number; total: number; scanned: number; totalMsgs: number }>({
        done: 0, total: 0, scanned: 0, totalMsgs: 0
    });
    let rows = $state<Row[]>([]);
    let creating = $state(false);
    let createProgress = $state<{ done: number; total: number }>({ done: 0, total: 0 });
    let abortController: AbortController | null = null;

    const LAST_CAL_KEY = 'webmail.events-scan.last-calendar';
    // Body fetches are network-bound; cap at the 30 most recent messages to
    // keep the scan responsive. Older messages still get scanned with
    // subject + from only.
    const BODY_CAP = 30;

    const selectedCount = $derived(rows.filter((r) => r.selected).length);

    $effect(() => {
        if (open) {
            // Fire-and-forget: caught inside.
            void start();
        } else {
            abortController?.abort();
            abortController = null;
        }
    });

    async function start() {
        scanError = null;
        rows = [];
        scanning = true;
        progress = { done: 0, total: 0, scanned: 0, totalMsgs: messages.length };
        abortController?.abort();
        abortController = new AbortController();
        const signal = abortController.signal;
        try {
            await loadCalendars();
            const inputs = await buildInputs(signal);
            if (signal.aborted) return;
            const { suggestions } = await scanForEventsClient(inputs, {
                signal,
                onProgress: (done, total) => { progress = { ...progress, done, total }; }
            });
            if (signal.aborted) return;
            // Build initial rows; we'll fill in dupe detection below.
            const initial: Row[] = suggestions.map((s) => ({
                ...s,
                existingEvent: null,
                selected: s.isEvent && s.confidence >= 0.5
            }));
            rows = initial;
            await detectDuplicates(signal);
        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            scanError = err instanceof Error ? err.message : 'Calendar scan failed';
        } finally {
            scanning = false;
        }
    }

    async function loadCalendars() {
        try {
            const list = await listCalendars();
            calendars = list;
            const remembered = (() => {
                try { return localStorage.getItem(LAST_CAL_KEY) || ''; } catch { return ''; }
            })();
            const match = list.find((c) => c.id === remembered);
            calendarId = match?.id || list[0]?.id || '';
        } catch (err) {
            scanError = err instanceof Error ? err.message : 'Could not load calendars';
            throw err;
        }
    }

    async function buildInputs(signal: AbortSignal) {
        const session = getSession();
        const user = session?.user || '';
        const path = ui.selectedPath;
        // Newest first, cap body fetches.
        const ordered = [...messages].sort((a, b) => {
            const da = Date.parse(a.envelope?.date || a.internalDate || '') || 0;
            const db = Date.parse(b.envelope?.date || b.internalDate || '') || 0;
            return db - da;
        });
        const inputs: ScanInputMessage[] = [];
        let scanned = 0;
        for (let i = 0; i < ordered.length; i++) {
            if (signal.aborted) break;
            const m = ordered[i];
            let preview = '';
            if (i < BODY_CAP && user) {
                try {
                    let detail = await getMessageBody(user, path, m.uid);
                    if (!detail) {
                        detail = await getMessage(path, m.uid);
                        if (detail) await putMessageBody(user, path, m.uid, detail);
                    }
                    preview = (detail?.text || detail?.html || '').replace(/<[^>]+>/g, ' ');
                } catch { /* fall back to subject-only */ }
            }
            inputs.push({
                uid: m.uid,
                subject: m.envelope?.subject || undefined,
                from: m.envelope?.from || null,
                date: m.envelope?.date || m.internalDate || undefined,
                preview
            });
            scanned++;
            progress = { ...progress, scanned };
        }
        return inputs;
    }

    async function detectDuplicates(signal: AbortSignal) {
        if (!calendarId) return;
        const eventRows = rows.filter((r) => r.isEvent && r.start);
        if (eventRows.length === 0) return;
        // Compute the union of [start-2d, start+2d] windows. One CalDAV
        // call per unique calendar covers the whole batch.
        let earliest = Infinity;
        let latest = -Infinity;
        for (const r of eventRows) {
            const t = Date.parse(r.start);
            if (Number.isNaN(t)) continue;
            const lo = t - 2 * 86400_000;
            const hi = t + 2 * 86400_000;
            if (lo < earliest) earliest = lo;
            if (hi > latest) latest = hi;
        }
        if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return;
        let existing: NormalizedEvent[];
        try {
            existing = await listCalendarEvents(calendarId, {
                start: new Date(earliest),
                end: new Date(latest)
            });
        } catch {
            // Non-fatal: skip dupe detection but keep the suggestions.
            return;
        }
        if (signal.aborted) return;
        const updated = rows.map((r) => {
            if (!r.isEvent || !r.start) return r;
            const dupe = findDupe(r, existing);
            return {
                ...r,
                existingEvent: dupe || null,
                selected: dupe ? false : r.selected
            };
        });
        rows = updated;
    }

    // 2 hours is generous enough to absorb timezone-rounding noise
    // (DST flips, all-day → 09:00 fallback) without flagging genuinely
    // distinct events at the same address as duplicates.
    const DUPE_WINDOW_MS = 2 * 60 * 60 * 1000;

    function findDupe(row: Row, existing: NormalizedEvent[]): NormalizedEvent | null {
        const rowStart = Date.parse(row.start);
        if (!Number.isFinite(rowStart)) return null;
        const target = norm(row.title);
        for (const ev of existing) {
            const evStart = Date.parse(ev.start);
            if (!Number.isFinite(evStart)) continue;
            if (Math.abs(evStart - rowStart) > DUPE_WINDOW_MS) continue;
            const sim = similarity(target, norm(ev.title || ''));
            if (sim >= 0.7) return ev;
        }
        return null;
    }

    function norm(s: string): string {
        return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function similarity(a: string, b: string): number {
        if (!a || !b) return 0;
        if (a === b) return 1;
        const longer = a.length > b.length ? a : b;
        const shorter = a.length > b.length ? b : a;
        if (longer.length === 0) return 1;
        const dist = levenshtein(longer, shorter);
        return (longer.length - dist) / longer.length;
    }

    function levenshtein(a: string, b: string): number {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const prev = new Array(n + 1).fill(0);
        const curr = new Array(n + 1).fill(0);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            curr[0] = i;
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
            }
            for (let j = 0; j <= n; j++) prev[j] = curr[j];
        }
        return prev[n];
    }

    function fmtWhen(start: string, end?: string): string {
        const s = Date.parse(start);
        if (!Number.isFinite(s)) return start;
        const ds = new Date(s);
        const date = ds.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        const time = ds.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        let out = `${date}, ${time}`;
        if (end) {
            const e = Date.parse(end);
            if (Number.isFinite(e) && e > s) {
                const sameDay = new Date(e).toDateString() === ds.toDateString();
                const eTime = new Date(e).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
                out += sameDay
                    ? ` – ${eTime}`
                    : ` → ${new Date(e).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${eTime}`;
            }
        }
        return out;
    }

    function onCalendarChange() {
        try { localStorage.setItem(LAST_CAL_KEY, calendarId); } catch { /* */ }
        // Re-run dupe detection against the newly chosen calendar.
        if (rows.length && !scanning) {
            const ctl = new AbortController();
            void detectDuplicates(ctl.signal);
        }
    }

    function toggleRow(uid: number) {
        rows = rows.map((r) => r.uid === uid ? { ...r, selected: !r.selected } : r);
    }

    async function createSelected() {
        if (creating || !calendarId) return;
        const picks = rows.filter((r) => r.selected && r.isEvent);
        if (!picks.length) return;
        creating = true;
        createProgress = { done: 0, total: picks.length };
        let failed = 0;
        for (const r of picks) {
            try {
                await createCalendarEvent(calendarId, {
                    title: r.title,
                    start: r.start,
                    end: r.end || r.start,
                    description: r.description,
                    location: r.location
                });
            } catch {
                failed++;
            }
            createProgress = { ...createProgress, done: createProgress.done + 1 };
        }
        creating = false;
        const created = picks.length - failed;
        if (created > 0) {
            showToast('success', `Created ${created} ${created === 1 ? 'event' : 'events'}.`);
        }
        if (failed > 0) {
            showToast('error', `${failed} ${failed === 1 ? 'event' : 'events'} failed to create.`);
        }
        onClose();
    }

    function handleBackdrop(e: MouseEvent) {
        if (e.target === e.currentTarget) onClose();
    }

    function handleKey(e: KeyboardEvent) {
        if (!open) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }

    onMount(() => {
        window.addEventListener('keydown', handleKey);
    });
    onDestroy(() => {
        window.removeEventListener('keydown', handleKey);
        abortController?.abort();
    });
</script>

{#if open}
    <div
        class="events-scan-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="AI calendar scan"
        onclick={handleBackdrop}
    >
        <div class="panel" role="document">
            <header class="panel-header">
                <div class="panel-title">
                    <Icon name="calendar" size={16} />
                    <strong>AI calendar scan</strong>
                </div>
                <div class="cal-picker">
                    <label for="events-scan-cal">Add to</label>
                    <select
                        id="events-scan-cal"
                        bind:value={calendarId}
                        onchange={onCalendarChange}
                        disabled={!calendars.length || creating}
                    >
                        {#each calendars as cal (cal.id)}
                            <option value={cal.id}>{cal.name}</option>
                        {/each}
                    </select>
                </div>
                <button type="button" class="close-btn" aria-label="Close" onclick={onClose}>
                    <Icon name="close" size={16} />
                </button>
            </header>

            <div class="panel-body">
                {#if scanError}
                    <div class="error-strip">{scanError}</div>
                {/if}

                {#if scanning}
                    <div class="scanning-glass">
                        <div class="spinner"></div>
                        <div class="scan-text">
                            Scanning {progress.totalMsgs} {progress.totalMsgs === 1 ? 'message' : 'messages'}…
                        </div>
                        <div class="progress-bar">
                            <div
                                class="progress-fill"
                                style="width: {progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 5}%"
                            ></div>
                        </div>
                        <div class="progress-meta">
                            {#if progress.total > 0}
                                Chunk {progress.done} / {progress.total}
                            {:else}
                                Reading message bodies… ({progress.scanned}/{progress.totalMsgs})
                            {/if}
                        </div>
                    </div>
                {/if}

                {#if !scanning && rows.length > 0}
                    {@const eventRows = rows.filter((r) => r.isEvent)}
                    {#if eventRows.length === 0}
                        <div class="empty">No calendar-worthy events found.</div>
                    {:else}
                        <div class="table-wrap">
                            <table class="suggest-table">
                                <thead>
                                    <tr>
                                        <th class="col-check"></th>
                                        <th>Title</th>
                                        <th>When</th>
                                        <th>Why & citation</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {#each eventRows as r (r.uid)}
                                        <tr class:dupe={!!r.existingEvent}>
                                            <td class="col-check">
                                                <input
                                                    type="checkbox"
                                                    checked={r.selected}
                                                    onchange={() => toggleRow(r.uid)}
                                                />
                                            </td>
                                            <td class="col-title">
                                                <div class="title">{r.title}</div>
                                                {#if r.location}
                                                    <div class="loc">{r.location}</div>
                                                {/if}
                                            </td>
                                            <td class="col-when">{fmtWhen(r.start, r.end)}</td>
                                            <td class="col-why">
                                                <div class="why">{r.why}</div>
                                                {#if r.citation}
                                                    <div class="citation">"{r.citation}"</div>
                                                {/if}
                                            </td>
                                            <td class="col-status">
                                                {#if r.existingEvent}
                                                    <span
                                                        class="status dupe-status"
                                                        title={`Existing: ${r.existingEvent.title} @ ${fmtWhen(r.existingEvent.start)}`}
                                                    >
                                                        Possible duplicate
                                                    </span>
                                                {:else if r.confidence >= 0.5}
                                                    <span class="status new-status">New</span>
                                                {:else}
                                                    <span class="status low-status">Low confidence</span>
                                                {/if}
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    {/if}
                {/if}
            </div>

            <footer class="panel-footer">
                {#if creating}
                    <div class="create-progress">
                        <div class="spinner small"></div>
                        <span>{createProgress.done}/{createProgress.total} created…</span>
                    </div>
                {:else}
                    <span class="muted">{selectedCount} selected</span>
                {/if}
                <div class="footer-actions">
                    <button type="button" class="btn btn-ghost" onclick={onClose} disabled={creating}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        class="btn btn-primary"
                        disabled={selectedCount === 0 || creating || !calendarId}
                        onclick={createSelected}
                    >
                        Create {selectedCount} {selectedCount === 1 ? 'event' : 'events'}
                    </button>
                </div>
            </footer>
        </div>
    </div>
{/if}

<style>
    .events-scan-overlay {
        position: fixed;
        inset: 0;
        z-index: 200;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: color-mix(in srgb, var(--bg-base) 70%, transparent);
        backdrop-filter: blur(10px) saturate(140%);
        -webkit-backdrop-filter: blur(10px) saturate(140%);
    }
    .panel {
        width: min(900px, 100%);
        max-height: calc(100vh - 48px);
        display: flex;
        flex-direction: column;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: 14px;
        box-shadow: 0 24px 64px -16px rgba(0, 0, 0, 0.35);
        overflow: hidden;
    }
    .panel-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .panel-title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text-primary);
    }
    .cal-picker {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 12.5px;
        color: var(--text-secondary);
    }
    .cal-picker select {
        padding: 4px 8px;
        border-radius: 8px;
        border: 1px solid var(--border-subtle);
        background: var(--bg-base);
        color: var(--text-primary);
        font-size: 12.5px;
    }
    .close-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        border: 0;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
    }
    .close-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

    .panel-body {
        position: relative;
        flex: 1 1 auto;
        min-height: 200px;
        overflow: auto;
        padding: 16px;
    }
    .error-strip {
        margin-bottom: 12px;
        padding: 8px 12px;
        border-radius: 8px;
        background: var(--danger-soft);
        color: var(--danger);
        font-size: 12.5px;
    }
    .scanning-glass {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 32px 24px;
        border-radius: 12px;
        background: color-mix(in srgb, var(--bg-base) 70%, transparent);
        backdrop-filter: blur(10px) saturate(140%);
        -webkit-backdrop-filter: blur(10px) saturate(140%);
        border: 1px solid var(--border-subtle);
    }
    .spinner {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 3px solid color-mix(in srgb, var(--accent) 30%, transparent);
        border-top-color: var(--accent);
        animation: spin 0.9s linear infinite;
    }
    .spinner.small { width: 14px; height: 14px; border-width: 2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .scan-text {
        font-size: 13px;
        color: var(--text-primary);
        font-weight: 500;
    }
    .progress-bar {
        position: relative;
        width: min(360px, 100%);
        height: 6px;
        border-radius: 999px;
        background: var(--bg-hover);
        overflow: hidden;
    }
    .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #d268f4));
        transition: width 200ms ease;
        border-radius: 999px;
    }
    .progress-meta {
        font-size: 11.5px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
    }

    .empty {
        text-align: center;
        padding: 32px;
        color: var(--text-tertiary);
        font-size: 13px;
    }

    .table-wrap {
        overflow-x: auto;
    }
    .suggest-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
    }
    .suggest-table th,
    .suggest-table td {
        text-align: left;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border-subtle);
        vertical-align: top;
    }
    .suggest-table th {
        font-weight: 600;
        color: var(--text-secondary);
        font-size: 11.5px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: var(--bg-base);
        position: sticky;
        top: 0;
    }
    .col-check { width: 32px; }
    .col-when { white-space: nowrap; color: var(--text-secondary); }
    .col-status { white-space: nowrap; }
    .col-title .title { font-weight: 600; color: var(--text-primary); }
    .col-title .loc { color: var(--text-tertiary); font-size: 11.5px; margin-top: 2px; }
    .col-why .why { color: var(--text-primary); }
    .col-why .citation {
        margin-top: 2px;
        color: var(--text-tertiary);
        font-style: italic;
        font-size: 11.5px;
    }
    tr.dupe { background: color-mix(in srgb, var(--accent) 4%, transparent); }
    .status {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
    }
    .new-status {
        background: color-mix(in srgb, var(--accent) 18%, transparent);
        color: var(--accent-text, var(--accent));
    }
    .dupe-status {
        background: var(--bg-hover);
        color: var(--text-secondary);
        cursor: help;
    }
    .low-status {
        background: var(--bg-hover);
        color: var(--text-tertiary);
    }

    .panel-footer {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-base);
    }
    .footer-actions {
        margin-left: auto;
        display: inline-flex;
        gap: 8px;
    }
    .create-progress {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 12.5px;
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
    }
    .muted { color: var(--text-tertiary); font-size: 12.5px; }
    .btn {
        padding: 6px 14px;
        border-radius: 8px;
        font-size: 12.5px;
        font-weight: 500;
        border: 1px solid transparent;
        cursor: pointer;
    }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border-subtle);
    }
    .btn-ghost:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
    }
    .btn-primary {
        background: var(--accent);
        color: var(--text-on-accent, #fff);
    }
    .btn-primary:hover:not(:disabled) { filter: brightness(1.06); }
</style>
