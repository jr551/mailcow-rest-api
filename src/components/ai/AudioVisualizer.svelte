<script lang="ts">
    // Real-time audio oscilloscope using Web Audio API + Canvas.
    // Renders a waveform that responds to microphone input (listening)
    // or TTS audio playback (speaking).

    import { onMount, onDestroy } from 'svelte';

    interface Props {
        active: boolean;
        source: 'mic' | 'audio' | null;
        audioElement?: HTMLAudioElement | null;
        color?: string;
    }

    let { active, source, audioElement = null, color = 'var(--accent)' }: Props = $props();

    let canvas: HTMLCanvasElement | undefined = $state();
    let ctx: CanvasRenderingContext2D | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null = null;
    let rafId: number = 0;
    let mediaStream: MediaStream | null = null;

    const FFT_SIZE = 2048;
    const SMOOTHING = 0.85;

    onMount(() => {
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        resize();
        window.addEventListener('resize', resize);
    });

    onDestroy(() => {
        window.removeEventListener('resize', resize);
        stop();
    });

    function resize() {
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        if (ctx) {
            ctx.scale(dpr, dpr);
        }
    }

    function stop() {
        if (rafId) cancelAnimationFrame(rafId);
        if (sourceNode) { try { sourceNode.disconnect(); } catch { /* */ } sourceNode = null; }
        if (analyser) { try { analyser.disconnect(); } catch { /* */ } analyser = null; }
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        // Don't close audioCtx — it may be shared or reused
    }

    async function startMic() {
        stop();
        if (!canvas || !ctx) return;
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioCtx = new AudioContext();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = FFT_SIZE;
            analyser.smoothingTimeConstant = SMOOTHING;
            sourceNode = audioCtx.createMediaStreamSource(mediaStream);
            sourceNode.connect(analyser);
            draw();
        } catch {
            // Mic permission denied — silently fall back to CSS animation
        }
    }

    function startAudio(el: HTMLAudioElement) {
        stop();
        if (!canvas || !ctx) return;
        try {
            audioCtx = new AudioContext();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = FFT_SIZE;
            analyser.smoothingTimeConstant = SMOOTHING;
            sourceNode = audioCtx.createMediaElementSource(el);
            sourceNode.connect(analyser);
            analyser.connect(audioCtx.destination);
            draw();
        } catch {
            // Fallback
        }
    }

    function draw() {
        if (!analyser || !ctx || !canvas) return;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        const rect = canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        ctx.clearRect(0, 0, w, h);

        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.beginPath();

        const sliceWidth = w / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * h) / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }

        ctx.lineTo(w, h / 2);
        ctx.stroke();

        // Glow effect
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.shadowBlur = 0;

        rafId = requestAnimationFrame(draw);
    }

    $effect(() => {
        if (!active) {
            stop();
            return;
        }
        if (source === 'mic') {
            void startMic();
        } else if (source === 'audio' && audioElement) {
            startAudio(audioElement);
        }
    });
</script>

<canvas bind:this={canvas} class="visualizer" aria-hidden="true"></canvas>

<style>
    .visualizer {
        position: absolute;
        inset: -40px;
        width: calc(100% + 80px);
        height: calc(100% + 80px);
        pointer-events: none;
        opacity: 0.7;
    }
</style>
