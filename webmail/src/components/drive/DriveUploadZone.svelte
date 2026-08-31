<script lang="ts">
    import { driveState, uploadFiles } from '../../lib/drive.svelte';
    import Icon from '../Icon.svelte';

    // Counter-based drag tracking prevents flicker when crossing child elements.
    // dragenter/dragleave fire for every element boundary; only hide the overlay
    // when we have truly left the window (counter reaches 0).
    let dragCounter = 0;

    function onDragEnter(e: DragEvent) {
        e.preventDefault();
        dragCounter++;
        driveState.dragOver = true;
    }

    function onDragLeave(e: DragEvent) {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            driveState.dragOver = false;
            dragCounter = 0;
        }
    }

    function onDragOver(e: DragEvent) {
        e.preventDefault();
    }

    function onDrop(e: DragEvent) {
        e.preventDefault();
        dragCounter = 0;
        driveState.dragOver = false;
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            uploadFiles(Array.from(files));
        }
    }
</script>

<svelte:window
    ondragenter={onDragEnter}
    ondragleave={onDragLeave}
    ondragover={onDragOver}
    ondrop={onDrop}
/>

{#if driveState.dragOver}
    <div
        class="overlay"
        data-testid="drive-upload-zone"
        ondragover={onDragOver}
        ondrop={onDrop}
        role="presentation"
    >
        <div class="card">
            <Icon name="upload" size={48} />
            <span class="label">Drop files to upload</span>
        </div>
    </div>
{/if}

<style>
    .overlay {
        position: fixed;
        inset: 0;
        z-index: 100;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.15s ease;
    }
    .card {
        background: var(--bg-surface);
        border: 2px dashed var(--accent);
        border-radius: var(--radius-lg);
        padding: 48px 64px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        color: var(--text-primary);
        box-shadow: var(--shadow-lg);
    }
    .label {
        font-size: 18px;
        font-weight: 500;
    }
    @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
    }
</style>
