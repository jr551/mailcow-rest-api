<script lang="ts">
    // Glossy modal that surfaces an LLM-generated inbox briefing:
    // one-paragraph summary + severity-coloured action list + bulk
    // action bar so the user can triage by checkbox instead of one
    // message at a time.

    import Icon from './Icon.svelte';
    import { summarizeInbox, summaryToHtml, type InboxSummaryResult, type InboxMessageInput, type Severity } from '../lib/inbox-summary';
    import { sendStub } from '../lib/api';
    import { showToast } from '../lib/store.svelte';
    import { authState } from '../lib/auth.svelte';

    interface Props {
        messages: InboxMessageInput[];
        onClose: () => void;
        onJumpToUid?: (uid: number) => void;
        onArchiveSelected?: (uids: number[]) => Promise<void> | void;
        onTrashSelected?: (uids: number[]) => Promise<void> | void;
        onMarkReadSelected?: (uids: number[]) => Promise<void> | void;
        onStarSelected?: (uids: number[]) => Promise<void> | void;
        /** Open the AI chat with a draft reply already streaming for the
         *  given uid. Only rendered on actions where canAutoReply is true. */
        onAutoReply?: (uid: number, label: string) => void;
    }
    let {
        messages,
        onClose,
        onJumpToUid,
        onArchiveSelected,
        onTrashSelected,
        onMarkReadSelected,
        onStarSelected,
        onAutoReply
    }: Props = $props();

    let canBulk = $derived(!!(onArchiveSelected || onTrashSelected || onMarkReadSelected || onStarSelected));

    let result = $state<InboxSummaryResult | null>(null);
    let error = $state<string | null>(null);
    let loading = $state(true);
    let sending = $state(false);
    let processing = $state(false);
    let progressLabel = $state('Reading inbox…');
    let progressDone = $state(0);
    let progressTotal = $state(0);
    let abort = new AbortController();

    let selected = $state<Set<number>>(new Set());
    // Per-action lifecycle state (keyed by refUid). "done" = user
    // ticked off the action, "ignored" = user dismissed it. Both
    // states fade the row out and exclude it from bulk operations
    // until the user resets that action or the briefing reloads.
    let actionDone = $state<Set<number>>(new Set());
    let actionIgnored = $state<Set<number>>(new Set());

    function toggleDone(uid?: number) {
        if (typeof uid !== 'number') return;
        const next = new Set(actionDone);
        if (next.has(uid)) next.delete(uid); else next.add(uid);
        actionDone = next;
        // Done actions fall out of bulk selection so a click-trash
        // doesn't accidentally re-trash an already-handled email.
        if (next.has(uid)) {
            const sel = new Set(selected);
            sel.delete(uid);
            selected = sel;
        }
    }
    function toggleIgnored(uid?: number) {
        if (typeof uid !== 'number') return;
        const next = new Set(actionIgnored);
        if (next.has(uid)) next.delete(uid); else next.add(uid);
        actionIgnored = next;
        if (next.has(uid)) {
            const sel = new Set(selected);
            sel.delete(uid);
            selected = sel;
        }
    }
    function resetAction(uid?: number) {
        if (typeof uid !== 'number') return;
        const d = new Set(actionDone);
        const ig = new Set(actionIgnored);
        d.delete(uid);
        ig.delete(uid);
        actionDone = d;
        actionIgnored = ig;
    }

    // Bucket by category first (operational vs marketing); within each
    // bucket order red → green so the urgent stuff sits at the top.
    const sevOrder: Record<Severity, number> = { red: 0, orange: 1, yellow: 2, green: 3 };
    let operationalActions = $derived(
        (result?.actions.filter((a) => (a.category ?? 'operational') !== 'marketing') ?? [])
            .slice().sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])
    );
    let marketingActions = $derived(
        (result?.actions.filter((a) => a.category === 'marketing') ?? [])
            .slice().sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])
    );

    // Only actions with a refUid can be bulk-operated on
    let actionableUids = $derived(
        (result?.actions ?? []).filter((a) => typeof a.refUid === 'number').map((a) => a.refUid!)
    );
    let selectedCount = $derived(selected.size);
    let allActionableSelected = $derived(
        actionableUids.length > 0 && actionableUids.every((uid) => selected.has(uid))
    );

    async function run() {
        loading = true;
        error = null;
        result = null;
        selected = new Set();
        progressDone = 0;
        progressTotal = 0;
        progressLabel = 'Reading inbox…';
        abort = new AbortController();
        try {
            result = await summarizeInbox(messages, {
                signal: abort.signal,
                onProgress: (p) => {
                    progressDone = p.done;
                    progressTotal = p.total;
                    progressLabel = p.label;
                }
            });
        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            error = (err as Error).message || 'Could not generate summary.';
        } finally {
            loading = false;
        }
    }

    $effect(() => {
        run();
        return () => abort.abort();
    });

    function toggleUid(uid?: number) {
        if (typeof uid !== 'number') return;
        const next = new Set(selected);
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
        selected = next;
    }

    function toggleSelectAll() {
        if (allActionableSelected) {
            selected = new Set();
        } else {
            selected = new Set(actionableUids);
        }
    }

    function severityLabel(s: Severity): string {
        return ({ red: 'Act now', orange: 'This week', yellow: 'Soon', green: 'Info' } as Record<Severity, string>)[s];
    }

    async function emailToSelf() {
        if (!result || sending) return;
        const me = authState.activeUser;
        if (!me) {
            showToast('error', 'No active session — cannot send.');
            return;
        }
        sending = true;
        try {
            const html = summaryToHtml(result);
            await sendStub({
                to: [me],
                subject: `Inbox briefing — ${new Date().toLocaleDateString()}`,
                html,
                text: result.summary + '\n\n' + result.actions.map((a) => `[${a.severity.toUpperCase()}] ${a.label} — ${a.detail}`).join('\n')
            });
            showToast('success', 'Briefing emailed to ' + me);
        } catch (err) {
            showToast('error', (err as Error).message || 'Could not send.');
        } finally {
            sending = false;
        }
    }

    async function bulkArchive() {
        if (!onArchiveSelected || !selectedCount || processing) return;
        processing = true;
        try {
            await onArchiveSelected([...selected]);
            showToast('success', `Archived ${selectedCount} messages`);
            removeSelectedFromView();
        } catch (err) {
            showToast('error', (err as Error).message || 'Archive failed.');
        } finally {
            processing = false;
        }
    }

    async function bulkTrash() {
        if (!onTrashSelected || !selectedCount || processing) return;
        processing = true;
        try {
            await onTrashSelected([...selected]);
            showToast('success', `Moved ${selectedCount} messages to trash`);
            removeSelectedFromView();
        } catch (err) {
            showToast('error', (err as Error).message || 'Trash failed.');
        } finally {
            processing = false;
        }
    }

    async function bulkMarkRead() {
        if (!onMarkReadSelected || !selectedCount || processing) return;
        processing = true;
        try {
            await onMarkReadSelected([...selected]);
            showToast('success', `Marked ${selectedCount} messages as read`);
            // Don't remove from view — just clear selection
            selected = new Set();
        } catch (err) {
            showToast('error', (err as Error).message || 'Mark read failed.');
        } finally {
            processing = false;
        }
    }

    async function bulkStar() {
        if (!onStarSelected || !selectedCount || processing) return;
        processing = true;
        try {
            await onStarSelected([...selected]);
            showToast('success', `Starred ${selectedCount} messages`);
            selected = new Set();
        } catch (err) {
            showToast('error', (err as Error).message || 'Star failed.');
        } finally {
            processing = false;
        }
    }

    /** After archive/trash, strip the acted-on actions from the briefing
     *  so the user sees immediate feedback. */
    function removeSelectedFromView() {
        if (!result) return;
        const gone = new Set(selected);
        result = {
            ...result,
            actions: result.actions.filter((a) => !(typeof a.refUid === 'number' && gone.has(a.refUid)))
        };
        selected = new Set();
    }

    function close() {
        abort.abort();
        onClose();
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') close();
    }
