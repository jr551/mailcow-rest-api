// In-app sound effects — synthesized with Web Audio API so we don't bundle
// audio files (and they always work offline).
//
// Event matrix (default → "soft" / "off" balance the user explicitly asked
// for: only the canonical "you have new mail" + "you sent something" fire
// out of the box, everything else is opt-in):
//
//   notify     → 'chime'      | sortDone   → 'silent'
//   sent       → 'soft'       | voiceStart → 'silent'
//   error      → 'silent'     | click      → 'silent'
//
// Each event picks one of four preset packs:
//   chime  — gentle two-note bell
//   soft   — short descending whoosh
//   sci-fi — square-wave bleep
//   silent — no sound (per-event mute)
//
// Master mute switch overrides everything (still here for backwards compat
// and the global-quiet toggle).

const STORAGE_KEY = 'webmail.sounds.muted';
const PROFILE_KEY = 'webmail.sounds.profile.v1';

export type SoundPack = 'chime' | 'soft' | 'sci-fi' | 'silent';
export type SoundEvent = 'notify' | 'sent' | 'click' | 'error' | 'sortDone' | 'voiceStart';

export const SOUND_EVENTS: { id: SoundEvent; label: string; description: string }[] = [
    { id: 'notify',     label: 'New mail arrives', description: 'Foreground chime when fresh mail lands.' },
    { id: 'sent',       label: 'Message sent',     description: 'Confirmation when send completes.' },
    { id: 'error',      label: 'Error pop',        description: 'Soft cue when an action fails.' },
    { id: 'sortDone',   label: 'AI sort finished', description: 'When the AI sort returns rankings.' },
    { id: 'voiceStart', label: 'Voice listening',  description: 'Plays as the voice mic activates.' },
    { id: 'click',      label: 'Row navigation',   description: 'Tiny tick on j/k row movement.' }
];

const DEFAULT_PROFILE: Record<SoundEvent, SoundPack> = {
    notify:     'chime',
    sent:       'soft',
    error:      'silent',
    sortDone:   'silent',
    voiceStart: 'silent',
    click:      'silent'
};

interface SoundsState {
    muted: boolean;
    contextLost: boolean; // browsers block AudioContext until first user gesture
    profile: Record<SoundEvent, SoundPack>;
}

const state = $state<SoundsState>({
    muted: load(),
    contextLost: false,
    profile: loadProfile()
});

export const sounds = state;

function load(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

function loadProfile(): Record<SoundEvent, SoundPack> {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        if (!raw) return { ...DEFAULT_PROFILE };
        const parsed = JSON.parse(raw) as Partial<Record<SoundEvent, SoundPack>>;
        const out = { ...DEFAULT_PROFILE };
        for (const ev of SOUND_EVENTS) {
            const v = parsed[ev.id];
            if (v === 'chime' || v === 'soft' || v === 'sci-fi' || v === 'silent') out[ev.id] = v;
        }
        return out;
    } catch { return { ...DEFAULT_PROFILE }; }
}

function persist() {
    try { localStorage.setItem(STORAGE_KEY, state.muted ? '1' : '0'); } catch { /* noop */ }
}

function persistProfile() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); } catch { /* noop */ }
}

export function setMuted(muted: boolean) {
    state.muted = muted;
    persist();
}

export function setEventPack(event: SoundEvent, pack: SoundPack) {
    state.profile = { ...state.profile, [event]: pack };
    persistProfile();
}

export function resetSoundProfile() {
    state.profile = { ...DEFAULT_PROFILE };
    persistProfile();
}

let ctx: AudioContext | null = null;
function ctxOrNull(): AudioContext | null {
    if (state.muted) return null;
    if (!ctx) {
        try {
            const Ctor: typeof AudioContext | undefined =
                (window as any).AudioContext || (window as any).webkitAudioContext;
            if (!Ctor) return null;
            ctx = new Ctor();
        } catch {
            return null;
        }
    }
    if (ctx.state === 'suspended') {
        // Will be resumed on first user gesture; we don't auto-resume here.
        ctx.resume().catch(() => { state.contextLost = true; });
    }
    return ctx;
}

function tone(freq: number, when: number, duration: number, type: OscillatorType = 'sine', gain = 0.18) {
    const c = ctxOrNull();
    if (!c) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(env).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
}

function sweep(from: number, to: number, when: number, duration: number, gain = 0.16) {
    const c = ctxOrNull();
    if (!c) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(80, to), t0 + duration);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(env).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
}

// Sound packs — each is a small synth pattern. Adding a new pack here +
// a new option in SoundPack is the only step required to expose it
// in the Settings UI; the dispatcher below picks it up automatically.
function playPack(pack: SoundPack) {
    if (pack === 'silent') return;
    if (pack === 'chime') {
        tone(587.33, 0,    0.18, 'sine', 0.18);  // D5
        tone(880.00, 0.10, 0.22, 'sine', 0.16);  // A5
    } else if (pack === 'soft') {
        sweep(660, 220, 0, 0.22, 0.14);
    } else if (pack === 'sci-fi') {
        tone(880, 0,     0.06, 'square', 0.10);
        tone(1320, 0.06, 0.08, 'square', 0.10);
        tone(660, 0.16,  0.12, 'square', 0.08);
    }
}

function playEvent(event: SoundEvent) {
    if (state.muted) return;
    const pack = state.profile[event] || 'silent';
    playPack(pack);
}

// Public cues — kept as named functions so the call sites don't need
// to know about the SoundEvent enum.
export function playNotify()      { playEvent('notify'); }
export function playSent()        { playEvent('sent'); }
export function playClick()       { playEvent('click'); }
export function playError()       { playEvent('error'); }
export function playSortDone()    { playEvent('sortDone'); }
export function playVoiceStart()  { playEvent('voiceStart'); }

/** Play any pack on demand — used by the Settings preview button. */
export function previewPack(pack: SoundPack) {
    if (state.muted) return;
    playPack(pack);
}

// Many browsers require a user gesture before AudioContext can produce sound.
// Layout calls primeAudio() on the first click so subsequent programmatic
// plays don't fail silently.
export function primeAudio() {
    const c = ctxOrNull();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
}
