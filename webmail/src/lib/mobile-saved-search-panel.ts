/** Mobile inbox search panel visibility (Outlook parity slice 31). */

export function shouldShowMobileSavedSearchPanel(
    panelOpen: boolean,
    savedCount: number,
    canSaveCurrentSearch: boolean,
    saveSearchFormOpen: boolean,
    /** People category shows contact matches instead of running IMAP search (slice 53). */
    peopleSearchActive = false
): boolean {
    if (!panelOpen) return false;
    if (peopleSearchActive) return true;
    return savedCount > 0 || canSaveCurrentSearch || saveSearchFormOpen;
}
