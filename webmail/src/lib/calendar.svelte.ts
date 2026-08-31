// Calendar data layer.
//
// Source of truth is the REST API (/v1/me/calendars + /events + /calendar-subscriptions). We keep a
// localStorage shadow so the UI is instant on next boot (stale-while-revalidate),
// and a per-calendar `visible` flag is persisted client-side because the
// server doesn't track that.

import { format, parseISO, isAfter, isBefore } from 'date-fns';
import {
    listCalendars as apiListCalendars,
    listCalendarEvents as apiListEvents,
    createCalendarEvent as apiCreateEvent,
    deleteCalendarEvent as apiDeleteEvent,
    listCalendarSubscriptions as apiListSubs,
    listSubscriptionEvents as apiListSubEvents,
    createCalendarSubscription as apiCreateSub,
    deleteCalendarSubscription as apiDeleteSub,
    type NormalizedCalendar,
    type NormalizedEvent,
    type CalendarSubscription
} from './api';

const CAL_CACHE = 'webmail.calendar.v1.calendars';
const SUB_CACHE = 'webmail.calendar.v1.subscriptions';
const EVT_CACHE = 'webmail.calendar.v1.events';
const VIS_KEY = 'webmail.calendar.v1.visibility';
const DEFAULT_KEY = 'webmail.calendar.v1.default';

// --- Types -------------------------------------------------------------

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type EventVisibility = 'default' | 'private' | 'public';
export type CalendarSource = 'caldav' | 'subscription';

export interface Calendar {
    id: string;
    name: string;
    color: string;
    visible: boolean;
    primary?: boolean;
    description?: string;
    readOnly?: boolean;
    source?: CalendarSource;
    url?: string;
}

export interface CalEvent {
    id: string;             // server UID
    calendarId: string;
    title: string;
    description?: string;
    location?: string;
    start: string;
    end: string;
    allDay?: boolean;
    recurrence?: Recurrence;
    color?: string;
    visibility?: EventVisibility;
    createdAt?: string;
    updatedAt?: string;
}

// GCal-ish event colour palette (named so the UI can show a swatch grid).
export const EVENT_COLORS = [
    { name: 'Tomato', value: '#d50000' },
    { name: 'Tangerine', value: '#f4511e' },
    { name: 'Banana', value: '#f6bf26' },
    { name: 'Sage', value: '#33b679' },
    { name: 'Basil', value: '#0b8043' },
    { name: 'Peacock', value: '#039be5' },
    { name: 'Blueberry', value: '#1a73e8' },
    { name: 'Lavender', value: '#7986cb' },
    { name: 'Grape', value: '#8e24aa' },
    { name: 'Flamingo', value: '#e67c73' },
    { name: 'Graphite', value: '#616161' }
];

const DEFAULT_COLOR = '#1a73e8';

// --- Persistence helpers ----------------------------------------------

function readStore<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw) as T;
    } catch { return fallback; }
}

function writeStore(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / disabled */ }
}

function readVisibility(): Record<string, boolean> {
    return readStore<Record<string, boolean>>(VIS_KEY, {});
}

function writeVisibility(map: Record<string, boolean>) {
    writeStore(VIS_KEY, map);
}

// User's preferred default calendar — overrides "primary" when set.
const _defaultId = $state<{ id: string | null }>(
    { id: readStore<string | null>(DEFAULT_KEY, null) }
);

export function getDefaultCalendarId(): string | null { return _defaultId.id; }

export function setDefaultCalendarId(id: string | null) {
    _defaultId.id = id;
    if (id) writeStore(DEFAULT_KEY, id);
    else { try { localStorage.removeItem(DEFAULT_KEY); } catch { /* */ } }
}

// Resolve which calendar new events should land in: the explicit user
// pick → the SOGo "Personal" primary → first calendar → string fallback.
export function resolveDefaultCalendarId(): string {
    const cs = state.calendars;
    if (_defaultId.id && cs.some((c) => c.id === _defaultId.id && !c.readOnly)) return _defaultId.id;
    return cs.find((c) => c.primary && !c.readOnly)?.id ?? cs.find((c) => !c.readOnly)?.id ?? 'primary';
}

// --- Recurrence conversion --------------------------------------------

function rruleToRecurrence(rrule?: string): Recurrence {
    if (!rrule) return 'none';
    const u = rrule.toUpperCase();
    if (u.includes('FREQ=DAILY')) return 'daily';
    if (u.includes('FREQ=WEEKLY')) return 'weekly';
    if (u.includes('FREQ=MONTHLY')) return 'monthly';
    if (u.includes('FREQ=YEARLY')) return 'yearly';
    return 'none';
}

