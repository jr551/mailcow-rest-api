// Tiny focus trap for modal dialogs. Tabbing forward at the last focusable
// element wraps to the first; Tabbing back from the first wraps to the last.
// Returns a cleanup function.

// `[tabindex]:not([tabindex="-1"])` on its own is not enough, and getting
// this wrong makes the trap silently inert rather than obviously broken.
// A roving-tabindex radiogroup (the correct ARIA pattern for a row of
// swatches or a segmented control) leaves every unselected member at
// tabindex="-1": still focusable from script, but NOT in the browser's Tab
// order. Selecting them here made this list longer than the real tab
// sequence, so `last` was a node Tab could never land on, the wrap branch
// never fired, and focus walked straight out of the open panel.
// Every selector therefore excludes tabindex="-1" explicitly.
const FOCUSABLE = [
    'a[href]:not([tabindex="-1"])',
    'button:not([disabled]):not([tabindex="-1"])',
    'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
    'select:not([disabled]):not([tabindex="-1"])',
    'textarea:not([disabled]):not([tabindex="-1"])',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

export function trapFocus(container: HTMLElement): () => void {
    function getNodes(): HTMLElement[] {
        return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
            .filter((el) => el.offsetParent !== null);
    }

    function onKey(e: KeyboardEvent) {
        if (e.key !== 'Tab') return;
        const nodes = getNodes();
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    }

    container.addEventListener('keydown', onKey);

    // Move initial focus to the first focusable element if focus is outside.
    queueMicrotask(() => {
        const nodes = getNodes();
        if (nodes.length && !container.contains(document.activeElement)) {
            nodes[0].focus();
        }
    });

    return () => container.removeEventListener('keydown', onKey);
}
