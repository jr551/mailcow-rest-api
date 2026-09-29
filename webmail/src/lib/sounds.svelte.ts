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
// Each event picks one of six preset packs:
//   chime  — gentle two-note bell (D5 → A5)
//   soft   — short descending whoosh
//   ting   — Outlook-style new-mail "ting" (E6 → A6), very quiet
//   blip   — Outlook-style single send blip, quietest cue in the file
//   sci-fi — square-wave bleep
//   silent — no sound (per-event mute)
//
// On the default profile: 'chime'/'soft' are left as the defaults. They
// were a deliberate user decision (see the matrix at the top of this
// file) and 'ting'/'blip' are only an APPROXIMATION of Outlook's cues —
// the real ones are recordings. Defaulting every new install to an
// approximation of a competitor's branding is a worse first impression
// than keeping the pair the user already chose, so the new packs ship as
// opt-in per event, one click away in Settings.
//
// Master mute switch overrides everything (still here for backwards compat
// and the global-quiet toggle).

const STORAGE_KEY = 'webmail.sounds.muted';
const PROFILE_KEY = 'webmail.sounds.profile.v1';

export type SoundPack = 'chime' | 'soft' | 'sci-fi' | 'ting' | 'blip' | 'silent';
export type SoundEvent = 'notify' | 'sent' | 'click' | 'error' | 'sortDone' | 'voiceStart';

// Single source of truth for the pack union. The Settings picker iterates
// this (rather than restating the list), so adding a member to SoundPack +
// an entry here + a playPack branch really is all it takes to expose a
// pack in the UI — that used to be a lie, because the picker hardcoded
// the four original ids and silently dropped anything else.
export const SOUND_PACKS: { id: SoundPack; label: string }[] = [
    { id: 'chime',  label: 'Chime' },
    { id: 'soft',   label: 'Soft' },
    { id: 'ting',   label: 'Outlook ting' },
    { id: 'blip',   label: 'Send blip' },
    { id: 'sci-fi', label: 'Sci-fi' },
    { id: 'silent', label: 'Silent' }
];

// Static id → true table rather than a Set: the key set is fixed at
// module load and never mutated, so a Record literal is the honest
// shape. Membership check is isPack().
const PACK_IDS: Record<string, true> = Object.fromEntries(
    SOUND_PACKS.map(p => [p.id, true])
);

function isPack(v: unknown): v is SoundPack {
    return typeof v === 'string' && PACK_IDS[v] === true;
}

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
            // isPack, not a literal id list: a stored profile referencing a
            // pack that no longer exists falls back to the default instead
            // of poisoning the Record with a bogus value.
            const v: unknown = parsed[ev.id];
            if (isPack(v)) out[ev.id] = v;
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
// a new option in SoundPack + an entry in SOUND_PACKS is the only step
// required to expose it in the Settings UI; the dispatcher below picks
// it up automatically.
//
// 'ting' and 'blip' are APPROXIMATIONS of Outlook's real cues, not
// samples of them. Microsoft's are recordings of struck metal and
// filtered noise through a hardware-ish chain; the closest we get
// without shipping audio is a sine pair that shares the contour. What
// matters here is the CHARACTER: quiet, brief, no sharp transients,
// nothing that startles. Peak gains sit well below 'chime' so a cue
// never competes with the notification that triggered it.
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
    } else if (pack === 'ting') {
        // Outlook new mail: a soft two-note "ting". E6 → A6 is a perfect
        // fourth rather than the chime's perfect fifth, which reads
        // brighter and more "something arrived" without being louder.
        // The second note is quieter and carries the decay, so the cue
        // trails off over ~0.28s instead of stopping dead.
        tone(1318.51, 0,     0.13, 'sine', 0.11);  // E6
        tone(1760.00, 0.085, 0.20, 'sine', 0.085); // A6
    } else if (pack === 'blip') {
        // Outlook send: one restrained blip. Flat rather than sweeping,
        // and the lowest non-zero peak gain in the file — this fires on
        // every send, so it must be the least obtrusive cue we own.
        tone(880, 0, 0.09, 'sine', 0.075);  // A5
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
