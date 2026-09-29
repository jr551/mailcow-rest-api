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
// ── Styles ──────────────────────────────────────────────────────────────
// The packs are grouped into two labelled STYLES so the user can pick a
// coherent family instead of a flat list of nine unrelated noises:
//
//   outlook — restrained and non-jarring. Microsoft treats a notification
//             as ambient furniture: it should be identifiable, brief, and
//             never compete with whatever else is on screen.
//   gmail   — warmer and more percussive. Google's cues are built to be
//             *noticed* — a plucked, decaying "knock" that reads as a
//             physical tap rather than a chime.
//
// HONESTY NOTE — these are KNOCKOFFS, not samples. We ship zero audio
// bytes, so nothing here is a recording of Outlook's or Gmail's real cues;
// both products' sounds are recordings played through an audio pipeline we
// cannot observe. What is reproduced is the *character* of each: the
// interval structure, the attack (soft vs percussive), the decay length,
// and above all the loudness. Each family is tuned so the send cue stays
// quieter than the arrival cue — a send fires on every single message.
// Anyone expecting a byte-for-byte clone will be disappointed; the point
// is that a listener can tell the two families apart at a glance.
//
// 'ting' and 'blip' predate the style split and are now the original
// Outlook-ish cues, kept with their original ids so stored profiles that
// reference them still load. They are legacy members of `outlook`.
//
// On the default profile: 'chime'/'soft' are UNCHANGED. They are a
// deliberate user decision (see the event matrix above), and neither
// family is clearly better — 'chime' already reads as an arrival cue, and
// 'soft' already reads as a whoosh. The knockoffs ship as opt-in per
// event, one click away in Settings, grouped under their style heading.
//
// Master mute switch overrides everything (still here for backwards compat
// and the global-quiet toggle).

const STORAGE_KEY = 'webmail.sounds.muted';
const PROFILE_KEY = 'webmail.sounds.profile.v1';

// 'shred' is appended last, after the original six, so a stored profile
// written by an earlier build validates unchanged: the validator walks
// SOUND_EVENTS and falls back to DEFAULT_PROFILE for anything missing, so
// a new key is additive in both directions.
export type SoundEvent = 'notify' | 'sent' | 'click' | 'error' | 'sortDone' | 'voiceStart' | 'shred';

export type SoundStyle = 'outlook' | 'gmail';

// The six original ids keep their positions so a stored profile that says
// { notify: 'chime' } still validates; the knockoff members are appended.
export type SoundPack =
    | 'chime'  | 'soft'   | 'sci-fi' | 'ting' | 'blip' | 'silent'
    | 'out-arrival' | 'out-send' | 'out-error'
    | 'gm-mail' | 'gm-pop' | 'gm-drop'
    // Paper shredder. Appended after the Outlook and Gmail knockoffs so no
    // existing member moves: a stored profile's ids keep validating.
    | 'shred';

export interface SoundPackInfo {
    id: SoundPack;
    label: string;
    /**
     * Which family this pack belongs to. 'silent' is its own group (the
     * per-event mute); 'shred' is its own because a destructive-action cue
     * belongs to neither knockoff family, and filing it under one would
     * file it under a heading making a claim about character it does not.
     */
    style: SoundStyle | 'silent' | 'shred';
    /** One line on the character, shown in the picker so the choice is informed. */
    blurb: string;
}

// Single source of truth for the pack union. The Settings picker iterates
// this (rather than restating the list), so adding a member to SoundPack +
// an entry here + a playPack branch really is all it takes to expose a
// pack in the UI — that used to be a lie, because the picker hardcoded
// the four original ids and silently dropped anything else. isPack() and
// the stored-profile validator are both DERIVED from this array, so a new
// entry is valid on the next read with no second list to keep in step.
export const SOUND_PACKS: SoundPackInfo[] = [
    // ── Outlook knockoffs ────────────────────────────────────────────────
    { id: 'out-arrival', label: 'Outlook arrival', style: 'outlook',
      blurb: 'Soft two-note chime, barely there. The restrained default in this family.' },
    { id: 'out-send',    label: 'Outlook send',    style: 'outlook',
      blurb: 'One flat, quiet blip. Fires on every send, so it stays out of the way.' },
    { id: 'out-error',   label: 'Outlook error',   style: 'outlook',
      blurb: 'Low, muted double tone. Signals a problem without alarm.' },
    { id: 'ting',        label: 'Outlook ting',    style: 'outlook',
      blurb: 'The original E6→A6 pair. Brighter than the arrival chime; kept for existing profiles.' },
    { id: 'blip',        label: 'Send blip',       style: 'outlook',
      blurb: 'The original single send blip. Quietest cue in the file; kept for existing profiles.' },
    // ── Gmail knockoffs ──────────────────────────────────────────────────
    { id: 'gm-mail',     label: 'Gmail arrival',   style: 'gmail',
      blurb: 'Warm plucked knock — a decaying triad that reads as a tap on the shoulder.' },
    { id: 'gm-pop',      label: 'Gmail pop',       style: 'gmail',
      blurb: 'Bright two-note pop. The most noticeable arrival cue in the file.' },
    { id: 'gm-drop',     label: 'Gmail send',      style: 'gmail',
      blurb: 'Falling two-note figure. Cheerful confirmation that it went out.' },
    // ── Classic (predate the style split) + per-event mute ────────────────
    { id: 'chime',       label: 'Chime',           style: 'gmail',
      blurb: 'The original gentle two-note bell (D5 → A5). Still the default for new mail.' },
    { id: 'soft',        label: 'Soft',            style: 'outlook',
      blurb: 'The original descending whoosh. Still the default for send.' },
    { id: 'sci-fi',      label: 'Sci-fi',          style: 'gmail',
      blurb: 'Square-wave bleep. The one genuinely non-musical cue here.' },
    { id: 'silent',      label: 'Silent',          style: 'silent',
      blurb: 'No sound — per-event mute.' }
    ,
    { id: 'shred',       label: 'Shredder',        style: 'shred',
      blurb: 'Paper-shredding rattle. Fires when mail is permanently deleted — the only cue here about something being destroyed rather than arriving or leaving.' }
];

