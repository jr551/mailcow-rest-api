<script lang="ts">
    import InboxView from './InboxView.svelte';
    import MessageView from './MessageView.svelte';
    import { mobileState } from '../lib/store.svelte';
    import { settings } from '../../lib/settings.svelte';
    import { mobileTabletPaneAxis } from '../../lib/mobile-tablet-reading-pane';

    const axis = $derived(mobileTabletPaneAxis(settings.readingPaneLayout));
    const hasSelection = $derived(mobileState.selectedUid != null);
</script>

<div
    class="tablet-mail-shell"
    class:vertical={axis === 'vertical'}
    data-testid="tablet-mail-split"
    data-pane-axis={axis}
>
    <section class="tablet-list-pane" aria-label="Message list">
        <InboxView />
    </section>
    <section class="tablet-reading-pane" aria-label="Reading pane">
        {#if hasSelection}
            <MessageView embedded={true} />
        {:else}
            <div class="tablet-reading-empty" data-testid="tablet-reading-empty">
                <p>Select a message to read</p>
            </div>
        {/if}
    </section>
</div>

<style>
    .tablet-mail-shell {
        flex: 1;
        display: grid;
        grid-template-columns: minmax(280px, 42%) minmax(0, 1fr);
        min-height: 0;
        overflow: hidden;
    }
    .tablet-mail-shell.vertical {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(0, 45%) minmax(0, 55%);
    }
    .tablet-list-pane,
    .tablet-reading-pane {
        min-height: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .tablet-reading-pane {
        border-left: 1px solid var(--border-subtle);
        background: var(--bg-base);
    }
    .tablet-mail-shell.vertical .tablet-reading-pane {
        border-left: none;
        border-top: 1px solid var(--border-subtle);
    }
    .tablet-reading-empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        color: var(--text-muted);
        font-size: 15px;
        text-align: center;
    }
</style>
