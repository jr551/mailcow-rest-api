// Resolves false when the browser refuses (insecure origin, permission
// denied, no Clipboard API) so callers can report the failure honestly.
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}
