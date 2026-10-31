/** Mobile inbox search panel visibility (Outlook parity slice 31). */

export function shouldShowMobileSavedSearchPanel(
    panelOpen: boolean,
    savedCount: number,
    canSaveCurrentSearch: boolean,
    saveSearchFormOpen: boolean
): boolean {
    if (!panelOpen) return false;
    return savedCount > 0 || canSaveCurrentSearch || saveSearchFormOpen;
}
