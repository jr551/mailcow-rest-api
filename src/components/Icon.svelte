<script lang="ts">
    import { ICONS, type IconName } from '../lib/icons';

    interface Props {
        name: IconName;
        size?: number;
        stroke?: number;
        title?: string;
        class?: string;
    }
    let { name, size = 18, stroke = 2, title, class: cls = '' }: Props = $props();

    // Lucide-svelte components accept size, strokeWidth, title, class, and
    // arbitrary `fill`. We swap "starFilled" → Star with fill so the rest of
    // the call sites stay one consistent name-based API.
    let Component = $derived(ICONS[name]);
    let fill = $derived(name === 'starFilled' ? 'currentColor' : 'none');
</script>

<Component
    {size}
    strokeWidth={stroke}
    {fill}
    {title}
    class={`icon ${cls}`}
    aria-hidden={title ? undefined : 'true'}
/>
