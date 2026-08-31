// Persistent credential store for "Stay signed in".
//
// SESSION TOKENS expire after ~1 hour. The bare-minimum way to "stay signed
// in" across days is to keep the original Basic credentials around so we
// can call POST /v1/auth/session again when the token's about to expire.
//
// This is a classic web-mail trade-off — keeping a password in the user's
// browser. We mitigate (not solve) by:
//   * Opt-in only — the login form has a "Stay signed in" checkbox.
//   * Lightweight obfuscation with a per-installation key (XOR + base64).
//     Won't stop a determined attacker who already has localStorage access,
//     but at least the password isn't sitting in plaintext.
//   * One entry per account, scoped to the current origin (browser-isolated
//     anyway).
//   * Easy to forget: Settings exposes a "Forget device" button.
//
// If the user *doesn't* opt in, nothing is persisted — they'll be bounced
// to the login screen when their session token expires (status quo).

const KEY_INSTALL = 'webmail.install-id';
const KEY_VAULT = 'webmail.creds.v1';

function installKey(): string {
    try {
        let id = localStorage.getItem(KEY_INSTALL);
        if (!id) {
            id = Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem(KEY_INSTALL, id);
        }
        return id;
    } catch {
        return 'fallback';
    }
}

function xorBase64(value: string, key: string): string {
    const bytes = new TextEncoder().encode(value);
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        out[i] = bytes[i] ^ key.charCodeAt(i % key.length);
    }
    let bin = '';
    for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
    return btoa(bin);
}

function fromB64Xor(b64: string, key: string): string {
    try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const out = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
            out[i] = bytes[i] ^ key.charCodeAt(i % key.length);
        }
        return new TextDecoder().decode(out);
    } catch {
        return '';
    }
}

interface VaultEntry { user: string; payload: string }

function readVault(): VaultEntry[] {
    try {
        const raw = localStorage.getItem(KEY_VAULT);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((e) => e && typeof e.user === 'string' && typeof e.payload === 'string');
    } catch { /* noop */ }
    return [];
}

function writeVault(entries: VaultEntry[]) {
    try {
        if (!entries.length) localStorage.removeItem(KEY_VAULT);
        else localStorage.setItem(KEY_VAULT, JSON.stringify(entries));
    } catch { /* quota */ }
}

export function rememberCreds(user: string, pass: string) {
    const key = installKey();
    const payload = xorBase64(JSON.stringify({ user, pass, savedAt: Date.now() }), key);
    const vault = readVault().filter((e) => e.user !== user);
    vault.push({ user, payload });
    writeVault(vault);
}

export function recallCreds(user: string): { user: string; pass: string } | null {
    const entry = readVault().find((e) => e.user === user);
    if (!entry) return null;
    const key = installKey();
    try {
        const decoded = fromB64Xor(entry.payload, key);
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed.user === 'string' && typeof parsed.pass === 'string') {
            return { user: parsed.user, pass: parsed.pass };
        }
    } catch { /* noop */ }
    return null;
}

export function forgetCreds(user: string) {
    writeVault(readVault().filter((e) => e.user !== user));
}

export function forgetAllCreds() {
    writeVault([]);
}

export function rememberedUsers(): string[] {
    return readVault().map((e) => e.user);
}
