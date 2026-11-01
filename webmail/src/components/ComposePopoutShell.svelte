<script lang="ts">
    import Compose from './Compose.svelte';
    import {
        composePopoutSessionId,
        consumeComposePopoutSession,
        broadcastComposePopoutClosed
    } from '../lib/compose-popout';
    import { ui } from '../lib/store.svelte';

    const sessionId = composePopoutSessionId();
    const session = sessionId ? consumeComposePopoutSession(sessionId) : null;

    if (session) {
        ui.composeContext = session.composeContext;
        ui.composeOpen = true;
    }

    function closePopout() {
        if (sessionId) broadcastComposePopoutClosed(sessionId);
        window.close();
    }
</script>

{#if session}
    <div class="popout-root" data-testid="compose-popout-shell">
        <Compose onClose={closePopout} popout popoutSessionId={sessionId} />
    </div>
{:else}
    <main class="popout-missing" data-testid="compose-popout-missing">
        <p>This compose window expired or was already opened.</p>
        <p class="hint">Return to the main mail tab to continue writing.</p>
    </main>
{/if}

<style>
    .popout-root {
        min-height: 100vh;
        min-height: 100dvh;
        background: var(--bg-base, #f4f5f7);
    }
    .popout-missing {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 2rem;
        font: 14px/1.5 system-ui, sans-serif;
        color: var(--text-secondary, #555);
        text-align: center;
    }
    .hint {
        font-size: 13px;
        opacity: 0.85;
    }
</style>
