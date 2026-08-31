<script lang="ts">
    import { driveState } from '../../lib/drive.svelte';
    import DriveItemCard from './DriveItemCard.svelte';

    interface Props {
        onPreview?: (item: import('../../lib/drive-api').DriveItem) => void;
        onContextMenu?: (e: MouseEvent, item: import('../../lib/drive-api').DriveItem) => void;
    }
    let { onPreview, onContextMenu }: Props = $props();
</script>

<div class="list-wrap" data-testid="drive-list">
    <table class="list-table">
        <thead>
            <tr>
                <th class="th-check"></th>
                <th class="th-icon"></th>
                <th class="th-name">Name</th>
                <th class="th-size">Size</th>
                <th class="th-date">Modified</th>
            </tr>
        </thead>
        <tbody>
            {#each driveState.items as item (item.path)}
                <DriveItemCard {item} {onPreview} {onContextMenu} />
            {/each}
        </tbody>
    </table>
</div>

<style>
    .list-wrap {
        overflow-y: auto;
        padding: 8px 12px;
    }
    .list-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
    }
    thead th {
        text-align: left;
        padding: 8px;
        font-weight: 600;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border-subtle);
        position: sticky;
        top: 0;
        background: var(--bg-base);
        z-index: 1;
    }
    .th-check { width: 32px; }
    .th-icon { width: 28px; }
    .th-name { width: auto; }
    .th-size { width: 80px; text-align: right; }
    .th-date { width: 120px; }
</style>
