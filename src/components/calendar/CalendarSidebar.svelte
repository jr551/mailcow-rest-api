<script lang="ts">
    import Icon from '../Icon.svelte';
    import MiniCalendar from './MiniCalendar.svelte';
    import { showToast } from '../../lib/store.svelte';
    import { getIcalPublicToken, issueIcalPublicToken, revokeIcalPublicToken, type IcalPublicToken } from '../../lib/api';
    import {
        calendarStore, setCalendarVisibility, getDefaultCalendarId, setDefaultCalendarId,
        addSubscription, removeSubscription
    } from '../../lib/calendar.svelte';

    // Re-render the default-star whenever the user picks a new one. The
    // setter mutates an internal $state cell so reading via getDefault…()
    // stays reactive in this component.
    let defaultId = $derived(getDefaultCalendarId());

    function pickDefault(id: string) {
        if (defaultId === id) {
            // Tap the active star again to clear → fall back to "Personal".
            setDefaultCalendarId(null);
        } else {
            setDefaultCalendarId(id);
        }
    }

    interface Props {
        cursor: Date;
        selected: Date;
        onSelect: (d: Date) => void;
        onCreate: () => void;
    }
    let { cursor, selected, onSelect, onCreate }: Props = $props();

    // --- Context menu for calendars --------------------------------------
    let ctxMenu = $state<{ calId: string; x: number; y: number } | null>(null);

    function onCtxMenu(e: MouseEvent, calId: string) {
        e.preventDefault();
        // Stop the window-level contextmenu listener (below) from seeing
        // this same event and immediately closing the menu we just opened.
        e.stopPropagation();
        ctxMenu = { calId, x: e.clientX, y: e.clientY };
    }

    function closeCtx() {
        ctxMenu = null;
    }

    // --- Public iCal-link modal --------------------------------------
    // Replaces the old toast-only flow: clicking "Copy iCal link" pops
    // a confirm modal that explains the URL embeds a secret, lets the
    // user generate / copy / regenerate / revoke it, and shows expiry.
    let icalDialog = $state<{
        calId: string;
        calName: string;
        token: IcalPublicToken | null;
        loading: boolean;
        error: string | null;
        copied: boolean;
    } | null>(null);

    async function openIcalDialog(calId: string) {
        const cal = calendarStore.calendars.find((c) => c.id === calId);
        icalDialog = { calId, calName: cal?.name || calId, token: null, loading: true, error: null, copied: false };
        closeCtx();
        try {
            const t = await getIcalPublicToken(calId);
            if (icalDialog) icalDialog.token = t;
        } catch (err) {
            if (icalDialog) icalDialog.error = (err as Error).message || 'Failed to load token';
        } finally {
            if (icalDialog) icalDialog.loading = false;
        }
    }

    async function generateOrRotateIcal() {
        if (!icalDialog) return;
        icalDialog.loading = true;
        icalDialog.error = null;
        try {
            icalDialog.token = await issueIcalPublicToken(icalDialog.calId);
        } catch (err) {
            icalDialog.error = (err as Error).message || 'Failed to generate link';
        } finally {
            if (icalDialog) icalDialog.loading = false;
        }
    }

    async function revokeIcal() {
        if (!icalDialog) return;
        if (!confirm('Revoke this link? Anything subscribed will stop syncing.')) return;
        icalDialog.loading = true;
        try {
            await revokeIcalPublicToken(icalDialog.calId);
            icalDialog.token = { token: null, url: null, createdAt: null, expiresAt: null };
            showToast('success', 'iCal link revoked');
        } catch (err) {
            icalDialog.error = (err as Error).message || 'Failed to revoke';
        } finally {
            if (icalDialog) icalDialog.loading = false;
        }
    }

    async function copyDialogUrl() {
        if (!icalDialog?.token?.url) return;
        try {
            await navigator.clipboard.writeText(icalDialog.token.url);
            icalDialog.copied = true;
            setTimeout(() => { if (icalDialog) icalDialog.copied = false; }, 2400);
        } catch {
            showToast('error', 'Couldn\'t copy — select the text manually');
        }
    }

    function closeIcalDialog() {
        icalDialog = null;
    }

    function fmtExpiry(ts: number | null | undefined): string {
        if (!ts) return 'never';
        const d = new Date(ts);
        return d.toLocaleString();
    }

    // Close context menu on click elsewhere
    $effect(() => {
        if (!ctxMenu) return;
        const handler = () => closeCtx();
        window.addEventListener('click', handler, { once: true });
        return () => window.removeEventListener('click', handler);
    });

    // --- Subscription modal ----------------------------------------------
    let subModalOpen = $state(false);
    let subName = $state('');
    let subUrl = $state('');
    let subColor = $state('#1a73e8');
    let subSaving = $state(false);

    function openSubModal() {
        subModalOpen = true;
        subName = '';
        subUrl = '';
        subColor = '#1a73e8';
    }

    function closeSubModal() {
        subModalOpen = false;
    }

    async function saveSubscription() {
        const name = subName.trim();
        const url = subUrl.trim();
        if (!name || !url) {
            showToast('error', 'Name and URL are required');
            return;
        }
        subSaving = true;
        try {
            await addSubscription({ name, url, color: subColor });
            showToast('success', 'Subscription added');
            closeSubModal();
        } catch (err) {
            showToast('error', (err as Error).message || 'Failed to add subscription');
        } finally {
            subSaving = false;
        }
    }

    async function deleteSub(id: string) {
        try {
            await removeSubscription(id);
            showToast('success', 'Subscription removed');
        } catch (err) {
            showToast('error', (err as Error).message || 'Failed to remove subscription');
        }
    }

    function isGoogleCalendar(url?: string): boolean {
        if (!url) return false;
        try {
            const u = new URL(url);
            return u.hostname.includes('google.com') || u.hostname.includes('googleusercontent.com');
        } catch { return false; }
    }

    const myCalendars = $derived(calendarStore.calendars.filter((c) => c.source !== 'subscription'));
    const subscriptions = $derived(calendarStore.calendars.filter((c) => c.source === 'subscription'));
