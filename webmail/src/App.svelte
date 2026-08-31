<script lang="ts">
    import { authState, adoptHandoffSession, hasHandoff } from './lib/auth.svelte';
    import { doctor, installErrorDoctor } from './lib/error-doctor.svelte';
    import { setupIsBlocking, startSetupDiagnostics } from './lib/setup-diagnostics.svelte';
    import { startServerHealthPolling } from './lib/server-health.svelte';
    import Login from './components/Login.svelte';
    import Layout from './components/Layout.svelte';
    import MaintenanceOverlay from './components/MaintenanceOverlay.svelte';
    import SetupDiagnostics from './components/SetupDiagnostics.svelte';

    installErrorDoctor();
    startSetupDiagnostics();
    startServerHealthPolling();

    // Arriving from the mailcow login page's handoff button. Hold the login
    // form back until the token has been checked, or the user would see a
    // flash of the sign-in screen and could start typing into it.
    const handoff = $state({ pending: hasHandoff() });
    if (handoff.pending) {
        adoptHandoffSession().finally(() => { handoff.pending = false; });
    }
</script>

{#if authState.activeUser}
    <Layout />
{/if}
{#if handoff.pending}
    <div class="handoff-wait" role="status">Signing you in…</div>
{:else if !authState.activeUser && setupIsBlocking()}
    <SetupDiagnostics />
{:else if !authState.activeUser || authState.addingAccount}
    <Login />
{/if}

{#if !handoff.pending && doctor.incident}
    {#await import('./components/ErrorDoctor.svelte') then mod}
        <mod.default />
    {/await}
{/if}
<MaintenanceOverlay />

<style>
    .handoff-wait {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-base, #f4f5f7);
        color: var(--text-secondary, #555);
        font: 14px/1.4 system-ui, sans-serif;
        z-index: 50;
    }
</style>
