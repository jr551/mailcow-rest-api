import { test, expect, type Page } from '@playwright/test';
import { applyMocks, login } from './fixtures';

// "Compose history summary" (Settings → Compose) hides the history panel above
// the compose box. It used to hide ONLY the panel: the effect that runs the
// two IMAP searches and the model call behind it gated on `aiFeatures` alone,
// so with the switch off the work still happened — invisibly, and at the
// user's token cost. These tests pin the switch to the work, not the pixels.

const SETTINGS_KEY = 'webmail.settings.v1';

/** The history lookup searches INBOX and Sent for the recipient. */
function historySearches(page: Page) {
    const hits: string[] = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('/v1/mailboxes/') && url.includes('search=from')) hits.push(url);
    });
    return hits;
}

async function seed(page: Page, composeHistorySummary: boolean) {
    await page.addInitScript(
        ([key, blob]) => localStorage.setItem(key as string, blob as string),
        [SETTINGS_KEY, JSON.stringify({ composeHistorySummary, aiFeatures: true })] as const
    );
}

async function openComposeWithRecipient(page: Page, to: string) {
    await login(page);
    await page.click('[data-testid=compose-btn]');
    await expect(page.getByTestId('compose-modal')).toBeVisible();
    await page.fill('[data-testid=compose-to]', to);
    // The lookup is debounced 600ms; give it room to fire if it were going to.
    await page.waitForTimeout(2000);
}

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('history summary off: no history search leaves the browser', async ({ page }) => {
    await seed(page, false);
    const searches = historySearches(page);
    await openComposeWithRecipient(page, 'concierge@example.com');

    expect(searches, 'the switch is off — nothing may be fetched').toEqual([]);
    await expect(page.getByTestId('compose-history-panel')).toHaveCount(0);
});

test('history summary on: the lookup runs and the panel renders', async ({ page }) => {
    // The control case: without it, the test above could pass because the
    // mock never fires at all.
    await seed(page, true);
    const searches = historySearches(page);
    await openComposeWithRecipient(page, 'concierge@example.com');

    expect(searches.length, 'the lookup must actually run when the switch is on').toBeGreaterThan(0);
    await expect(page.getByTestId('compose-history-panel')).toBeVisible();
});