</script>

<svelte:window oncontextmenu={(e) => {
    // Close our custom context menu if user right-clicks elsewhere
    if (ctxMenu && !(e.target as HTMLElement)?.closest('.ctx-menu')) closeCtx();
}} />

<aside class="cal-sidebar" data-testid="cal-sidebar">
    <button type="button" class="create" onclick={onCreate} data-testid="cal-create-fab">
        <Icon name="plus" size={16} />
        <span>Create</span>
    </button>

    <MiniCalendar {cursor} {selected} {onSelect} />

    <div class="cal-list" data-testid="cal-my-list">
        <h4 class="list-title">My calendars</h4>
        <ul>
            {#each myCalendars as cal (cal.id)}
                {@const isDefault = defaultId === cal.id}
                <li class="cal-li">
                    <label class="cal-row" oncontextmenu={(e) => onCtxMenu(e, cal.id)}>
                        <input
                            type="checkbox"
                            checked={cal.visible}
                            onchange={(e) => setCalendarVisibility(cal.id, (e.currentTarget as HTMLInputElement).checked)}
                            data-testid={`cal-visibility-${cal.id}`}
                        />
                        <span class="swatch" style={`background: ${cal.color}; border-color: ${cal.color};`}></span>
                        <span class="cal-name truncate">{cal.name}</span>
                        {#if cal.primary}<span class="primary-dot" title="SOGo primary calendar">●</span>{/if}
                    </label>
                    <button
                        type="button"
                        class={`default-pin ${isDefault ? 'active' : ''}`}
                        title={isDefault ? 'Default for new events — tap to clear' : 'Set as default for new events'}
                        aria-pressed={isDefault}
                        aria-label={isDefault ? `${cal.name} is the default calendar` : `Set ${cal.name} as default calendar`}
                        onclick={() => pickDefault(cal.id)}
                        data-testid={`cal-default-${cal.id}`}
                    >
                        <Icon name={isDefault ? 'starFilled' : 'star'} size={12} />
                    </button>
                </li>
            {/each}
        </ul>
    </div>

    <div class="cal-list" data-testid="cal-sub-list">
        <div class="list-header">
            <h4 class="list-title">Subscriptions</h4>
            <button type="button" class="add-sub-btn" onclick={openSubModal} title="Add external calendar" data-testid="cal-add-sub">
                <Icon name="plus" size={12} />
            </button>
        </div>
        <ul>
            {#each subscriptions as sub (sub.id)}
                <li class="cal-li">
                    <label class="cal-row">
                        <input
                            type="checkbox"
                            checked={sub.visible}
                            onchange={(e) => setCalendarVisibility(sub.id, (e.currentTarget as HTMLInputElement).checked)}
                            data-testid={`cal-visibility-${sub.id}`}
                        />
                        <span class="swatch" style={`background: ${sub.color}; border-color: ${sub.color};`}></span>
                        <span class="cal-name truncate">{sub.name}</span>
                        {#if isGoogleCalendar(sub.url)}
                            <span class="google-badge" title="Google Calendar">G</span>
                        {:else}
                            <Icon name="globe" size={12} class="sub-icon" />
                        {/if}
                    </label>
                    <button
                        type="button"
                        class="default-pin delete-sub"
                        title="Remove subscription"
                        aria-label={`Remove ${sub.name}`}
                        onclick={() => deleteSub(sub.id)}
                        data-testid={`cal-sub-delete-${sub.id}`}
                    >
                        <Icon name="trash" size={12} />
                    </button>
                </li>
            {/each}
            {#if subscriptions.length === 0}
                <li class="empty-sub">No subscriptions yet</li>
            {/if}
        </ul>
    </div>
</aside>

{#if ctxMenu}
    {@const cal = calendarStore.calendars.find((c) => c.id === ctxMenu!.calId)}
    <ul class="ctx-menu" style={`position:fixed;left:${ctxMenu.x}px;top:${ctxMenu.y}px;z-index:200;`} role="menu">
        <li role="menuitem">
            <button type="button" class="ctx-item" onclick={() => openIcalDialog(ctxMenu!.calId)}>
                <Icon name="link" size={14} />
                <span>Copy iCal link</span>
            </button>
        </li>
    </ul>
{/if}

{#if icalDialog}
    {@const dlg = icalDialog}
    <div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) closeIcalDialog(); }} role="presentation">
        <div class="dialog fade-in" role="dialog" aria-modal="true" aria-labelledby="ical-dlg-title" data-testid="ical-dialog">
            <header class="head">
                <h2 id="ical-dlg-title">
                    <Icon name="link" size={14} />
                    Public iCal link — {dlg.calName}
                </h2>
                <button type="button" class="btn btn-ghost" onclick={closeIcalDialog} aria-label="Close"><Icon name="close" size={14} /></button>
            </header>

            <div class="body">
                <div class="warn-banner">
                    <Icon name="shieldAlert" size={14} />
                    <div>
                        <strong>Treat this URL like a password.</strong>
                        Anyone with the link can read your calendar — past and upcoming events, locations, attendees, the lot.
                        Don't paste it into Slack, GitHub, support tickets, or anywhere it could leak.
                    </div>
                </div>

                {#if dlg.error}
                    <p class="err" role="alert">{dlg.error}</p>
                {/if}

                {#if dlg.loading}
                    <p class="muted small">Working…</p>
                {:else if dlg.token?.url}
                    <label class="field">
                        <span>iCal feed URL</span>
                        <div class="url-row">
                            <input type="text" readonly value={dlg.token.url} onclick={(e) => (e.currentTarget as HTMLInputElement).select()} data-testid="ical-dialog-url" />
                            <button type="button" class={`btn btn-primary ${dlg.copied ? 'copied' : ''}`} onclick={copyDialogUrl} data-testid="ical-dialog-copy">
                                <Icon name={dlg.copied ? 'check' : 'copy'} size={13} />
                                {dlg.copied ? 'Copied' : 'Copy'}
                            </button>
                        </div>
                    </label>
                    <div class="meta-row muted small">
                        <span>Created: {fmtExpiry(dlg.token.createdAt)}</span>
                        <span>Never expires — revoke if you need to invalidate it.</span>
                    </div>
                {:else}
                    <p class="muted">No public link yet. Click <strong>Generate</strong> to mint one — the token is 64 hex chars, unguessable, and stays valid until you revoke it.</p>
                {/if}
            </div>

            <footer class="foot">
                {#if dlg.token?.url}
                    <button type="button" class="btn btn-ghost danger-ghost" onclick={revokeIcal} disabled={dlg.loading}>Revoke</button>
                {/if}
                <span style="flex:1"></span>
                <button type="button" class="btn btn-ghost" onclick={closeIcalDialog}>Close</button>
                <button type="button" class="btn btn-primary" onclick={generateOrRotateIcal} disabled={dlg.loading} data-testid="ical-dialog-generate">
                    {#if dlg.token?.url}Regenerate (rotate){:else}Generate{/if}
                </button>
            </footer>
        </div>
    </div>
{/if}

{#if subModalOpen}
    <div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) closeSubModal(); }} role="presentation">
        <div class="dialog fade-in" role="dialog" aria-modal="true" data-testid="cal-sub-modal">
            <header class="head">
                <h2>Add calendar subscription</h2>
                <button type="button" class="btn btn-ghost" onclick={closeSubModal} aria-label="Close"><Icon name="close" size={14} /></button>
            </header>
            <div class="body">
                <label class="field">
                    <span>Name</span>
                    <input type="text" placeholder="e.g. Team Calendar" bind:value={subName} data-testid="cal-sub-name" />
                </label>
                <label class="field">
                    <span>ICS URL</span>
                    <input type="url" placeholder="https://calendar.google.com/calendar/ical/…" bind:value={subUrl} data-testid="cal-sub-url" />
                </label>
                <div class="field">
                    <span>Colour</span>
                    <div class="color-grid">
                        {#each ['#d50000', '#f4511e', '#f6bf26', '#33b679', '#0b8043', '#039be5', '#1a73e8', '#7986cb', '#8e24aa', '#e67c73', '#616161'] as c (c)}
                            <button
                                type="button"
                                class={`swatch ${subColor === c ? 'sel' : ''}`}
                                style={`background: ${c};`}
                                onclick={() => (subColor = c)}
                            ></button>
                        {/each}
                    </div>
                </div>
            </div>
            <footer class="foot">
                <button type="button" class="btn btn-ghost" onclick={closeSubModal}>Cancel</button>
                <button type="button" class="btn btn-primary" onclick={saveSubscription} disabled={subSaving || !subName.trim() || !subUrl.trim()} data-testid="cal-sub-save">
                    {subSaving ? 'Adding…' : 'Add'}
                </button>
            </footer>
        </div>
    </div>
{/if}

<style>
    .cal-sidebar {
        flex: 0 0 240px;
        max-width: 240px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 14px 12px 12px;
        background: var(--bg-surface);
        border-right: 1px solid var(--border-subtle);
        overflow-y: auto;
    }
    @media (max-width: 720px) {
        .cal-sidebar { display: none; }
    }
    .create {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        align-self: flex-start;
        padding: 10px 18px 10px 14px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        box-shadow: var(--shadow-sm);
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary);
        transition: box-shadow var(--transition-fast);
    }
    .create:hover { box-shadow: var(--shadow-md); }

    .cal-list { padding: 0 4px; }
    .list-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
    }
    .list-title {
        margin: 0;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
    }
    .add-sub-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 4px;
        color: var(--text-tertiary);
        opacity: 0.6;
        transition: opacity var(--transition-fast), color var(--transition-fast);
    }
    .add-sub-btn:hover { opacity: 1; color: var(--accent-text); }
    .cal-list ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .cal-row {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 6px;
        font-size: 13px;
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        cursor: pointer;
    }
    .cal-row:hover { background: var(--bg-hover); }
    .cal-row input[type=checkbox] {
        width: 14px; height: 14px;
        accent-color: currentColor;
    }
    .swatch {
        display: inline-block;
        width: 12px; height: 12px;
        border-radius: 3px;
        border: 1px solid;
        flex-shrink: 0;
    }
    .cal-name { flex: 1; min-width: 0; }
    .primary-dot { font-size: 9px; color: var(--accent); }
    .cal-li {
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .cal-li .cal-row { flex: 1; min-width: 0; }
    .default-pin {
        flex-shrink: 0;
        display: inline-grid;
        place-items: center;
        width: 22px;
        height: 22px;
        border-radius: 4px;
        color: var(--text-tertiary);
        opacity: 0.5;
        transition: opacity var(--transition-fast), color var(--transition-fast), transform 120ms ease-out;
    }
    .cal-li:hover .default-pin { opacity: 1; }
    .default-pin:hover { color: var(--accent-text); transform: scale(1.08); }
    .default-pin.active {
        color: var(--star);
        opacity: 1;
        filter:
            drop-shadow(0 0 3px color-mix(in srgb, var(--star) 70%, transparent))
            drop-shadow(0 0 8px color-mix(in srgb, var(--star) 35%, transparent));
    }
    .delete-sub:hover { color: var(--danger); }
    .google-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border-radius: 3px;
        background: #fff;
        color: #4285f4;
        font-size: 9px;
        font-weight: 700;
        line-height: 1;
        flex-shrink: 0;
        border: 1px solid #ddd;
    }
    :global(.sub-icon) {
        color: var(--text-tertiary);
        flex-shrink: 0;
    }
    .empty-sub {
        font-size: 12px;
        color: var(--text-tertiary);
        padding: 4px 6px;
        font-style: italic;
    }

    /* Context menu */
    .ctx-menu {
        list-style: none;
        margin: 0;
        padding: 4px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        min-width: 160px;
    }
    .ctx-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 10px;
        font-size: 13px;
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        text-align: left;
    }
    .ctx-item:hover { background: var(--bg-hover); }

    /* Subscription modal */
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
        width: min(420px, 100%);
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
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field > span { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-tertiary); }
    .field input[type=text], .field input[type=url] {
        padding: 7px 10px;
        font-size: 13px;
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-family: inherit;
    }
    .color-grid { display: flex; flex-wrap: wrap; gap: 6px; }
    .color-grid .swatch {
        width: 24px; height: 24px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
    }
    .color-grid .swatch.sel { border-color: var(--accent); }
    .foot {
        display: flex; justify-content: flex-end; align-items: center; gap: 6px;
        padding: 12px 18px;
        border-top: 1px solid var(--border-subtle);
        background: var(--bg-surface-alt);
    }
    .btn {
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 500;
        border-radius: var(--radius-sm);
        cursor: pointer;
    }
    .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid transparent;
    }
    .btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
    .btn-primary {
        background: var(--accent);
        color: var(--accent-on);
        border: 1px solid var(--accent);
    }
    .btn-primary:hover { filter: brightness(1.05); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary.copied { background: var(--success, #16a34a); border-color: var(--success, #16a34a); }
    .danger-ghost { color: var(--danger); }
    .danger-ghost:hover { background: var(--danger-soft); }
    .warn-banner {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--warning, #d97706) 12%, var(--bg-surface-alt));
        border: 1px solid color-mix(in srgb, var(--warning, #d97706) 35%, var(--border-subtle));
        border-radius: 10px;
        font-size: 12.5px;
        color: var(--text-primary);
    }
    .warn-banner :global(svg) { color: var(--warning, #d97706); flex-shrink: 0; margin-top: 1px; }
    .url-row { display: flex; gap: 6px; }
    .url-row input {
        flex: 1;
        font-family: var(--font-mono);
        font-size: 11.5px;
        word-break: break-all;
    }
    .meta-row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0 0; }
    .err { color: var(--danger); margin: 0; font-size: 12.5px; }
</style>
