// Tiny focus trap for modal dialogs. Tabbing forward at the last focusable
// element wraps to the first; Tabbing back from the first wraps to the last.
// Returns a cleanup function.

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
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