</script>

<svelte:window on:keydown={onKey} />

<div class="scrim" role="presentation" onclick={close}>
    <div
        class="card glossy"
        role="dialog"
        aria-modal="true"
        aria-label="Inbox briefing"
        onclick={(e) => e.stopPropagation()}
        data-testid="inbox-summary-modal"
    >
        <header class="head">
            <div class="title">
                <Icon name="sparkles" size={16} />
                <span>Inbox briefing</span>
                <span class="muted small">{messages.length} messages</span>
            </div>
            <button type="button" class="close" onclick={close} aria-label="Close briefing">
                <Icon name="close" size={14} />
            </button>
        </header>

        <div class="body">
            {#if loading}
                <div class="state shimmer" aria-live="polite" data-testid="briefing-progress">
                    <div class="shim-row" style="width: 92%;"></div>
                    <div class="shim-row" style="width: 78%;"></div>
                    <div class="shim-row" style="width: 65%;"></div>
                    <div class="shim-spacer"></div>
                    <div class="shim-row" style="width: 50%;"></div>
                    <div class="shim-row" style="width: 70%;"></div>
                    <div class="shim-row" style="width: 60%;"></div>
                    {#if progressTotal > 0}
                        <div class="briefing-progress">
                            <div
                                class="briefing-progress-bar"
                                style="width: {Math.round((progressDone / progressTotal) * 100)}%"
                            ></div>
                        </div>
                        <p class="muted small">{progressLabel} ({progressDone}/{progressTotal} pages)</p>
                    {:else}
                        <p class="muted small">{progressLabel}</p>
                    {/if}
                </div>
            {:else if error}
                <div class="state error" role="alert">
                    <p>{error}</p>
                    <button type="button" class="btn btn-ghost" onclick={run}>
                        <Icon name="refresh" size={13} /> Try again
                    </button>
                </div>
            {:else if result}
                {#each result.summary.split(/\n{2,}/) as para, i (i)}
                    <p class="summary" class:second-para={i > 0}>{para}</p>
                {/each}

                {#if canBulk && actionableUids.length > 0}
                    <div class="bulk-hint">
                        <label class="select-all">
                            <input
                                type="checkbox"
                                checked={allActionableSelected}
                                indeterminate={selectedCount > 0 && !allActionableSelected}
                                onchange={toggleSelectAll}
                            />
                            <span class="muted small">
                                {selectedCount > 0 ? `${selectedCount} selected` : 'Select all'}
                            </span>
                        </label>
                    </div>
                {/if}

                {#if operationalActions.length}
                    <h4 class="section-h">
                        <Icon name="bell" size={11} />
                        Operational — needs you
                    </h4>
                    <ul class="actions">
                        {#each operationalActions as a, i (i)}
                            <li
                                class={`action sev-${a.severity}`}
                                class:selected={typeof a.refUid === 'number' && selected.has(a.refUid)}
                                class:action-done={typeof a.refUid === 'number' && actionDone.has(a.refUid)}
                                class:action-ignored={typeof a.refUid === 'number' && actionIgnored.has(a.refUid)}
                                data-testid={`inbox-action-${i}`}
                            >
                                {#if canBulk}
                                    <span class="check-wrap">
                                        <input
                                            type="checkbox"
                                            checked={typeof a.refUid === 'number' && selected.has(a.refUid)}
                                            disabled={typeof a.refUid !== 'number'}
                                            onchange={() => toggleUid(a.refUid)}
                                            onclick={(e) => e.stopPropagation()}
                                        />
                                    </span>
                                {/if}
                                <span class="sev-pill" aria-hidden="true">{severityLabel(a.severity)}</span>
                                <div
                                    class="action-main"
                                    role={a.refUid && onJumpToUid ? 'button' : undefined}
                                    tabindex={a.refUid && onJumpToUid ? 0 : -1}
                                    onclick={() => a.refUid && onJumpToUid?.(a.refUid)}
                                    onkeydown={(e) => {
                                        if (a.refUid && onJumpToUid && (e.key === 'Enter' || e.key === ' ')) {
                                            e.preventDefault();
                                            onJumpToUid(a.refUid);
                                        }
                                    }}
                                >
                                    <span class="label">{a.label}</span>
                                    <span class="detail muted small">{a.detail}</span>
                                </div>
                                {#if a.canAutoReply && typeof a.refUid === 'number' && onAutoReply && !actionDone.has(a.refUid) && !actionIgnored.has(a.refUid)}
                                    <button
                                        type="button"
                                        class="auto-reply-btn"
                                        title="Draft an AI reply for this email"
                                        onclick={(e) => { e.stopPropagation(); onAutoReply!(a.refUid!, a.label); }}
                                        data-testid={`inbox-action-autoreply-${i}`}
                                    >
                                        <Icon name="sparkles" size={11} /> AI reply
                                    </button>
                                {/if}
                                {#if typeof a.refUid === 'number'}
                                    {@const _uid = a.refUid}
                                    {@const isDone = actionDone.has(_uid)}
                                    {@const isIgnored = actionIgnored.has(_uid)}
                                    {#if isDone || isIgnored}
                                        <button
                                            type="button"
                                            class="action-tick reset"
                                            title="Reset — bring this action back"
                                            onclick={(e) => { e.stopPropagation(); resetAction(_uid); }}
                                            data-testid={`inbox-action-reset-${i}`}
                                        >↺</button>
                                    {:else}
                                        <button
                                            type="button"
                                            class="action-tick done"
                                            title="Mark as handled"
                                            onclick={(e) => { e.stopPropagation(); toggleDone(_uid); }}
                                            data-testid={`inbox-action-done-${i}`}
                                        >✓</button>
                                        <button
                                            type="button"
                                            class="action-tick ignore"
                                            title="Ignore — hide this from the briefing"
                                            onclick={(e) => { e.stopPropagation(); toggleIgnored(_uid); }}
                                            data-testid={`inbox-action-ignore-${i}`}
                                        >✕</button>
                                    {/if}
                                {/if}
                                {#if a.refUid && onJumpToUid}
                                    <Icon name="chevronRight" size={12} />
                                {/if}
                            </li>
                        {/each}
                    </ul>
                {/if}

                {#if marketingActions.length || result.marketingSummary}
                    <h4 class="section-h info-h">
                        <Icon name="info" size={11} />
                        Marketing &amp; newsletters
                    </h4>
                    {#if result.marketingSummary}
                        <p class="marketing-summary muted small">{result.marketingSummary}</p>
                    {/if}
                    {#if marketingActions.length}
                        <ul class="info-list">
                            {#each marketingActions as a, i (i)}
                                <li
                                    class="info-row"
                                    class:selected={typeof a.refUid === 'number' && selected.has(a.refUid)}
                                    data-testid={`inbox-info-${i}`}
                                >
                                    {#if canBulk}
                                        <span class="check-wrap">
                                            <input
                                                type="checkbox"
                                                checked={typeof a.refUid === 'number' && selected.has(a.refUid)}
                                                disabled={typeof a.refUid !== 'number'}
                                                onchange={() => toggleUid(a.refUid)}
                                                onclick={(e) => e.stopPropagation()}
                                            />
                                        </span>
                                    {/if}
                                    <span class="info-dot" aria-hidden="true"></span>
                                    <div
                                        class="info-main"
                                        role={a.refUid && onJumpToUid ? 'button' : undefined}
                                        tabindex={a.refUid && onJumpToUid ? 0 : -1}
                                        onclick={() => a.refUid && onJumpToUid?.(a.refUid)}
                                        onkeydown={(e) => {
                                            if (a.refUid && onJumpToUid && (e.key === 'Enter' || e.key === ' ')) {
                                                e.preventDefault();
                                                onJumpToUid(a.refUid);
                                            }
                                        }}
                                    >
                                        <span class="info-label truncate">{a.label}</span>
                                        <span class="info-detail truncate muted small">{a.detail}</span>
                                    </div>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                {/if}
            {/if}
        </div>

        <!-- Bulk action bar — floats above the normal footer when items selected -->
        {#if selectedCount > 0 && canBulk}
            <div class="bulk-bar">
                <span class="bulk-count">{selectedCount} selected</span>
                <div class="bulk-actions">
                    {#if onArchiveSelected}
                        <button type="button" class="btn btn-ghost" onclick={bulkArchive} disabled={processing} title="Archive selected">
                            <Icon name="archive" size={13} /> Archive
                        </button>
                    {/if}
                    {#if onTrashSelected}
                        <button type="button" class="btn btn-ghost" onclick={bulkTrash} disabled={processing} title="Move selected to trash">
                            <Icon name="trash" size={13} /> Trash
                        </button>
                    {/if}
                    {#if onMarkReadSelected}
                        <button type="button" class="btn btn-ghost" onclick={bulkMarkRead} disabled={processing} title="Mark selected as read">
                            <Icon name="mail" size={13} /> Mark read
                        </button>
                    {/if}
                    {#if onStarSelected}
                        <button type="button" class="btn btn-ghost" onclick={bulkStar} disabled={processing} title="Star selected">
                            <Icon name="star" size={13} /> Star
                        </button>
                    {/if}
                </div>
                <button type="button" class="btn btn-ghost" onclick={() => (selected = new Set())}>Clear</button>
            </div>
        {/if}

        <footer class="foot">
            <button type="button" class="btn btn-ghost" onclick={close}>Dismiss</button>
            <button
                type="button"
                class="btn btn-primary"
                onclick={emailToSelf}
                disabled={!result || sending || loading}
                data-testid="inbox-summary-email-self"
            >
                {#if sending}<span class="spinner"></span>{/if}
                <Icon name="mail" size={13} /> Email this to myself
            </button>
        </footer>
    </div>
</div>

<style>
    .scrim {
        position: fixed;
        inset: 0;
        background: rgba(20, 22, 30, 0.55);
        backdrop-filter: blur(4px);
        z-index: 200;
        display: grid;
        place-items: center;
        animation: fade-in 160ms ease-out;
    }
    .card {
        width: min(640px, calc(100vw - 32px));
        max-height: min(80vh, 720px);
        display: flex;
        flex-direction: column;
        border-radius: 18px;
        overflow: hidden;
        color: var(--text-primary);
    }
    .glossy {
        background:
            radial-gradient(120% 60% at 30% 0%, color-mix(in srgb, var(--accent) 14%, transparent) 0%, transparent 60%),
            radial-gradient(80% 50% at 100% 100%, color-mix(in srgb, var(--accent) 10%, transparent) 0%, transparent 60%),
            linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 92%, white) 0%, var(--bg-elevated) 60%);
        box-shadow:
            0 24px 64px rgba(0, 0, 0, 0.32),
            inset 0 1px 0 color-mix(in srgb, white 35%, transparent);
        border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-subtle));
    }
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border-subtle));
    }
    .title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
        font-size: 14.5px;
    }
    .close {
        width: 28px;
        height: 28px;
        display: inline-grid;
        place-items: center;
        border-radius: 8px;
        color: var(--text-secondary);
    }
    .close:hover { background: var(--bg-hover); color: var(--text-primary); }

    .body {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 16px 18px;
    }
    .summary {
        font-size: 14.5px;
        line-height: 1.6;
        margin: 0 0 14px;
    }

    .bulk-hint {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
    }
    .select-all {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        padding: 2px 6px;
        border-radius: var(--radius-xs);
    }
    .select-all:hover { background: var(--bg-hover); }
    .select-all input { width: 14px; height: 14px; accent-color: var(--accent); }

    .section-h {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        margin: 6px 0 8px;
    }
    .actions {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .action {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 10px;
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        transition: transform 120ms ease-out, box-shadow 120ms ease-out, background-color 120ms ease-out;
    }
    .action.selected {
        background: var(--accent-soft);
        border-color: color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent);
    }
    .action:hover { transform: translateY(-1px); box-shadow: var(--shadow-sm); }
    .action.action-done {
        opacity: 0.55;
        background: color-mix(in srgb, #22c55e 8%, var(--bg-surface));
        border-color: color-mix(in srgb, #22c55e 25%, var(--border-subtle));
    }
    .action.action-done .action-main { text-decoration: line-through; text-decoration-thickness: 1.5px; text-decoration-color: color-mix(in srgb, #22c55e 60%, transparent); }
    .action.action-ignored {
        opacity: 0.45;
        background: var(--bg-surface-alt);
        filter: grayscale(0.4);
    }
    .action-tick {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        background: var(--bg-surface-alt);
        border: 1px solid var(--border-subtle);
        border-radius: 999px;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
        transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    .action-tick:hover { transform: scale(1.08); }
    .action-tick.done {
        color: #126b35;
        border-color: color-mix(in srgb, #22c55e 35%, var(--border-subtle));
    }
    .action-tick.done:hover {
        background: color-mix(in srgb, #22c55e 15%, var(--bg-surface));
    }
    .action-tick.ignore {
        color: var(--text-tertiary);
    }
    .action-tick.ignore:hover {
        color: var(--danger, #d6515b);
        border-color: color-mix(in srgb, var(--danger, #d6515b) 35%, var(--border-subtle));
    }
    .action-tick.reset {
        color: var(--accent-text);
        border-color: color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
    }
    .summary.second-para {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px dashed var(--border-subtle);
        color: var(--text-secondary);
    }
    .check-wrap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }
    .check-wrap input {
        width: 16px;
        height: 16px;
        accent-color: var(--accent);
        cursor: pointer;
    }
    .check-wrap input:disabled { cursor: not-allowed; opacity: 0.4; }
    .action-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        cursor: pointer;
        outline: none;
        border-radius: var(--radius-xs);
        padding: 2px 0;
    }
    .action-main:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent); }
    .label { font-weight: 600; font-size: 13.5px; }
    .detail { font-size: 12px; }
    .sev-pill {
        flex-shrink: 0;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 4px 8px;
        border-radius: 999px;
        color: white;
        white-space: nowrap;
    }
    .sev-red    .sev-pill { background: linear-gradient(135deg, #ef4444, #b91c1c); }
    .sev-orange .sev-pill { background: linear-gradient(135deg, #fb923c, #c2410c); }
    .sev-yellow .sev-pill { background: linear-gradient(135deg, #eab308, #a16207); color: #1a1a1a; }
    .sev-green  .sev-pill { background: linear-gradient(135deg, #22c55e, #15803d); }
    .sev-red    { border-left: 3px solid #ef4444; }
    .sev-orange { border-left: 3px solid #fb923c; }
    .sev-yellow { border-left: 3px solid #eab308; }
    .sev-green  { border-left: 3px solid #22c55e; }

    .section-h.info-h {
        margin-top: 16px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        opacity: 0.7;
    }
    .info-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
        opacity: 0.78;
        background: color-mix(in srgb, var(--text-tertiary) 6%, transparent);
        border: 1px solid var(--border-subtle);
        border-radius: 8px;
        padding: 4px;
    }
    .info-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 8px;
        border-radius: 6px;
        font-size: 12px;
        color: var(--text-secondary);
        min-width: 0;
        transition: background-color 120ms ease-out;
    }
    .info-row.selected {
        background: var(--accent-soft);
        opacity: 1;
    }
    .info-row:hover { background: var(--bg-hover); opacity: 1; }
    .info-main {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        cursor: pointer;
        outline: none;
        border-radius: var(--radius-xs);
    }
    .info-main:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent); }
    .info-dot {
        flex-shrink: 0;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--text-tertiary) 60%, transparent);
    }
    .info-label { font-weight: 500; flex: 0 0 auto; max-width: 40%; }
    .info-detail { flex: 1; min-width: 0; }

    /* Floating bulk action bar */
    .bulk-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: linear-gradient(90deg,
            color-mix(in srgb, var(--accent-soft) 80%, transparent),
            color-mix(in srgb, var(--bg-elevated) 90%, transparent));
        border-top: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border-subtle));
        backdrop-filter: blur(4px);
        animation: slide-up 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .bulk-count {
        font-size: 12px;
        font-weight: 700;
        color: var(--accent-text);
        white-space: nowrap;
        min-width: 80px;
    }
    .bulk-actions {
        flex: 1;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
    }
    .bulk-actions .btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 6px 12px;
        font-size: 12.5px;
        border-radius: var(--radius-sm);
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        color: var(--text-primary);
        transition: background-color var(--transition-fast), transform 80ms ease;
    }
    .bulk-actions .btn:hover:not(:disabled) {
        background: var(--bg-hover);
        transform: translateY(-1px);
    }
    .bulk-actions .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 14px;
        border-top: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border-subtle));
        background: color-mix(in srgb, var(--bg-elevated) 60%, transparent);
    }

    .state { padding: 10px 0; }
    .state.error p { color: var(--danger); margin: 0 0 8px; }

    .shimmer { display: flex; flex-direction: column; gap: 10px; }
    .shim-row {
        height: 12px;
        border-radius: 6px;
        background: linear-gradient(90deg,
            color-mix(in srgb, var(--accent) 12%, var(--bg-surface)) 0%,
            color-mix(in srgb, var(--accent) 38%, var(--bg-surface)) 30%,
            color-mix(in srgb, #d268f4 32%, var(--bg-surface)) 50%,
            color-mix(in srgb, var(--accent) 38%, var(--bg-surface)) 70%,
            color-mix(in srgb, var(--accent) 12%, var(--bg-surface)) 100%);
        background-size: 220% 100%;
        animation: glass-shimmer 1.4s ease-in-out infinite;
        opacity: 0.85;
    }
    /* Each subsequent row staggers in slightly delayed for a livelier feel. */
    .shim-row:nth-child(2) { animation-delay: 0.08s; }
    .shim-row:nth-child(3) { animation-delay: 0.16s; }
    .shim-row:nth-child(5) { animation-delay: 0.24s; }
    .shim-row:nth-child(6) { animation-delay: 0.32s; }
    .shim-row:nth-child(7) { animation-delay: 0.40s; }
    .shim-spacer { height: 6px; }
    .briefing-progress {
        height: 6px;
        margin-top: 12px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--accent) 14%, transparent);
        overflow: hidden;
    }
    .briefing-progress-bar {
        height: 100%;
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #d268f4));
        box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 50%, transparent);
        border-radius: 999px;
        transition: width 200ms ease;
    }
    @keyframes glass-shimmer {
        0%   { background-position: 220% 0; }
        100% { background-position: -220% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
        .shim-row { animation: none; opacity: 0.4; }
    }

    /* Auto-reply pill that sits at the right of an action row. */
    .auto-reply-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 9px;
        font-size: 11px;
        font-weight: 600;
        color: var(--accent-text);
        background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface));
        border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        border-radius: 999px;
        cursor: pointer;
        transition: background 120ms ease, transform 80ms ease;
        flex-shrink: 0;
    }
    .auto-reply-btn:hover {
        background: color-mix(in srgb, var(--accent) 24%, var(--bg-surface));
    }
    .auto-reply-btn:active { transform: scale(0.96); }

    /* Marketing summary prose sits above the marketing list. */
    .marketing-summary {
        margin: 4px 0 8px;
        font-style: italic;
    }
    @keyframes fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
    }
    @keyframes slide-up {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
    }
</style>
