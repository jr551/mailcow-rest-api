<script lang="ts">
    import { driveState } from '../../lib/drive.svelte';
    import DriveItemCard from './DriveItemCard.svelte';

    interface Props {
        onPreview?: (item: import('../../lib/drive-api').DriveItem) => void;
        onContextMenu?: (e: MouseEvent, item: import('../../lib/drive-api').DriveItem) => void;
    }
    let { onPreview, onContextMenu }: Props = $props();
</script>

<div class="grid" data-testid="drive-grid">
    {#each driveState.items as item (item.path)}
        <DriveItemCard {item} {onPreview} {onContextMenu} />
    {/each}
</div>

<style>
    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 12px;
        padding: 12px;
        overflow-y: auto;
    }
</style>