function recurrenceToRrule(r?: Recurrence): string | undefined {
    switch (r) {
        case 'daily': return 'FREQ=DAILY';
        case 'weekly': return 'FREQ=WEEKLY';
        case 'monthly': return 'FREQ=MONTHLY';
        case 'yearly': return 'FREQ=YEARLY';
        default: return undefined;
    }
}

function fromApiCalendar(c: NormalizedCalendar, vis: Record<string, boolean>): Calendar {
    const visible = c.id in vis ? vis[c.id] : true;
    // SOGo's "Personal" calendar is the user's primary; flag it so the UI
    // shows a marker and EventModal picks it as the default.
    const isPrimary = /^personal$/i.test(c.id) || /^personal$/i.test(c.name);
    return {
        id: c.id,
        name: c.name,
        color: c.color || DEFAULT_COLOR,
        visible,
        primary: isPrimary,
        source: 'caldav'
    };
}

function fromApiEvent(e: NormalizedEvent): CalEvent {
    return {
        id: e.uid,
        calendarId: e.calendarId,
        title: e.title,
        description: e.description,
        location: e.location,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        recurrence: 'none'  // Server doesn't surface RRULE yet.
    };
}

function fromSubEvent(e: { uid: string; summary: string; description?: string; location?: string; dtstart: string; dtend: string }, subId: string): CalEvent {
    const start = e.dtstart;
    const end = e.dtend || e.dtstart;
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);
    return {
        id: e.uid,
        calendarId: subId,
        title: e.summary || '(untitled)',
        description: e.description,
        location: e.location,
        start,
        end,
        allDay
    };
}

// --- Reactive state ---------------------------------------------------

interface CalState {
    calendars: Calendar[];
    events: CalEvent[];
    loaded: boolean;
    loading: boolean;
    error: string | null;
}

const state = $state<CalState>({
    calendars: [],
    events: [],
    loaded: false,
    loading: false,
    error: null
});

export const calendarStore = state;

function cryptoId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

function defaultRange(): { from: Date; to: Date } {
    const from = new Date();
    from.setMonth(from.getMonth() - 1);
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setMonth(to.getMonth() + 6);
    to.setHours(23, 59, 59, 999);
    return { from, to };
}

// First-load entry point. Renders the SWR cache instantly, then refetches.
export async function loadCalendar(): Promise<void> {
    if (state.loaded || state.loading) return;
    state.loading = true;
    state.error = null;

    // Render whatever we have cached so the UI is not blank.
    const vis = readVisibility();
    const cachedCals = readStore<NormalizedCalendar[]>(CAL_CACHE, []);
    const cachedSubs = readStore<CalendarSubscription[]>(SUB_CACHE, []);
    const initialCals: Calendar[] = [
        ...cachedCals.map((c) => fromApiCalendar(c, vis)),
        ...cachedSubs.map((s) => ({
            id: s.id,
            name: s.name,
            color: s.color || DEFAULT_COLOR,
            visible: vis[s.id] ?? true,
            readOnly: true,
            source: 'subscription' as CalendarSource,
            url: s.url
        }))
    ];
    if (initialCals.length) state.calendars = initialCals;
    const cachedEvents = readStore<NormalizedEvent[]>(EVT_CACHE, []);
    if (cachedEvents.length) state.events = cachedEvents.map(fromApiEvent);

    try {
        const [cals, subs] = await Promise.all([
            apiListCalendars(),
            apiListSubs().catch(() => [] as CalendarSubscription[])
        ]);
        const mergedCals: Calendar[] = [
            ...cals.map((c) => fromApiCalendar(c, vis)),
            ...subs.map((s) => ({
                id: s.id,
                name: s.name,
                color: s.color || DEFAULT_COLOR,
                visible: vis[s.id] ?? true,
                readOnly: true,
                source: 'subscription' as CalendarSource,
                url: s.url
            }))
        ];
        state.calendars = mergedCals;
        writeStore(CAL_CACHE, cals);
        writeStore(SUB_CACHE, subs);

        const { from, to } = defaultRange();
        const visibleCaldav = state.calendars.filter((c) => c.visible && c.source === 'caldav').map((c) => c.id);
        const visibleSubs = state.calendars.filter((c) => c.visible && c.source === 'subscription').map((c) => c.id);

        const [caldavFetched, subFetched] = await Promise.all([
            Promise.all(
                visibleCaldav.map((id) =>
                    apiListEvents(id, { start: from, end: to }).catch(() => [] as NormalizedEvent[])
                )
            ),
            Promise.all(
                visibleSubs.map((id) =>
                    apiListSubEvents(id, { start: from, end: to }).catch(() => [] as { uid: string; summary: string; description?: string; location?: string; dtstart: string; dtend: string }[])
                )
            )
        ]);

        const allCaldav = caldavFetched.flat().map(fromApiEvent);
        const allSub = subFetched.map((events, idx) =>
            events.map((e) => fromSubEvent(e, visibleSubs[idx]))
        ).flat();
        state.events = [...allCaldav, ...allSub];
        writeStore(EVT_CACHE, mergedRaw(state.events));
        state.loaded = true;
    } catch (err) {
        state.error = (err as Error).message || 'Failed to load calendar';
    } finally {
        state.loading = false;
    }
}

