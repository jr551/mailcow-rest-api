import {
    MESSAGE_FOLLOW_UP_STORAGE_KEY,
    emptyFollowUpOverlay,
    followUpDueForPreset,
    followUpOverlayKey,
    sanitizeFollowUpOverlay,
    type FollowUpOverlay,
    type FollowUpPresetId
} from './message-follow-up';

const _overlay = $state<FollowUpOverlay>(emptyFollowUpOverlay());

let hydrated = false;

function persist() {
    try {
        localStorage.setItem(MESSAGE_FOLLOW_UP_STORAGE_KEY, JSON.stringify(_overlay));
    } catch { /* quota */ }
}

export function hydrateMessageFollowUp() {
    if (hydrated) return;
    hydrated = true;
    try {
        const raw = localStorage.getItem(MESSAGE_FOLLOW_UP_STORAGE_KEY);
        if (raw === null) return;
        const parsed = sanitizeFollowUpOverlay(JSON.parse(raw));
        _overlay.dueBy = parsed.dueBy;
    } catch {
        Object.assign(_overlay, emptyFollowUpOverlay());
    }
}

export function followUpOverlay(): FollowUpOverlay {
    return _overlay;
}

export function setFollowUpDue(
    mailboxPath: string,
    uid: number,
    preset: FollowUpPresetId,
    nowMs = Date.now()
) {
    const key = followUpOverlayKey(mailboxPath, uid);
    const due = followUpDueForPreset(preset, nowMs);
    const next = { ..._overlay.dueBy };
    if (due === null) delete next[key];
    else next[key] = due;
    _overlay.dueBy = next;
    persist();
}

export function clearFollowUpDue(mailboxPath: string, uid: number) {
    const key = followUpOverlayKey(mailboxPath, uid);
    if (!(key in _overlay.dueBy)) return;
    const next = { ..._overlay.dueBy };
    delete next[key];
    _overlay.dueBy = next;
    persist();
}

export function remapFollowUpOverlay(oldPath: string, newPath: string) {
    if (oldPath === newPath) return;
    const remapKey = (k: string): string => {
        const sep = k.indexOf('\u0000');
        if (sep === -1) return k;
        const path = k.slice(0, sep);
        const uid = k.slice(sep + 1);
        return path === oldPath ? followUpOverlayKey(newPath, Number(uid)) : k;
    };
    const dueBy: Record<string, number> = {};
    let changed = false;
    for (const [k, v] of Object.entries(_overlay.dueBy)) {
        const nk = remapKey(k);
        if (nk !== k) changed = true;
        dueBy[nk] = v;
    }
    if (!changed) return;
    _overlay.dueBy = dueBy;
    persist();
}
