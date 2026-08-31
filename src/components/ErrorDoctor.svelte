<script lang="ts">
    // Critical-error modal: shows the incident, asks the LLM for a plain-English
    // diagnosis, and gives the user one-click recovery (soft-restart or page refresh).

    import Icon from './Icon.svelte';
    import { doctor, dismissIncident, refreshPage, softRestart, isSuppressed, setSuppressed } from '../lib/error-doctor.svelte';

    function statusLabel(status?: number): string {
        if (status === undefined) return '';
        const map: Record<number, string> = {
            400: 'Bad Request',
            401: 'Unauthorized',
            403: 'Forbidden',
            404: 'Not Found',
            500: 'Internal Server Error',
            502: 'Bad Gateway',
            503: 'Service Unavailable',
            504: 'Gateway Timeout'
        };
        return map[status] || `HTTP ${status}`;
    }

    function typeIcon(type: string): string {
        switch (type) {
            case 'api': return 'cloud-off';
            case 'network': return 'wifi-off';
            case 'promise': return 'alert-circle';
            default: return 'bug';
        }
    }

    function typeLabel(type: string): string {
        switch (type) {
            case 'api': return 'Server error';
            case 'network': return 'Network error';
            case 'promise': return 'App error';
            default: return 'Unexpected error';
        }
    }

    $effect(() => {
        if (doctor.incident) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    });

    let suppressChecked = $state(isSuppressed());
    function onSuppressChange(checked: boolean) {
        suppressChecked = checked;
        setSuppressed(checked);
    }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && doctor.incident) dismissIncident(); }} />