/** Re-fetch events for a specific calendar (e.g. after toggling visibility). */
export async function refreshCalendarEvents(calendarId: string): Promise<void> {
    const cal = state.calendars.find((c) => c.id === calendarId);
    if (!cal) return;
    const { from, to } = defaultRange();
    try {
        let refreshed: CalEvent[];
        if (cal.source === 'subscription') {
            const evs = await apiListSubEvents(calendarId, { start: from, end: to });
            refreshed = evs.map((e) => fromSubEvent(e, calendarId));
        } else {
            const evs = await apiListEvents(calendarId, { start: from, end: to });
            refreshed = evs.map(fromApiEvent);
        }
        const others = state.events.filter((e) => e.calendarId !== calendarId);
        const merged = [...others, ...refreshed];
        state.events = merged;
        writeStore(EVT_CACHE, mergedRaw(state.events));
    } catch (err) {
        state.error = (err as Error).message;
    }
}

function mergedRaw(events: CalEvent[]): NormalizedEvent[] {
    return events.map((e) => ({
        uid: e.id,
        calendarId: e.calendarId,
        title: e.title,
        description: e.description,
        location: e.location,
        start: e.start,
        end: e.end,
        allDay: e.allDay
    }));
}

// --- CRUD --------------------------------------------------------------

export function listCalendars(): Calendar[] { return state.calendars; }
export function getCalendar(id: string): Calendar | undefined {
    return state.calendars.find((c) => c.id === id);
}

export function setCalendarVisibility(id: string, visible: boolean) {
    state.calendars = state.calendars.map((c) => c.id === id ? { ...c, visible } : c);
    const vis = readVisibility();
    vis[id] = visible;
    writeVisibility(vis);
    if (visible) {
        // Pull this calendar's events in case we hadn't loaded them.
        refreshCalendarEvents(id);
    }
}

export function listEvents(opts: { from?: Date; to?: Date; calendarIds?: string[] } = {}): CalEvent[] {
    const cals = opts.calendarIds && opts.calendarIds.length
        ? new Set(opts.calendarIds)
        : null;
    return state.events.filter((e) => {
        if (cals && !cals.has(e.calendarId)) return false;
        if (opts.from || opts.to) {
            const s = parseISO(e.start);
            const en = parseISO(e.end);
            if (opts.to && isAfter(s, opts.to)) return false;
            if (opts.from && isBefore(en, opts.from)) return false;
        }
        return true;
    });
}

export function getEvent(id: string): CalEvent | undefined {
    return state.events.find((e) => e.id === id);
}

export async function addEvent(input: Omit<CalEvent, 'id' | 'createdAt' | 'updatedAt'>): Promise<CalEvent> {
    const cal = getCalendar(input.calendarId);
    if (cal?.readOnly) throw new Error('This calendar is read-only');
    const { calendarId } = input;
    const created = await apiCreateEvent(calendarId, {
        title: input.title,
        start: input.start,
        end: input.end,
        description: input.description,
        location: input.location
    });
    // Server returns only { uid, calendar } — synthesise the full record locally.
    const evt: CalEvent = {
        id: created.uid || cryptoId(),
        calendarId: created.calendar || calendarId,
        title: input.title,
        description: input.description,
        location: input.location,
        start: input.start,
        end: input.end,
        allDay: input.allDay,
        recurrence: input.recurrence || 'none',
        color: input.color
    };
    state.events = [...state.events, evt];
    writeStore(EVT_CACHE, mergedRaw(state.events));
    return evt;
}

