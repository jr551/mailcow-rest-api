<script lang="ts">
    // Tiny topbar latency widget: live "last-request" ms + a 60-sample
    // sparkline drawn straight to canvas. Replaces the static radar.
    //
    // The api.ts request helper pushes every call's wall-clock duration
    // into the latencyState bus, so this stays current without a separate
    // /health probe.

    import { onMount } from 'svelte';
    import { latencyState } from '../lib/latency.svelte';

    let canvas: HTMLCanvasElement | undefined = $state();
    const W = 36;
    const H = 12;

    let last = $derived(latencyState.lastMs);
    let lastOk = $derived(latencyState.lastOk);
    let samples = $derived(latencyState.samples);

    // Bucket the sample into a status colour: green ≤300, amber ≤900, red.
    function tone(ms: number): 'good' | 'slow' | 'bad' {
        if (ms <= 300) return 'good';
        if (ms <= 900) return 'slow';
        return 'bad';
    }

    let toneNow = $derived(last == null ? 'good' : tone(last));

    function draw() {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // Honour devicePixelRatio for crisp lines on retina.
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
            canvas.width = W * dpr;
            canvas.height = H * dpr;
            ctx.scale(dpr, dpr);
        }
        ctx.clearRect(0, 0, W, H);
        if (samples.length < 2) return;

        // Pull a stable colour from CSS so the spark inherits the active skin.
        const styles = getComputedStyle(canvas);
        const accent = styles.getPropertyValue('--accent').trim() || '#5b6cff';
        const danger = styles.getPropertyValue('--danger').trim() || '#dc2626';

        const max = Math.max(50, ...samples.map((s) => s.ms));
        const stepX = W / (samples.length - 1);
        const yOf = (ms: number) => H - 2 - ((ms / max) * (H - 4));

        // Faint area fill under the curve.
        ctx.beginPath();
        ctx.moveTo(0, H);
        samples.forEach((s, i) => ctx.lineTo(i * stepX, yOf(s.ms)));
        ctx.lineTo((samples.length - 1) * stepX, H);
        ctx.closePath();
        ctx.fillStyle = `${accent}22`;
        ctx.fill();

        // Main line.
        ctx.beginPath();
        samples.forEach((s, i) => {
            const x = i * stepX;
            const y = yOf(s.ms);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = accent;
        ctx.stroke();

        // Mark failed samples with a tiny dot in danger colour so spikes
        // and outages stand out at a glance.
        samples.forEach((s, i) => {
            if (s.ok) return;
            const x = i * stepX;
            const y = yOf(s.ms);
            ctx.beginPath();
            ctx.arc(x, y, 1.6, 0, Math.PI * 2);
            ctx.fillStyle = danger;
            ctx.fill();
        });

        // Last-sample bullet always visible.
        const lastIdx = samples.length - 1;
        const lx = lastIdx * stepX;
        const ly = yOf(samples[lastIdx].ms);
        ctx.beginPath();
        ctx.arc(lx, ly, 2, 0, Math.PI * 2);
        ctx.fillStyle = samples[lastIdx].ok ? accent : danger;
        ctx.fill();
    }

    $effect(() => {
        // Touch the reactive deps so Svelte schedules a redraw whenever a
        // new sample lands.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        samples;
        draw();
    });

    onMount(() => {
        const onResize = () => draw();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    });

    let title = $derived(
        last == null ? 'API: no traffic yet'
            : `API ${last} ms (${samples.length} probes, ${samples.filter((s) => !s.ok).length} failed)`
    );
</script>

<span class={`lat-chip tone-${toneNow}`} {title} data-testid="latency-chip" aria-label={title}>
    <canvas bind:this={canvas} class="spark" width={W} height={H}></canvas>
    <span class="ms-label">
        {#if last == null}–{:else}{last}<span class="unit">ms</span>{/if}
    </span>
</span>

<style>
    .lat-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px 2px 4px;
        border-radius: 999px;
        font-variant-numeric: tabular-nums;
        font-size: 10px;
        line-height: 1;
        color: var(--text-tertiary, var(--text-secondary));
        border: 1px solid var(--border-subtle);
        background: var(--bg-base);
        opacity: 0.85;
    }
    .spark {
        display: block;
        width: 36px;
        height: 12px;
        opacity: 0.85;
    }
    .ms-label { font-weight: 600; }
    .unit { opacity: 0.6; margin-left: 1px; }

    /* Tone hints — subtle; the canvas is the primary signal. */
    .lat-chip.tone-good   { color: var(--text-secondary); }
    .lat-chip.tone-slow   { color: #d18c1d; border-color: color-mix(in srgb, #d18c1d 30%, var(--border-subtle)); }
    .lat-chip.tone-bad    { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, var(--border-subtle)); }
    @media (max-width: 720px) {
        .lat-chip .spark { display: none; }
    }
</style>
