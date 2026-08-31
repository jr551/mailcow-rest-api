// Real-time API latency stream. The api.ts `request` helper pushes every
// completed call's wall-clock duration here; components like the topbar
// sparkline subscribe via `$state` reactivity. Caps at the last 60 samples
// (~5 min at one /health ping per 15s, less when the user is actively
// clicking around).

const MAX_SAMPLES = 60;

interface LatencySample {
    ms: number;
    ts: number;       // epoch ms
    ok: boolean;
    method: string;
    url: string;
}

const _state = $state<{ samples: LatencySample[]; lastMs: number | null; lastOk: boolean }>(
    { samples: [], lastMs: null, lastOk: true }
);

export const latencyState = _state;

export function recordLatency(sample: LatencySample) {
    _state.samples = [..._state.samples.slice(-(MAX_SAMPLES - 1)), sample];
    _state.lastMs = sample.ms;
    _state.lastOk = sample.ok;
}

export function clearLatency() {
    _state.samples = [];
    _state.lastMs = null;
    _state.lastOk = true;
}