// Server has no PATCH/PUT; an "edit" is delete-then-create. The new event
// gets a fresh UID, so client-side references switch over too.
export async function updateEvent(id: string, patch: Partial<Omit<CalEvent, 'id' | 'createdAt'>>): Promise<CalEvent | undefined> {
    const existing = state.events.find((e) => e.id === id);
    if (!existing) return undefined;
    const cal = getCalendar(existing.calendarId);
    if (cal?.readOnly) throw new Error('This calendar is read-only');
    const merged: CalEvent = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    try {
        await apiDeleteEvent(existing.calendarId, existing.id);
    } catch { /* tolerate — proceed to recreate */ }
    const created = await apiCreateEvent(merged.calendarId, {
        title: merged.title,
        start: merged.start,
        end: merged.end,
        description: merged.description,
        location: merged.location
    });
    const next: CalEvent = { ...merged, id: created.uid || merged.id };
    state.events = state.events.map((e) => e.id === id ? next : e);
    writeStore(EVT_CACHE, mergedRaw(state.events));
    return next;
}

export async function deleteEvent(id: string): Promise<boolean> {
    const existing = state.events.find((e) => e.id === id);
    if (!existing) return false;
    const cal = getCalendar(existing.calendarId);
    if (cal?.readOnly) throw new Error('This calendar is read-only');
    try {
        await apiDeleteEvent(existing.calendarId, existing.id);
    } catch { /* still drop locally so the UI doesn't get stuck */ }
    state.events = state.events.filter((e) => e.id !== id);
    writeStore(EVT_CACHE, mergedRaw(state.events));
    return true;
}

// --- Subscription management --------------------------------------------

export async function addSubscription(input: { name: string; url: string; color?: string }): Promise<Calendar> {
    const sub = await apiCreateSub(input);
    const cal: Calendar = {
        id: sub.id,
        name: sub.name,
        color: sub.color || DEFAULT_COLOR,
        visible: true,
        readOnly: true,
        source: 'subscription',
        url: sub.url
    };
    state.calendars = [...state.calendars, cal];
    writeStore(SUB_CACHE, state.calendars.filter((c) => c.source === 'subscription').map((c) => ({ id: c.id, name: c.name, url: c.url || '', color: c.color })));
    // Fetch events immediately
    refreshCalendarEvents(cal.id);
    return cal;
}

export async function removeSubscription(id: string): Promise<boolean> {
    try {
        await apiDeleteSub(id);
    } catch { /* tolerate */ }
    state.calendars = state.calendars.filter((c) => c.id !== id);
    state.events = state.events.filter((e) => e.calendarId !== id);
    writeStore(SUB_CACHE, state.calendars.filter((c) => c.source === 'subscription').map((c) => ({ id: c.id, name: c.name, url: c.url || '', color: c.color })));
    writeStore(EVT_CACHE, mergedRaw(state.events));
    const vis = readVisibility();
    delete vis[id];
    writeVisibility(vis);
    return true;
}

// --- Recurrence expansion (simple RRULE FREQ=… handler) ---------------

export function expandOccurrences(evt: CalEvent, from: Date, to: Date): CalEvent[] {
    if (!evt.recurrence || evt.recurrence === 'none') {
        const s = parseISO(evt.start);
        const e = parseISO(evt.end);
        if (isAfter(s, to) || isBefore(e, from)) return [];
        return [evt];
    }
    const out: CalEvent[] = [];
    const baseStart = parseISO(evt.start);
    const baseEnd = parseISO(evt.end);
    const durationMs = baseEnd.getTime() - baseStart.getTime();
    const stepDays = evt.recurrence === 'daily' ? 1
        : evt.recurrence === 'weekly' ? 7
        : 0;
    let cursor = new Date(baseStart);
    let safety = 365 * 5;
    while (safety-- > 0 && cursor.getTime() <= to.getTime()) {
        const eEnd = new Date(cursor.getTime() + durationMs);
        if (eEnd >= from) {
            out.push({
                ...evt,
                id: `${evt.id}@${format(cursor, 'yyyyMMdd')}`,
                start: format(cursor, "yyyy-MM-dd'T'HH:mm:ss"),
                end: format(eEnd, "yyyy-MM-dd'T'HH:mm:ss")
            });
        }
        if (stepDays) cursor = new Date(cursor.getTime() + stepDays * 86_400_000);
        else if (evt.recurrence === 'monthly') {
            cursor = new Date(cursor); cursor.setMonth(cursor.getMonth() + 1);
        } else if (evt.recurrence === 'yearly') {
            cursor = new Date(cursor); cursor.setFullYear(cursor.getFullYear() + 1);
        } else break;
    }
    return out;
}

export function eventsInRange(from: Date, to: Date, opts: { calendarIds?: string[] } = {}): CalEvent[] {
    const visibleCals = opts.calendarIds
        ? new Set(opts.calendarIds)
        : new Set(state.calendars.filter((c) => c.visible).map((c) => c.id));
    const out: CalEvent[] = [];
    for (const evt of state.events) {
        if (!visibleCals.has(evt.calendarId)) continue;
        out.push(...expandOccurrences(evt, from, to));
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    return out;
}
