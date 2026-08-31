<script lang="ts">
    import { onMount } from 'svelte';
    import { getDriveQuota, type DriveQuota } from '../../lib/api';

    let quota = $state<DriveQuota | null>(null);

    async function load() {
        try {
            quota = await getDriveQuota();
        } catch {
            // silently fail — quota is non-critical
        }
    }

    onMount(() => {
        load();
        const timer = setInterval(load, 60_000);
        return () => clearInterval(timer);
    });

    function formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
    }

    const percent = $derived(quota && quota.total > 0 ? Math.min((quota.used / quota.total) * 100, 100) : 0);
    const color = $derived(percent > 90 ? 'var(--danger)' : percent > 75 ? 'var(--warning)' : 'var(--accent)');
</script>

{#if quota}
    <div class="quota" data-testid="drive-quota" title="{formatBytes(quota.used)} of {formatBytes(quota.total)} used">
        <div class="bar-bg">
            <div class="bar-fill" style="width: {percent}%; background: {color};"></div>
        </div>
        <span class="label">{formatBytes(quota.used)} / {formatBytes(quota.total)}</span>
    </div>
{/if}

<style>
    .quota {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 140px;
    }
    .bar-bg {
        flex: 1;
        height: 6px;
        background: var(--bg-hover);
        border-radius: 3px;
        overflow: hidden;
        min-width: 60px;
    }
    .bar-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.4s ease, background 0.4s ease;
    }
    .label {
        font-size: 11px;
        font-weight: 500;
        color: var(--text-secondary);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
    }
</style>