// Presentation order for the picker. The two families read as two coherent
// blocks, so the UI walks SOUND_STYLES and asks for the members of each —
// members keep their SOUND_PACKS order, so adding a pack never reshuffles
// the ones above it. SOUND_STYLES, not the styles present in SOUND_PACKS,
// so a family whose packs are all legacy still gets its heading.
export const SOUND_STYLES: { id: SoundPackInfo['style']; label: string; blurb: string }[] = [
    { id: 'outlook', label: 'Outlook knockoffs',
      blurb: 'Restrained and non-jarring — identifiable, brief, never competing with the screen.' },
    { id: 'gmail', label: 'Gmail knockoffs',
      blurb: 'Warmer and percussive — built to be noticed, like a tap rather than a chime.' },
    { id: 'shred', label: 'Destructive actions',
      blurb: 'Cues for things being removed rather than arriving or sent.' },
    { id: 'silent', label: 'Mute',
      blurb: 'Leaves the event silent, whatever else is set.' }
];

/** Packs of one style, in declaration order. Drives the grouped UI. */
export function packsInStyle(style: SoundPackInfo['style']): SoundPackInfo[] {
    return SOUND_PACKS.filter(p => p.style === style);
}

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
    ,
    { id: 'shred',      label: 'Messages deleted', description: 'Paper-shredding rattle when mail is permanently deleted, not filed.' }
];