{#if doctor.incident}
    {@const i = doctor.incident}
    <div
        class="overlay"
        onclick={(e) => { if (e.target === e.currentTarget) dismissIncident(); }}
        role="presentation"
    >
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="doc-title">
            <header class="head">
                <div class="title-row">
                    <div class="badge {i.type}">
                        <Icon name={typeIcon(i.type) as import('../lib/icons').IconName} size={14} />
                    </div>
                    <h2 id="doc-title">{typeLabel(i.type)}</h2>
                </div>
                <button type="button" class="btn-close" aria-label="Close" onclick={dismissIncident}>
                    <Icon name="close" size={16} />
                </button>
            </header>

            <div class="body">
                <div class="error-card">
                    {#if i.message}
                        <p class="error-message">{i.message}</p>
                    {/if}
                    {#if i.status}
                        <span class="pill">{statusLabel(i.status)}</span>
                    {/if}
                    {#if i.url}
                        <code class="url">{i.url}</code>
                    {/if}
                    {#if i.detail && i.detail.includes(') [')}
                        <div class="error-list">
                            {#each i.detail.split('\n').filter(Boolean) as line}
                                <p class="error-line">{line}</p>
                            {/each}
                        </div>
                    {:else if i.detail}
                        <p class="error-detail">{i.detail}</p>
                    {/if}
                </div>

                {#if i.diagnosisLoading}
                    <div class="diagnosis loading">
                        <span class="spinner"></span>
                        <span class="muted">Diagnosing with AI…</span>
                    </div>
                {:else if i.diagnosis}
                    <div class="diagnosis">
                        <div class="diagnosis-head">
                            <Icon name="sparkles" size={14} />
                            <span>AI Diagnosis</span>
                        </div>
                        <p class="diagnosis-text">{i.diagnosis}</p>
                    </div>
                {/if}

                <div class="actions">
                    <button type="button" class="btn btn-primary" onclick={softRestart}>
                        <Icon name="refreshCw" size={14} />
                        Restart
                    </button>
                    <button type="button" class="btn btn-secondary" onclick={refreshPage}>
                        <Icon name="rotateCcw" size={14} />
                        Refresh Page
                    </button>
                </div>

                <label class="suppress-row">
                    <input
                        type="checkbox"
                        checked={suppressChecked}
                        onchange={(e) => onSuppressChange((e.currentTarget as HTMLInputElement).checked)}
                    />
                    <span>Don't show error dialogs again</span>
                </label>
            </div>
        </div>
    </div>
{/if}

<style>
    .overlay {
        position: fixed; inset: 0;
        background: color-mix(in srgb, var(--bg-base) 55%, transparent);
        display: flex; align-items: center; justify-content: center;
        padding: 20px; z-index: 70;
        backdrop-filter: blur(12px) saturate(1.2);
        -webkit-backdrop-filter: blur(12px) saturate(1.2);
    }
    .dialog {
        background: var(--bg-surface);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(520px, 100%);
        max-height: calc(100vh - 40px);
        display: flex; flex-direction: column;
        overflow: hidden;
        animation: dialogIn 0.2s ease-out;
    }
    @keyframes dialogIn {
        from { opacity: 0; transform: translateY(12px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 18px;
        border-bottom: 1px solid var(--border-subtle);
    }
    .title-row {
        display: flex; align-items: center; gap: 10px;
    }
    .head h2 { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
    .badge {
        width: 26px; height: 26px;
        border-radius: var(--radius-md);
        display: flex; align-items: center; justify-content: center;
        color: #fff;
        flex-shrink: 0;
    }
    .badge.api      { background: var(--danger); }
    .badge.network  { background: #d18c1d; }
    .badge.promise  { background: #8b5cf6; }
    .badge.javascript { background: var(--danger); }
    .btn-close {
        background: transparent; border: none; padding: 4px;
        color: var(--text-secondary); cursor: pointer;
        border-radius: var(--radius-sm);
        display: flex; align-items: center; justify-content: center;
    }
    .btn-close:hover { background: var(--bg-hover); color: var(--text-primary); }

    .body {
        padding: 18px;
        overflow-y: auto;
        display: flex; flex-direction: column; gap: 16px;
    }
    .error-card {
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        padding: 14px;
        display: flex; flex-direction: column; gap: 8px;
    }
    .error-message {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        word-break: break-word;
    }
    .pill {
        display: inline-flex;
        align-self: flex-start;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        border-radius: var(--radius-sm);
        background: var(--danger-soft);
        color: var(--danger);
    }
    .url {
        font-size: 11px;
        color: var(--text-tertiary);
        word-break: break-all;
        background: transparent;
        padding: 0;
    }

    .diagnosis {
        border-left: 3px solid var(--accent);
        padding-left: 12px;
    }
    .diagnosis.loading {
        display: flex; align-items: center; gap: 10px;
        border-left-color: var(--border-subtle);
        color: var(--text-secondary);
        font-size: 13px;
    }
    .diagnosis-head {
        display: flex; align-items: center; gap: 6px;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--accent);
        margin-bottom: 6px;
    }
    .diagnosis-text {
        margin: 0;
        font-size: 13px;
        line-height: 1.55;
        color: var(--text-secondary);
        white-space: pre-wrap;
    }

    .spinner {
        width: 14px; height: 14px;
        border: 2px solid var(--border-subtle);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
        display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .actions {
        display: flex; gap: 10px;
        padding-top: 4px;
    }
    .suppress-row {
        display: flex; align-items: center; gap: 8px;
        font-size: 12px;
        color: var(--text-tertiary);
        cursor: pointer;
        padding-top: 2px;
    }
    .suppress-row input { accent-color: var(--accent); }
    .suppress-row span { user-select: none; }
    .btn {
        flex: 1;
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        padding: 10px 14px;
        font-size: 13px; font-weight: 600;
        border-radius: var(--radius-md);
        border: 1px solid transparent;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
    }
    .btn-primary {
        background: var(--accent);
        color: #fff;
    }
    .btn-primary:hover { filter: brightness(1.08); }
    .btn-secondary {
        background: var(--bg-base);
        border-color: var(--border-subtle);
        color: var(--text-primary);
    }
    .btn-secondary:hover { background: var(--bg-hover); }
    .error-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 4px;
    }
    .error-line {
        margin: 0;
        font-size: 12px;
        color: var(--text-secondary);
        word-break: break-word;
        line-height: 1.4;
    }
    .error-detail {
        margin: 0;
        font-size: 12px;
        color: var(--text-secondary);
        word-break: break-word;
    }
</style>
