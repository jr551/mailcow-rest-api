<script lang="ts">
    import { authState } from './lib/auth.svelte';
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
</script>

{#if authState.activeUser}
    <Layout />
{/if}
{#if !authState.activeUser && setupIsBlocking()}
    <SetupDiagnostics />
{:else if !authState.activeUser || authState.addingAccount}
    <Login />
{/if}

{#if doctor.incident}
    {#await import('./components/ErrorDoctor.svelte') then mod}
        <mod.default />
    {/await}
{/if}
<MaintenanceOverlay />
