// Voice features for the AI chat surface.
//
// As of the May-2026 swap, this lives entirely on-device using the
// browser's Web Speech API (SpeechSynthesis for output + SpeechRecognition
// for input). No server roundtrip, no third-party API key, no per-turn
// network cost — the lightest possible TTS implementation.
//
// The exported names (speakWithElevenLabs, ELEVEN_VOICES) are kept for
// source-level compatibility with the surfaces that already imported
// them; new code should prefer `speak()` and `LOCAL_VOICES`.
//
// User prefs (voice on/off, picked voice URI) persist in localStorage
// so they survive reloads.

import { capabilities } from './settings.svelte';

const VOICE_KEY = 'webmail.ai.voice.v1';

export interface LocalVoice {
    id: string;     // SpeechSynthesisVoice.voiceURI
    name: string;   // human label
    lang: string;
    isDefault?: boolean;
}

// Populated lazily — voices on most platforms load asynchronously after
// the first speechSynthesis access. We refresh the list on the
// `voiceschanged` event so the picker shows the right options.
let _voices: LocalVoice[] = [];

function isSpeechSynthesisAvailable(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function loadVoices() {
    if (!isSpeechSynthesisAvailable()) { _voices = []; return; }
    const raw = window.speechSynthesis.getVoices();
    _voices = raw.map((v) => ({
        id: v.voiceURI || v.name,
        name: v.name,
        lang: v.lang,
        isDefault: v.default
    }));
}

if (isSpeechSynthesisAvailable()) {
    // First call may return [] until voices load.
    loadVoices();
    try {
        window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
    } catch { /* older Safari */ }
}

export function listLocalVoices(): LocalVoice[] {
    if (_voices.length === 0) loadVoices();
    return _voices;
}

// Legacy export — same shape as the old hard-coded ElevenLabs list,
// but now backed by the system's installed voices. The Settings surface
// can render it directly without changes.
export const ELEVEN_VOICES: { id: string; name: string }[] = new Proxy([], {
    get(_t, prop) {
        const v = listLocalVoices();
        if (prop === 'length') return v.length;
        const idx = Number(prop);
        if (!Number.isNaN(idx)) return v[idx];
        // Fall through to Array prototype methods
        return (v as unknown as Record<string | symbol, unknown>)[prop];
    }
}) as { id: string; name: string }[];

interface VoicePrefs {
    enabled: boolean;
    voiceId: string;
    speakUserToo: boolean;
}

function readPrefs(): VoicePrefs {
    try {
        const raw = localStorage.getItem(VOICE_KEY);
        if (!raw) return { enabled: false, voiceId: '', speakUserToo: false };
        const p = JSON.parse(raw);
        return {
            enabled: !!p.enabled,
            voiceId: typeof p.voiceId === 'string' ? p.voiceId : '',
            speakUserToo: !!p.speakUserToo
        };
    } catch {
        return { enabled: false, voiceId: '', speakUserToo: false };
    }
}

function writePrefs(p: VoicePrefs) {
    try { localStorage.setItem(VOICE_KEY, JSON.stringify(p)); } catch { /* quota */ }
}

const _state = $state<VoicePrefs>(readPrefs());
export const voicePrefs = _state;

export function setVoiceEnabled(on: boolean) {
    _state.enabled = on;
    writePrefs(_state);
    if (!on) stopSpeaking();
}
export function setVoiceId(id: string) {
    _state.voiceId = id;
    writePrefs(_state);
}

// Voice is "available" whenever the browser exposes SpeechSynthesis.
// The legacy server `ttsConfig` is no longer required — we keep
// reading it only to bias the default-on for users who already opted
// into voice on the previous (ElevenLabs-backed) build.
export function isVoiceAvailable(): boolean {
    if (!isSpeechSynthesisAvailable()) {
        // Last-resort: if there's still a server TTS config, the caller
        // can route through that — but the in-tree implementation is
        // the local one, so this branch is mostly dead.
        return !!capabilities.ttsConfig?.configured;
    }
    return true;
}

let currentUtterance: SpeechSynthesisUtterance | null = null;
let stopRequested = false;

/** Stop any in-flight speech. */
export function stopSpeaking() {
    stopRequested = true;
    if (isSpeechSynthesisAvailable()) {
        try { window.speechSynthesis.cancel(); } catch { /* */ }
    }
    currentUtterance = null;
}

function pickVoice(): SpeechSynthesisVoice | null {
    if (!isSpeechSynthesisAvailable()) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    if (_state.voiceId) {
        const m = voices.find((v) => (v.voiceURI || v.name) === _state.voiceId);
        if (m) return m;
    }
    // Prefer a local voice in the user's UI language so latency stays
    // zero and accents match expectations.
    const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en-US') || 'en-US';
    const langPrefix = lang.split('-')[0];
    return (
        voices.find((v) => v.localService && v.lang.startsWith(lang)) ||
        voices.find((v) => v.localService && v.lang.startsWith(langPrefix)) ||
        voices.find((v) => v.lang.startsWith(lang)) ||
        voices.find((v) => v.default) ||
        voices[0]
    );
}

/**
 * Speak `text` using the browser's local SpeechSynthesis engine. Cancels
 * any prior utterance so the most recent assistant message wins (avoids
 * overlapping voices when the user fires off two messages quickly).
 *
 * The legacy name `speakWithElevenLabs` is preserved so callers that
 * imported it continue to work; under the hood it now uses Web Speech.
 */
export async function speak(text: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (!text.trim()) return;
    if (!isSpeechSynthesisAvailable()) {
        throw new Error('This browser does not support speech synthesis.');
    }
    stopSpeaking();
    stopRequested = false;
    // Cap length so a runaway reply doesn't tie up the synth queue.
    const trimmed = text.length > 2400 ? text.slice(0, 2400) + '…' : text;
    const utt = new SpeechSynthesisUtterance(trimmed);
    const voice = pickVoice();
    if (voice) {
        utt.voice = voice;
        utt.lang = voice.lang;
    }
    // Match the cadence the ElevenLabs build had — slightly more
    // expressive than the SpeechSynthesis defaults.
    utt.rate = 1.0;
    utt.pitch = 1.0;
    utt.volume = 1.0;
    currentUtterance = utt;

    return new Promise<void>((resolve, reject) => {
        if (opts.signal) {
            if (opts.signal.aborted) {
                stopSpeaking();
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            opts.signal.addEventListener('abort', () => {
                stopSpeaking();
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        }
        utt.onend = () => {
            currentUtterance = null;
            if (stopRequested) return; // already rejected/cancelled
            resolve();
        };
        utt.onerror = (e) => {
            currentUtterance = null;
            // 'canceled' / 'interrupted' are intentional stops, not real
            // errors — resolve quietly so the caller doesn't show a toast.
            if (e.error === 'canceled' || e.error === 'interrupted') {
                resolve();
                return;
            }
            reject(new Error(`Speech synthesis error: ${e.error || 'unknown'}`));
        };
        try {
            window.speechSynthesis.speak(utt);
        } catch (err) {
            currentUtterance = null;
            reject(err);
        }
    });
}

/** Legacy alias preserved for existing call sites. */
export const speakWithElevenLabs = speak;

// --- Mic input via the browser's Web Speech API ---------------------------
//
// Free + on-device on most browsers. No server roundtrip. Falls back to
// nothing if the API isn't present (Safari supports webkitSpeechRecognition;
// Chrome / Edge support both; Firefox lacks both).

interface RecognitionWrapper {
    start: () => void;
    stop: () => void;
    /** Cumulative transcript: every finalized segment from this session
     *  joined together, plus the latest interim. The boolean flags whether
     *  any new final was just produced. */
    onResult: (cb: (transcript: string, gotFinal: boolean) => void) => void;
    onEnd: (cb: () => void) => void;
    onError: (cb: (err: string) => void) => void;
}

interface SpeechRecognitionLike {
    new (): SpeechRecognitionLike;
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start: () => void;
    stop: () => void;
    onresult: ((e: { results: { isFinal: boolean; 0: { transcript: string } }[]; resultIndex: number }) => void) | null;
    onend: (() => void) | null;
    onerror: ((e: { error: string }) => void) | null;
}

export function isSttAvailable(): boolean {
    if (typeof window === 'undefined') return false;
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function createSpeechRecognizer(opts: { continuous?: boolean } = {}): RecognitionWrapper | null {
    if (!isSttAvailable()) return null;
    const w = window as unknown as { SpeechRecognition?: SpeechRecognitionLike; webkitSpeechRecognition?: SpeechRecognitionLike };
    const Ctor = (w.SpeechRecognition || w.webkitSpeechRecognition)!;
    const rec = new Ctor();
    rec.continuous = opts.continuous ?? false;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    let resultCb: ((t: string, isFinal: boolean) => void) | null = null;
    let endCb: (() => void) | null = null;
    let errCb: ((e: string) => void) | null = null;

    // Walk the full results list every time so consumers get cumulative
    // text across the whole session, not just the latest delta. The Web
    // Speech API's per-event `resultIndex` only covers what changed in
    // *this* event, which made the previous "interim overwrites final"
    // bug drop earlier sentences if onresult fired between finals.
    rec.onresult = (e) => {
        let finalText = '';
        let interim = '';
        let gotFinal = false;
        for (let i = 0; i < e.results.length; i++) {
            const seg = e.results[i][0].transcript;
            if (e.results[i].isFinal) {
                finalText += seg;
                if (i >= e.resultIndex) gotFinal = true;
            } else {
                interim += seg;
            }
        }
        resultCb?.((finalText + interim).trim(), gotFinal);
    };
    rec.onend = () => endCb?.();
    rec.onerror = (e) => errCb?.(e.error || 'unknown');

    return {
        start: () => rec.start(),
        stop: () => rec.stop(),
        onResult: (cb) => { resultCb = cb; },
        onEnd: (cb) => { endCb = cb; },
        onError: (cb) => { errCb = cb; }
    };
}
