// Dependency-free active-account identity for async work that must not cross
// account switches. Kept separate from auth.svelte so error reporting can use
// it without creating an auth -> api -> error-doctor -> auth import cycle.
let activeUser: string | null | undefined;
const listeners = new Set<(user: string | null) => void>();

export function getAccountUser(): string | null | undefined {
    return activeUser;
}

export function setAccountUser(user: string | null): void {
    if (activeUser === user) return;
    activeUser = user;
    for (const listener of listeners) listener(user);
}

export function onAccountUserChange(listener: (user: string | null) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