const DEFAULT_PROFILE: Record<SoundEvent, SoundPack> = {
    notify:     'chime',
    sent:       'soft',
    error:      'silent',
    sortDone:   'silent',
    voiceStart: 'silent',
    click:      'silent',
    // Silent by default, like every other cue the user did not explicitly
    // opt into. A destructive action is exactly the one that should not
    // start making noise on every install.
    shred:      'silent'
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
        const parsed: unknown = JSON.parse(raw);
        // Reject a non-object payload explicitly rather than letting a
        // property access on null/number throw its way to the catch below
        // — same outcome, but the reason is legible instead of accidental.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ...DEFAULT_PROFILE };
        }
        const stored = parsed as Partial<Record<SoundEvent, SoundPack>>;
        const out = { ...DEFAULT_PROFILE };
        for (const ev of SOUND_EVENTS) {
            // isPack, not a literal id list, and isPack is derived from
            // SOUND_PACKS — so a profile referencing a pack that no longer
            // exists falls back to the default instead of poisoning the
            // Record with a bogus value, while a brand-new pack id is
            // accepted the moment it lands in SOUND_PACKS. There is no
            // second list to keep in step, which is exactly what made the
            // original 'ting'/'blip' packs unpickable.
            const v: unknown = stored[ev.id];
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

/**
 * One burst of band-passed noise — the primitive a mechanical sound needs
 * and the pitched helpers above cannot express.
 *
 * A shredder is not a note: it is a wideband scrape with a fast, irregular
 * envelope. Synthesising that from oscillators alone means either a
 * buzzing square (which reads as "error beep" — the exact confusion this
 * cue must not cause, because delete is not an error) or a pile of detuned
 * partials that still lands on a pitch. So this generates a short noise
 * buffer, band-passes it to the paper-tearing band (2-4 kHz, where tearing
 * actually lives) and gates it with its own decay.
 *
 * The band centre is a parameter, not a constant, so the three bursts in
 * the 'shred' pattern can sit at different frequencies. That is what stops
 * the pattern reading as one sample looped: an identical repeat is
 * recognisable as a repeat even at low volume, and a loop is the fastest
 * way to make a sound effect sound cheap.
 */
function noiseBurst(when: number, duration: number, centre: number, gain: number, q = 1.1) {
    const c = ctxOrNull();
    if (!c) return;
    const t0 = c.currentTime + when;
    // 0.25s of samples covers the longest burst below with room to spare.
    // The buffer is tiny and short-lived; reusing one forever would make
    // every burst bit-identical, which is the loop problem above.
    const frames = Math.max(1, Math.ceil(c.sampleRate * Math.min(duration + 0.05, 0.25)));
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) {
        // The tail is baked into the samples as well as gated by the gain
        // node: this is what stops each burst ending on a click.
        data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(centre, t0);
    band.Q.value = q;
    const env = c.createGain();
    // 4ms attack, not the 10-15ms the tonal helpers use: the mechanical
    // transient IS the sound here, and a slow fade-in turns a shred into a
    // swell.
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(band).connect(env).connect(c.destination);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
}

// Sound packs — each is a small synth pattern. Adding a new pack here +
// a new option in SoundPack + an entry in SOUND_PACKS is the only step
// required to expose it in the Settings UI; the dispatcher below picks
// it up automatically.
// Every branch is an APPROXIMATION of a real product's cue, not a sample
// of it (see the honesty note at the top of this file). What we control
// is the character:
//
//   outlook — pure sine, no transient, slow 10ms attack, peak gains at or
//             below the legacy packs. Long-ish decay, so it fades rather
//             than clicks. Triangle is deliberately avoided here: it has
//             a buzzy attack that reads as a notification you must attend
//             to, which is exactly what this family is not.
//   gmail   — triangle, immediate attack, short bright decays, higher
//             peaks. Percussive on purpose; this family is meant to be
//             noticed, the opposite of the Outlook family.
//   shred   — band-passed noise bursts, not pitched. See noiseBurst for
//             why: a destructive action cannot be signalled by a note
//             without reading as either a notification or an error.
//
// Send cues stay below the arrival cues in peak gain, so a confirmation
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
    } else if (pack === 'out-arrival') {
        // Outlook knockoff, arrival. A falling third (A5 → F5) is the
        // classic "something arrived, settle down" contour and reads
        // calmer than the legacy chime's rising fifth. Both notes sit low
        // in the register and peak at 0.13, under 'chime'. The second
        // note overlaps the first's tail so there is no audible gap.
        tone(880.00, 0,     0.20, 'sine', 0.13);  // A5
        tone(698.46, 0.115, 0.26, 'sine', 0.10);  // F5
    } else if (pack === 'out-send') {
        // Outlook knockoff, send. A single flat blip a step below the
        // legacy 'blip', so the two are audibly distinct but nearly
        // interchangeable; 0.07 is the joint-quietest peak in the file.
        tone(783.99, 0, 0.10, 'sine', 0.07);  // G5
    } else if (pack === 'out-error') {
        // Outlook knockoff, error. Two low sines a semitone apart, which
        // beat against each other without any harsh upper content — the
        // restrained way to say "that did not work". Held longer than the
        // arrival cue, so it is distinguishable by length alone.
        tone(311.13, 0,     0.22, 'sine', 0.12);  // Eb4
        tone(329.63, 0.14,  0.24, 'sine', 0.11);  // E4
    } else if (pack === 'gm-mail') {
        // Gmail knockoff, arrival. A major triad struck once and left to
        // ring: C5, then E5 and G5 together 40ms later. The overlap is
        // what makes it read as one percussive "knock" instead of an
        // arpeggio. Triangle gives the attack some body and 0.15 is the
        // highest peak in the file, because this family is meant to be
        // noticed.
        tone(523.25, 0,    0.22, 'triangle', 0.15);  // C5
        tone(659.25, 0.04, 0.20, 'triangle', 0.10);  // E5
        tone(783.99, 0.04, 0.20, 'triangle', 0.09);  // G5
    } else if (pack === 'gm-pop') {
        // Gmail knockoff, arrival, brighter option. A rising major third
        // (F5 → A5) with a very short first note: the gap-then-land shape
        // is what makes it a "pop" rather than another "chime".
        tone(698.46, 0,    0.09, 'triangle', 0.14);  // F5
        tone(880.00, 0.07, 0.16, 'triangle', 0.13);  // A5
    } else if (pack === 'gm-drop') {
        // Gmail knockoff, send. A falling fourth (G5 → D5) — the mirror of
        // the arrival cue's rise, so send and arrival are told apart by
        // direction alone, which survives being heard at low volume.
        // 0.11 peak, below the arrival cues, because it fires per send.
        tone(783.99, 0,    0.12, 'triangle', 0.11);  // G5
        tone(587.33, 0.09, 0.20, 'triangle', 0.10);  // D5
    } else if (pack === 'shred') {
        // Paper shredder: grab, tear, release, grab. Three short bursts that
        // each overlap the next slightly, so the gaps read as the machine's
        // rhythm rather than as three separate sounds. Each burst sits at a
        // different band centre — see noiseBurst on why an identical repeat
        // would read as a loop.
        //
        // Peak gain tops out at 0.10, below every arrival cue. Deleting mail
        // is feedback about a completed action, never a notification, and it
        // must not compete with new mail for attention.
        noiseBurst(0,     0.13, 2600, 0.10);
        noiseBurst(0.105, 0.14, 3400, 0.09);
        noiseBurst(0.215, 0.20, 2100, 0.075);
    }
    // An id we don't own (a profile written by a newer build, or a pack we
    // retired) falls through to silence rather than throwing. Silently
    // losing a cue beats breaking the caller that asked for it.
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
export function playShred()       { playEvent('shred'); }

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
