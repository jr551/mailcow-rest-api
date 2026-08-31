<script lang="ts">
    import Icon from './Icon.svelte';
    import { runSetupDiagnostics, setupIsBlocking, setupDiagnostics, type SetupCheckStatus } from '../lib/setup-diagnostics.svelte';

    const statusIcon = (status: SetupCheckStatus) => {
        if (status === 'ok') return 'check';
        if (status === 'warn') return 'alertCircle';
        if (status === 'fail') return 'cloudOff';
        return 'refreshCw';
    };

    const statusText = (status: SetupCheckStatus) => {
        if (status === 'ok') return 'OK';
        if (status === 'warn') return 'Check';
        if (status === 'fail') return 'Failed';
        return 'Pending';
    };
</script>

{#if setupIsBlocking()}
    <main class="setup-page" aria-labelledby="setup-title" data-testid="setup-diagnostics">
        <section class="setup-panel">
            <div class="setup-mark" aria-hidden="true">
                <Icon name="settings" size={28} />
            </div>
            <div class="setup-copy">
                <p class="eyebrow">Setup check</p>
                <h1 id="setup-title">Webmail cannot reach the API yet</h1>
                <p class="muted">
                    This static frontend is loading from <strong>{setupDiagnostics.origin}</strong>, but one or more required API routes are not reachable on the same origin.
                </p>
            </div>

            <div class="setup-grid">
                {#each setupDiagnostics.checks as check (check.id)}
                    <article class={`setup-check ${check.status}`}>
                        <div class="check-head">
                            <span class="check-icon">
                                <Icon name={statusIcon(check.status)} size={15} />
                            </span>
                            <div>
                                <strong>{check.label}</strong>
                                <code>{check.path}</code>
                            </div>
                            <span class="check-status">{statusText(check.status)}</span>
                        </div>
                        <p>{check.detail}</p>
                        {#if check.status !== 'ok'}
                            <p class="fix">{check.fix}</p>
                        {/if}
                    </article>
                {/each}
            </div>

            <div class="setup-actions">
                <button type="button" class="btn btn-primary" onclick={runSetupDiagnostics} disabled={setupDiagnostics.running}>
                    <Icon name="refreshCw" size={14} />
                    {setupDiagnostics.running ? 'Checking…' : 'Run checks again'}
                </button>
                <a class="btn btn-secondary" href="https://github.com/jr551/mailcow-rest-api-webmail#quick-start" target="_blank" rel="noopener">
                    <Icon name="bookText" size={14} />
                    Setup guide
                </a>
            </div>

            <pre class="route-example">/v1/*          -> mailcow-rest-api
/health        -> mailcow-rest-api
/openapi.json  -> mailcow-rest-api
/webmail/*     -> this static webmail</pre>
        </section>
    </main>
{/if}

<style>
    .setup-page {
        min-height: 100vh;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
            linear-gradient(140deg, color-mix(in srgb, var(--bg-base) 94%, var(--accent)) 0%, var(--bg-base) 58%),
            var(--bg-base);
    }
    .setup-panel {
        width: min(760px, 100%);
        padding: 28px;
        background: var(--bg-elevated);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
    }
    .setup-mark {
        width: 52px;
        height: 52px;
        display: grid;
        place-items: center;
        border-radius: 14px;
        color: var(--accent-text);
        background: color-mix(in srgb, var(--accent) 14%, var(--bg-surface));
        border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border-subtle));
        margin-bottom: 14px;
    }
    .setup-copy h1 {
        margin: 0 0 8px;
        font-size: 24px;
        line-height: 1.15;
    }
    .setup-copy p { margin: 0 0 18px; }
    .eyebrow {
        margin: 0 0 6px;
        color: var(--accent-text);
        font-weight: 700;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }
    .setup-grid {
        display: grid;
        gap: 10px;
        margin: 18px 0;
    }
    .setup-check {
        padding: 14px;
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        background: var(--bg-surface);
    }
    .setup-check.ok { border-color: color-mix(in srgb, var(--success) 45%, var(--border-subtle)); }
    .setup-check.warn { border-color: color-mix(in srgb, var(--warning) 45%, var(--border-subtle)); }
    .setup-check.fail { border-color: color-mix(in srgb, var(--danger) 45%, var(--border-subtle)); }
    .check-head {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
    }
    .check-icon {
        width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        color: var(--accent-text);
        background: var(--accent-soft);
    }
    .setup-check.fail .check-icon { color: var(--danger); background: var(--danger-soft); }
    .setup-check.warn .check-icon { color: var(--warning); background: var(--warning-soft); }
    .setup-check.ok .check-icon { color: var(--success); background: var(--success-soft); }
    .check-head strong { display: block; font-size: 13.5px; }
    .check-head code { display: block; color: var(--text-tertiary); font-size: 12px; margin-top: 1px; }
    .check-status {
        font-size: 12px;
        font-weight: 700;
        color: var(--text-secondary);
    }
    .setup-check p {
        margin: 10px 0 0;
        color: var(--text-secondary);
        font-size: 13px;
    }
    .setup-check .fix {
        color: var(--text-primary);
        font-weight: 600;
    }
    .setup-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
    }
    .route-example {
        margin: 18px 0 0;
        padding: 12px 14px;
        overflow-x: auto;
        background: var(--bg-input);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        color: var(--text-secondary);
        font-size: 12px;
    }
    @media (max-width: 620px) {
        .setup-page { padding: 14px; }
        .setup-panel { padding: 20px; }
        .setup-copy h1 { font-size: 21px; }
        .check-head { grid-template-columns: auto minmax(0, 1fr); }
        .check-status { grid-column: 2; }
    }
</style>
