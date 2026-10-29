<script lang="ts">
    interface Props {
        checked: boolean;
        /** Accessible name. Phrase it so "on" means the feature is enabled. */
        label: string;
        disabled?: boolean;
        testid?: string;
        onToggle: () => void | Promise<void>;
    }
    let { checked, label, disabled = false, testid, onToggle }: Props = $props();
</script>

<button
    type="button"
    role="switch"
    class="toggle-switch"
    aria-checked={checked}
    aria-label={label}
    class:on={checked}
    class:off={!checked}
    {disabled}
    data-testid={testid}
    onclick={onToggle}
>
    <span class="toggle-knob"></span>
</button>

<style>
    .toggle-switch {
        width: 50px;
        height: 30px;
        border-radius: 15px;
        border: none;
        padding: 2px;
        position: relative;
        cursor: pointer;
        transition: background-color 200ms ease;
        flex-shrink: 0;
        background: var(--border-soft);
    }
    /* Extends the tap area to 44px without changing the visual size. */
    .toggle-switch::after {
        content: '';
        position: absolute;
        inset: -7px -3px;
    }
    .toggle-switch.on { background: var(--accent); }
    .toggle-switch.off { background: var(--border-soft); }
    .toggle-switch:disabled { opacity: 0.5; cursor: not-allowed; }
    .toggle-knob {
        display: block;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: var(--bg-surface);
        box-shadow: 0 1px 3px rgba(0,0,0,0.12);
        transition: transform 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .toggle-switch.on .toggle-knob { transform: translateX(20px); }
    .toggle-switch.off .toggle-knob { transform: translateX(0); }
</style>
