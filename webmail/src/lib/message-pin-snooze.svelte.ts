import {
    MESSAGE_PIN_SNOOZE_STORAGE_KEY,
    emptyPinSnoozeOverlay,
    messageOverlayKey,
    pruneExpiredSnooze,
    sanitizePinSnoozeOverlay,
    type PinSnoozeOverlay,
    type SnoozePresetId,
    snoozeUntilForPreset
} from './message-pin-snooze';

const _overlay = $state<PinSnoozeOverlay>(emptyPinSnoozeOverlay());

let hydrated = false;

function persist() {
    try {
        localStorage.setItem(MESSAGE_PIN_SNOOZE_STORAGE_KEY, JSON.stringify(_overlay));
    } catch { /* quota */ }
}

export function hydrateMessagePinSnooze() {
    if (hydrated) return;
    hydrated = true;
    try {
        const raw = localStorage.getItem(MESSAGE_PIN_SNOOZE_STORAGE_KEY);
        if (raw === null) return;
        const parsed = sanitizePinSnoozeOverlay(JSON.parse(raw));
        _overlay.pinned = parsed.pinned;
        _overlay.snoozeUntil = parsed.snoozeUntil;
    } catch {
        Object.assign(_overlay, emptyPinSnoozeOverlay());
    }
}

export function pinSnoozeOverlay(): PinSnoozeOverlay {
    return _overlay;
}

export function toggleMessagePin(mailboxPath: string, uid: number) {
    const key = messageOverlayKey(mailboxPath, uid);
    if (_overlay.pinned[key]) {
        const next = { ..._overlay.pinned };
        delete next[key];
        _overlay.pinned = next;
    } else {
        _overlay.pinned = { ..._overlay.pinned, [key]: true };
    }
    persist();
}

export function snoozeMessage(mailboxPath: string, uid: number, preset: SnoozePresetId, nowMs = Date.now()) {
    const key = messageOverlayKey(mailboxPath, uid);
    const until = snoozeUntilForPreset(preset, nowMs);
    _overlay.snoozeUntil = { ..._overlay.snoozeUntil, [key]: until };
    persist();
}

export function clearMessageSnooze(mailboxPath: string, uid: number) {
    const key = messageOverlayKey(mailboxPath, uid);
    if (!(key in _overlay.snoozeUntil)) return;
    const next = { ..._overlay.snoozeUntil };
    delete next[key];
    _overlay.snoozeUntil = next;
    persist();
}

export function tickPinSnoozeOverlay(nowMs = Date.now()) {
    const pruned = pruneExpiredSnooze(_overlay, nowMs);
    if (pruned === _overlay) return;
    _overlay.snoozeUntil = pruned.snoozeUntil;
    persist();
}

export function remapPinSnoozeOverlay(oldPath: string, newPath: string) {
    if (oldPath === newPath) return;
    const remapKey = (k: string): string => {
        const sep = k.indexOf('\u0000');
        if (sep === -1) return k;
        const path = k.slice(0, sep);
        const uid = k.slice(sep + 1);
        return path === oldPath ? messageOverlayKey(newPath, Number(uid)) : k;
    };
    const pinned: Record<string, true> = {};
    let pinChanged = false;
    for (const k of Object.keys(_overlay.pinned)) {
        const nk = remapKey(k);
        if (nk !== k) pinChanged = true;
        pinned[nk] = true;
    }
    const snoozeUntil: Record<string, number> = {};
    let snChanged = false;
    for (const [k, v] of Object.entries(_overlay.snoozeUntil)) {
        const nk = remapKey(k);
        if (nk !== k) snChanged = true;
        snoozeUntil[nk] = v;
    }
    if (!pinChanged && !snChanged) return;
    _overlay.pinned = pinned;
    _overlay.snoozeUntil = snoozeUntil;
    persist();
}
