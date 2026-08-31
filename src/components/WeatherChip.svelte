<script lang="ts">
    // Open-Meteo gadget for the desktop top bar. Bigger SVG scenes
    // with dramatic animations (rotating sun rays, drifting cloud
    // layers, pouring rain, lightning flash). Click to advance,
    // caret or right-click for the options menu (units, location,
    // GPS, refresh). Refreshes every 30 minutes.
    import { onMount, onDestroy } from 'svelte';
    import { setWeatherLatLon, setWeatherUnits } from '../lib/settings.svelte';

    interface Props {
        latitude?: number;
        longitude?: number;
        units?: 'celsius' | 'fahrenheit';
        rotateMs?: number;
    }
    let {
        latitude = 51.5074,
        longitude = -0.1278,
        units = 'celsius',
        rotateMs = 5000
    }: Props = $props();

    interface Daily {
        date: string;
        max: number;
        min: number;
        code: number;
    }

    let temp = $state<number | null>(null);
    let feelsLike = $state<number | null>(null);
    let windKmh = $state<number | null>(null);
    let code = $state<number | null>(null);
    let isDay = $state(true);
    let placeName = $state<string>('—');
    let daily = $state<Daily[]>([]);
    let loading = $state(true);
    let errored = $state(false);
    let cursor = $state(0);
    let slideKey = $state(0);

    let timer: ReturnType<typeof setInterval> | null = null;
    let rotateTimer: ReturnType<typeof setInterval> | null = null;
    let triggerEl: HTMLButtonElement | null = $state(null);

    let menuOpen = $state(false);
    let menuX = $state(0);
    let menuY = $state(0);
    let editingLocation = $state(false);
    let locInput = $state('');

    function unitMark() { return units === 'fahrenheit' ? '°F' : '°C'; }
    function speedUnit() { return units === 'fahrenheit' ? 'mph' : 'km/h'; }

    function labelForCode(c: number | null): string {
        if (c == null) return 'unknown';
        if (c === 0) return 'Clear';
        if (c === 1) return 'Mostly clear';
        if (c === 2) return 'Partly cloudy';
        if (c === 3) return 'Overcast';
        if (c === 45 || c === 48) return 'Fog';
        if (c >= 51 && c <= 57) return 'Drizzle';
        if (c >= 61 && c <= 67) return 'Rain';
        if (c >= 71 && c <= 77) return 'Snow';
        if (c >= 80 && c <= 82) return 'Showers';
        if (c >= 85 && c <= 86) return 'Snow showers';
        if (c >= 95) return 'Thunderstorm';
        return 'Mixed';
    }

    function sceneForCode(c: number | null, day: boolean): string {
        if (c == null) return 'cloud';
        if (c === 0) return day ? 'sun' : 'moon';
        if (c === 1 || c === 2) return day ? 'sun-cloud' : 'moon-cloud';
        if (c === 3 || c === 45 || c === 48) return 'cloud';
        if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
        if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
        if (c >= 95) return 'storm';
        return 'cloud';
    }

    async function reverseGeocode(lat: number, lon: number): Promise<string> {
        try {
            const url = `https://geocoding-api.open-meteo.com/v1/search?name=${lat.toFixed(2)},${lon.toFixed(2)}&count=1`;
            const res = await fetch(url);
            const data = await res.json();
            const name = data?.results?.[0]?.name;
            return typeof name === 'string' && name ? name : `${lat.toFixed(2)},${lon.toFixed(2)}`;
        } catch {
            return `${lat.toFixed(2)},${lon.toFixed(2)}`;
        }
    }

    async function fetchWeather() {
        try {
            const tu = units === 'fahrenheit' ? '&temperature_unit=fahrenheit' : '';
            const wu = units === 'fahrenheit' ? '&wind_speed_unit=mph' : '';
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,wind_speed_10m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5&timezone=auto${tu}${wu}`;
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const t = data?.current?.temperature_2m;
            const c = data?.current?.weather_code;
            const day = data?.current?.is_day;
            if (typeof t !== 'number') throw new Error('No temperature');
            temp = t;
            feelsLike = typeof data?.current?.apparent_temperature === 'number'
                ? data.current.apparent_temperature : null;
            windKmh = typeof data?.current?.wind_speed_10m === 'number'
                ? data.current.wind_speed_10m : null;
            code = typeof c === 'number' ? c : null;
            isDay = day == null ? true : day === 1;
            const d = data?.daily;
            if (d?.time && Array.isArray(d.time)) {
                const out: Daily[] = [];
                for (let i = 0; i < d.time.length; i++) {
                    out.push({
                        date: d.time[i],
                        max: d.temperature_2m_max?.[i] ?? 0,
                        min: d.temperature_2m_min?.[i] ?? 0,
                        code: d.weather_code?.[i] ?? 0
                    });
                }
                daily = out;
            }
            errored = false;
        } catch {
            errored = true;
        } finally {
            loading = false;
        }
    }

    async function refreshLabel() {
        placeName = await reverseGeocode(latitude, longitude);
    }

    onMount(() => {
        void fetchWeather();
        void refreshLabel();
        timer = setInterval(fetchWeather, 30 * 60 * 1000);
    });

    $effect(() => {
        latitude; longitude; units;
        void fetchWeather();
        void refreshLabel();
    });

    onDestroy(() => {
        if (timer) clearInterval(timer);
        if (rotateTimer) clearInterval(rotateTimer);
    });

    // Pane 0 = current, pane 1 = "feels like + wind", panes 2…N = daily
    type Pane =
        | { kind: 'now' }
        | { kind: 'detail' }
        | { kind: 'day'; data: Daily };
    let panes = $derived.by<Pane[]>(() => {
        const out: Pane[] = [{ kind: 'now' }];
        if (feelsLike != null || windKmh != null) out.push({ kind: 'detail' });
        for (const d of daily.slice(1, 5)) out.push({ kind: 'day', data: d });
        return out;
    });

    $effect(() => {
        if (panes.length <= 1) { cursor = 0; return; }
        if (cursor >= panes.length) cursor = 0;
        if (rotateTimer) clearInterval(rotateTimer);
        rotateTimer = setInterval(() => {
            cursor = (cursor + 1) % panes.length;
            slideKey++;
        }, rotateMs);
        return () => {
            if (rotateTimer) clearInterval(rotateTimer);
        };
    });

    let pane = $derived<Pane>(panes[cursor] ?? panes[0]);
    let scene = $derived.by(() => {
        if (pane.kind === 'now' || pane.kind === 'detail') return sceneForCode(code, isDay);
        return sceneForCode(pane.data.code, true);
    });

    let today = $derived<Daily | null>(daily[0] ?? null);

    function dayLabel(iso: string): string {
        const d = new Date(iso + 'T00:00:00');
        return d.toLocaleDateString([], { weekday: 'short' });
    }

    let title = $derived(
        loading ? 'Loading weather…'
            : errored ? 'Weather unavailable — ⌄ to set location'
            : `${placeName}: ${labelForCode(code)}, ${Math.round(temp ?? 0)}${unitMark()} · ⌄ for options`
    );

    function openMenu(viaRightClick: boolean, e?: MouseEvent) {
        if (e) e.preventDefault();
        if (e && viaRightClick) {
            menuX = e.clientX;
            menuY = e.clientY;
        } else if (triggerEl) {
            const r = triggerEl.getBoundingClientRect();
            menuX = r.left;
            menuY = r.bottom + 6;
        } else {
            menuX = e?.clientX ?? 0;
            menuY = e?.clientY ?? 0;
        }
        editingLocation = false;
        // Defer so the right-click that triggered us doesn't immediately
        // close via the document listener registered in the $effect.
        requestAnimationFrame(() => { menuOpen = true; });
    }

    function commitLocation() {
        const m = locInput.match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
        if (m) {
            const lat = parseFloat(m[1]);
            const lon = parseFloat(m[2]);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                setWeatherLatLon(lat, lon);
                menuOpen = false;
                editingLocation = false;
                return;
            }
        }
        void (async () => {
            try {
                const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locInput)}&count=1`;
                const res = await fetch(url);
                const data = await res.json();
                const r = data?.results?.[0];
                if (r && typeof r.latitude === 'number' && typeof r.longitude === 'number') {
                    setWeatherLatLon(r.latitude, r.longitude);
                }
            } catch { /* ignore */ }
            menuOpen = false;
            editingLocation = false;
        })();
    }

    function useGeo() {
        if (!('geolocation' in navigator)) return;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setWeatherLatLon(pos.coords.latitude, pos.coords.longitude);
                menuOpen = false;
            },
            () => { menuOpen = false; },
            { timeout: 8000 }
        );
    }

    $effect(() => {
        if (!menuOpen) return;
        const onDoc = (e: MouseEvent) => {
            const tgt = e.target as HTMLElement;
            if (!tgt.closest('.weather-menu') && !tgt.closest('.weather-chip') && !tgt.closest('.weather-caret')) menuOpen = false;
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') menuOpen = false; };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    });
</script>

<span class="weather-wrap">
    <button
        type="button"
        class={`weather-chip scene-${scene}`}
        bind:this={triggerEl}
        {title}
        aria-label={title}
        data-testid="weather-chip"
        onclick={() => { cursor = (cursor + 1) % Math.max(1, panes.length); slideKey++; }}
        oncontextmenu={(e) => openMenu(true, e)}
    >
        <span class="scene" aria-hidden="true">
            {#if scene === 'sun'}
                <span class="sun-disc"></span>
                <span class="sun-glow"></span>
                {#each [0,1,2,3,4,5,6,7] as r (r)}
                    <span class="ray" style={`transform: translate(-50%,-50%) rotate(${r * 45}deg) translateY(-14px);`}></span>
                {/each}
            {:else if scene === 'moon'}
                <span class="moon-disc"></span>
                <span class="moon-shade"></span>
                <span class="star s1"></span>
                <span class="star s2"></span>
                <span class="star s3"></span>
            {:else if scene === 'sun-cloud'}
                <span class="sun-disc small"></span>
                {#each [0,1,2,3,4,5,6,7] as r (r)}
                    <span class="ray small-ray" style={`transform: translate(-50%,-50%) rotate(${r * 45}deg) translateY(-9px);`}></span>
                {/each}
                <span class="cloud back"></span>
                <span class="cloud front"></span>
            {:else if scene === 'moon-cloud'}
                <span class="moon-disc small"></span>
                <span class="cloud back"></span>
                <span class="cloud front"></span>
            {:else if scene === 'cloud'}
                <span class="cloud back"></span>
                <span class="cloud front"></span>
            {:else if scene === 'rain'}
                <span class="cloud back rain-cloud"></span>
                <span class="cloud front rain-cloud"></span>
                {#each [0,1,2,3,4] as i (i)}
                    <span class="drop" style={`left:${5 + i * 6}px; animation-delay:${i * 0.18}s;`}></span>
                {/each}
                <span class="puddle"></span>
            {:else if scene === 'snow'}
                <span class="cloud back snow-cloud"></span>
                <span class="cloud front snow-cloud"></span>
                {#each [0,1,2,3] as i (i)}
                    <span class="flake" style={`left:${5 + i * 7}px; animation-delay:${i * 0.4}s;`}>❄</span>
                {/each}
            {:else if scene === 'storm'}
                <span class="cloud back storm-cloud"></span>
                <span class="cloud front storm-cloud"></span>
                <span class="bolt-glow"></span>
                <span class="bolt">⚡</span>
                {#each [0,1,2] as i (i)}
                    <span class="drop storm-drop" style={`left:${7 + i * 7}px; animation-delay:${i * 0.22}s;`}></span>
                {/each}
            {/if}
        </span>

        {#key slideKey}
            <span class="pane">
                {#if loading}
                    <span class="dot" aria-hidden="true">·</span>
                {:else if errored}
                    <span class="emoji" aria-hidden="true">⚠</span>
                {:else if pane.kind === 'now'}
                    <span class="temp">{Math.round(temp ?? 0)}°</span>
                    <span class="now-meta">
                        <span class="condition">{labelForCode(code)}</span>
                        {#if today}
                            <span class="hilo">
                                <span class="hi" title="Today's high">↑{Math.round(today.max)}°</span>
                                <span class="lo" title="Today's low">↓{Math.round(today.min)}°</span>
                            </span>
                        {:else}
                            <span class="place">{placeName}</span>
                        {/if}
                    </span>
                {:else if pane.kind === 'detail'}
                    {#if feelsLike != null}
                        <span class="dlabel">Feels</span>
                        <span class="temp">{Math.round(feelsLike)}°</span>
                    {/if}
                    {#if windKmh != null}
                        <span class="wind">💨 {Math.round(windKmh)} {speedUnit()}</span>
                    {/if}
                    <span class="place small">{placeName}</span>
                {:else if pane.kind === 'day'}
                    <span class="dlabel">{dayLabel(pane.data.date)}</span>
                    <span class="temp">{Math.round(pane.data.max)}° / {Math.round(pane.data.min)}°</span>
                {/if}
            </span>
        {/key}

        {#if panes.length > 1 && !loading && !errored}
            <span class="dots" aria-hidden="true">
                {#each panes as _, i (i)}
                    <span class="d" class:on={i === cursor}></span>
                {/each}
            </span>
        {/if}
    </button>
    <button
        type="button"
        class="weather-caret"
        title="Weather options"
        aria-label="Weather options"
        onclick={(e) => { e.stopPropagation(); openMenu(false, e); }}
        oncontextmenu={(e) => openMenu(true, e)}
    >⌄</button>
</span>

{#if menuOpen}
    <div class="weather-menu" role="menu" style="left:{menuX}px; top:{menuY}px;">
        {#if editingLocation}
            <div class="menu-section">Location</div>
            <input
                type="text"
                placeholder="City name or lat,lon"
                value={locInput}
                oninput={(e) => (locInput = (e.currentTarget as HTMLInputElement).value)}
                onkeydown={(e) => { if (e.key === 'Enter') commitLocation(); }}
                autofocus
            />
            <div class="row">
                <button class="menu-item small" onclick={commitLocation}>Save</button>
                <button class="menu-item small" onclick={() => (editingLocation = false)}>Cancel</button>
            </div>
        {:else}
            <div class="menu-section">Units</div>
            <button class="menu-item" class:active={units === 'celsius'} onclick={() => { setWeatherUnits('celsius'); menuOpen = false; }}>°C Celsius</button>
            <button class="menu-item" class:active={units === 'fahrenheit'} onclick={() => { setWeatherUnits('fahrenheit'); menuOpen = false; }}>°F Fahrenheit</button>
            <div class="menu-section">Location</div>
            <button class="menu-item" onclick={() => { editingLocation = true; locInput = placeName; }}>📍 Edit location</button>
            <button class="menu-item" onclick={useGeo}>🛰 Use current GPS</button>
            <div class="menu-section">Refresh</div>
            <button class="menu-item" onclick={() => { void fetchWeather(); menuOpen = false; }}>↻ Refresh now</button>
        {/if}
    </div>
{/if}

<style>
    /* Match the CalendarTicker shell: neutral gradient pill + paired
     * caret button. The scene-specific colour now lives ONLY inside
     * the icon cap on the left, so both gadgets read as one unified
     * top-bar treatment instead of competing palettes. */
    .weather-wrap {
        position: relative;
        display: inline-flex;
        align-items: stretch;
    }
    .weather-chip {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 6px 12px 6px 6px;
        font-size: 12px;
        line-height: 1.1;
        border-radius: 999px 0 0 999px;
        /* BBC-weather-ish soft sky tint: warmer than plain grey,
         * subtle gradient into a creamy off-white, friendly border. */
        background: linear-gradient(135deg, #eaf3fb 0%, #fbfbfa 60%, #f3f6fa 100%);
        color: var(--text-primary, #1a1a1c);
        border: 1px solid color-mix(in srgb, #1d4ed8 14%, var(--border-subtle, rgba(0, 0, 0, 0.06)));
        border-right: 0;
        user-select: none;
        cursor: pointer;
        min-width: 170px;
        max-width: 280px;
        overflow: hidden;
        transition: background 0.2s ease, filter 0.2s ease;
    }
    .weather-chip:hover { filter: brightness(1.03); }
    .weather-caret {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        padding: 0;
        background: linear-gradient(135deg, #eaf3fb 0%, #f3f6fa 100%);
        color: var(--text-secondary, #6e6e72);
        border: 1px solid color-mix(in srgb, #1d4ed8 14%, var(--border-subtle, rgba(0, 0, 0, 0.06)));
        border-left: 1px solid color-mix(in srgb, var(--text-tertiary, #6e6e72) 18%, transparent);
        border-radius: 0 999px 999px 0;
        cursor: pointer;
        font-size: 12px;
    }
    .weather-caret:hover { filter: brightness(0.96); color: var(--text-primary, #1a1a1c); }
    :global(html.dark) .weather-chip,
    :global(html.dark) .weather-caret,
    :global([data-theme="dark"]) .weather-chip,
    :global([data-theme="dark"]) .weather-caret {
        background: linear-gradient(135deg, #232a3a 0%, #1c2230 100%);
        border-color: rgba(120, 160, 220, 0.18);
        color: var(--text-primary, #e6e9f0);
    }

    /* Coloured cap that holds the animated scene. Mirrors the badge
     * styling used by CalendarTicker's "when" pill so both gadgets
     * have the same visual rhythm. */
    .scene {
        position: relative;
        display: inline-flex;
        width: 38px;
        height: 26px;
        flex-shrink: 0;
        overflow: hidden;
        border-radius: 999px;
        background: var(--scene-bg, linear-gradient(135deg, #e3e7ee 0%, #c4ccd9 100%));
        box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.45),
            0 0 0 1px color-mix(in srgb, var(--accent, #4f7cff) 12%, transparent);
        transition: background 0.4s ease;
    }
    .weather-chip.scene-sun         .scene { --scene-bg: linear-gradient(135deg, #fff7c4 0%, #ffc23a 70%, #ff8a1a 100%); }
    .weather-chip.scene-moon        .scene { --scene-bg: linear-gradient(135deg, #2c2f4a 0%, #14162a 100%); }
    .weather-chip.scene-sun-cloud,
    .weather-chip.scene-moon-cloud,
    .weather-chip.scene-cloud       .scene { --scene-bg: linear-gradient(135deg, #cfd6e3 0%, #a4b0c4 100%); }
    .weather-chip.scene-rain        .scene { --scene-bg: linear-gradient(160deg, #6f88a4 0%, #3d556f 100%); }
    .weather-chip.scene-storm       .scene { --scene-bg: linear-gradient(160deg, #3a3a52 0%, #1a1d2e 100%); }
    .weather-chip.scene-snow        .scene { --scene-bg: linear-gradient(135deg, #f0f6ff 0%, #b6c5dd 100%); }

    /* === SUN === */
    .sun-disc {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 14px;
        height: 14px;
        margin: -7px 0 0 -7px;
        border-radius: 50%;
        background: radial-gradient(circle at 35% 30%, #fff8c8, #ffb84d 70%, #ff8a1a);
        box-shadow: 0 0 10px rgba(255, 200, 90, 0.9);
        z-index: 2;
    }
    .sun-disc.small {
        width: 11px;
        height: 11px;
        margin: -5.5px 0 0 -5.5px;
        left: 40%;
        top: 45%;
    }
    .sun-glow {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 26px;
        height: 26px;
        margin: -13px 0 0 -13px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255, 220, 130, 0.55), transparent 70%);
        animation: sun-pulse 3.6s ease-in-out infinite;
        z-index: 1;
    }
    .ray {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 2px;
        height: 6px;
        background: linear-gradient(180deg, #ffd66b, transparent);
        border-radius: 2px;
        transform-origin: 50% 50%;
        animation: ray-spin 14s linear infinite;
        z-index: 1;
    }
    .ray.small-ray { width: 1.5px; height: 4px; }
    @keyframes sun-pulse {
        0%, 100% { transform: scale(1); opacity: 0.7; }
        50%      { transform: scale(1.12); opacity: 1; }
    }
    @keyframes ray-spin { to { transform: rotate(360deg) translateY(0); } }

    /* === MOON === */
    .moon-disc {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 16px;
        height: 16px;
        margin: -8px 0 0 -8px;
        border-radius: 50%;
        background: radial-gradient(circle at 35% 30%, #ffffff, #c8d0ff 80%);
        box-shadow: 0 0 10px rgba(180, 200, 255, 0.6);
    }
    .moon-disc.small { width: 12px; height: 12px; margin: -6px 0 0 -6px; left: 40%; top: 45%; }
    .moon-shade {
        position: absolute;
        left: 56%;
        top: 28%;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: radial-gradient(circle at 50% 50%, transparent 40%, rgba(20, 22, 40, 0.7) 70%);
    }
    .star {
        position: absolute;
        width: 2px;
        height: 2px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 0 4px #fff;
        animation: twinkle 2.4s ease-in-out infinite;
    }
    .s1 { left: 6px;  top: 6px;  animation-delay: 0s; }
    .s2 { left: 28px; top: 5px;  animation-delay: 0.7s; }
    .s3 { left: 22px; top: 22px; animation-delay: 1.3s; }
    @keyframes twinkle {
        0%, 100% { opacity: 0.3; transform: scale(0.8); }
        50%      { opacity: 1;   transform: scale(1.2); }
    }

    /* === CLOUDS === */
    .cloud {
        position: absolute;
        height: 9px;
        border-radius: 9px;
        background: linear-gradient(180deg, #ffffff 0%, #d9dfeb 100%);
        animation: cloud-drift 6s ease-in-out infinite alternate;
    }
    .cloud::before, .cloud::after {
        content: '';
        position: absolute;
        background: inherit;
        border-radius: 50%;
    }
    .cloud.back {
        width: 18px;
        right: 0;
        top: 4px;
        opacity: 0.7;
        animation-duration: 9s;
        background: linear-gradient(180deg, #f0f4ff 0%, #c5cee0 100%);
    }
    .cloud.back::before { left: 3px; top: -4px; width: 8px; height: 8px; }
    .cloud.back::after  { right: 3px; top: -3px; width: 7px; height: 7px; }
    .cloud.front {
        width: 22px;
        left: 4px;
        bottom: 6px;
        z-index: 3;
    }
    .cloud.front::before { left: 4px; top: -5px; width: 10px; height: 10px; }
    .cloud.front::after  { right: 3px; top: -4px; width: 8px; height: 8px; }
    .cloud.rain-cloud {
        background: linear-gradient(180deg, #d3dceb 0%, #7d8ba4 100%);
    }
    .cloud.snow-cloud {
        background: linear-gradient(180deg, #ffffff 0%, #b3c2d6 100%);
    }
    .cloud.storm-cloud {
        background: linear-gradient(180deg, #6a6f80 0%, #2a2d3c 100%);
    }
    @keyframes cloud-drift {
        from { transform: translateX(0); }
        to   { transform: translateX(3px); }
    }

    /* === RAIN === */
    .drop {
        position: absolute;
        bottom: 2px;
        width: 2px;
        height: 7px;
        background: linear-gradient(180deg, rgba(180, 220, 255, 0.9), #4f80c0);
        border-radius: 0 0 2px 2px;
        animation: drop 0.85s linear infinite;
        z-index: 2;
    }
    .puddle {
        position: absolute;
        left: 6px;
        right: 6px;
        bottom: 1px;
        height: 2px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.35);
        animation: ripple 1.4s ease-in-out infinite;
        z-index: 1;
    }
    @keyframes drop {
        0%   { transform: translateY(-12px); opacity: 0; }
        15%  { opacity: 1; }
        90%  { opacity: 1; }
        100% { transform: translateY(8px); opacity: 0; }
    }
    @keyframes ripple {
        0%, 100% { transform: scaleX(0.6); opacity: 0.45; }
        50%      { transform: scaleX(1);   opacity: 0.85; }
    }

    /* === STORM === */
    .bolt {
        position: absolute;
        left: 50%;
        bottom: 0px;
        margin-left: -6px;
        font-size: 14px;
        z-index: 3;
        animation: bolt-strike 2.4s ease-in-out infinite;
        text-shadow: 0 0 8px rgba(255, 230, 100, 0.95);
    }
    .bolt-glow {
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 50% 70%, rgba(255, 230, 100, 0.65), transparent 60%);
        opacity: 0;
        animation: flash 2.4s ease-in-out infinite;
        z-index: 1;
    }
    .drop.storm-drop {
        background: linear-gradient(180deg, rgba(220, 230, 255, 0.95), #8aa);
        animation-duration: 0.7s;
    }
    @keyframes bolt-strike {
        0%, 30%, 70%, 100% { transform: scale(0.85); opacity: 0.45; }
        45%, 55%           { transform: scale(1.2);  opacity: 1; }
    }
    @keyframes flash {
        0%, 30%, 70%, 100% { opacity: 0; }
        45%, 55%           { opacity: 1; }
    }

    /* === SNOW === */
    .flake {
        position: absolute;
        bottom: 0;
        font-size: 8px;
        color: #fff;
        text-shadow: 0 0 3px rgba(80, 110, 160, 0.7);
        animation: flake-fall 2.2s linear infinite;
        z-index: 2;
    }
    @keyframes flake-fall {
        0%   { transform: translateY(-14px) rotate(0deg);  opacity: 0; }
        15%  { opacity: 1; }
        100% { transform: translateY(10px)  rotate(120deg); opacity: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
        .ray, .sun-glow, .star, .cloud, .drop, .puddle, .bolt, .bolt-glow, .flake {
            animation: none !important;
        }
    }

    /* === Layout text === */
    .pane {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        animation: weather-tick 460ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    @keyframes weather-tick {
        from { transform: translateX(14px); opacity: 0; filter: blur(2px); }
        to   { transform: translateX(0);    opacity: 1; filter: blur(0); }
    }
    @media (prefers-reduced-motion: reduce) {
        .pane { animation: none; }
    }
    .temp {
        font-variant-numeric: tabular-nums;
        font-weight: 700;
        font-size: 16px;
        line-height: 1;
        color: var(--text-primary, #1a1a1c);
    }
    /* BBC-style: stack the condition word above an arrow-marked
     * high/low so the chip reads at a glance like the BBC card,
     * just compressed into the top-bar pill. */
    .now-meta {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
        line-height: 1;
        min-width: 0;
    }
    .condition {
        font-size: 11.5px;
        font-weight: 600;
        opacity: 0.92;
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .hilo {
        display: inline-flex;
        gap: 6px;
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        opacity: 0.78;
    }
    .hi { color: #b91c1c; font-weight: 600; }
    .lo { color: #1d4ed8; font-weight: 600; }
    :global(html.dark) .hi,
    :global([data-theme="dark"]) .hi { color: #fca5a5; }
    :global(html.dark) .lo,
    :global([data-theme="dark"]) .lo { color: #93c5fd; }
    .place {
        font-size: 11px;
        opacity: 0.8;
        max-width: 110px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .place.small { font-size: 10.5px; opacity: 0.7; }
    .dlabel { font-size: 11px; font-weight: 600; opacity: 0.85; }
    .wind { font-size: 11px; opacity: 0.85; font-variant-numeric: tabular-nums; }
    .emoji { font-size: 16px; }
    .dot { opacity: 0.4; }

    .dots {
        display: inline-flex;
        gap: 3px;
        align-items: center;
        margin-left: auto;
    }
    .dots .d {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.3;
        transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .dots .d.on { opacity: 0.95; transform: scale(1.5); }

    /* === Right-click / caret menu === */
    .weather-menu {
        position: fixed;
        z-index: 9999;
        background: var(--bg-surface, #fff);
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.1));
        border-radius: 10px;
        padding: 6px;
        min-width: 220px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
        font-size: 13px;
        display: flex;
        flex-direction: column;
    }
    .menu-section {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary, #8a8a8e);
        padding: 6px 8px 2px;
    }
    .menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        background: none;
        border: 0;
        border-radius: 6px;
        color: inherit;
        text-align: left;
        cursor: pointer;
        font: inherit;
    }
    .menu-item:hover { background: var(--bg-surface-alt, #f0f0f3); }
    .menu-item.active { background: color-mix(in srgb, var(--accent, #4f7cff) 12%, transparent); }
    .menu-item.small { padding: 5px 10px; font-size: 12px; }
    .row { display: flex; gap: 4px; padding: 4px 8px 6px; }
    .weather-menu input {
        margin: 4px 8px;
        padding: 6px 8px;
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.15));
        border-radius: 6px;
        font: inherit;
        background: var(--bg-canvas, #fff);
        color: inherit;
    }
</style>
