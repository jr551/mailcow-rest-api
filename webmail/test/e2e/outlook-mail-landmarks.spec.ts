import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mail landmarks (slice 17)', () => {
    test('exposes folder nav, message list, and reading pane regions', async ({ page }) => {
        await login(page);
        await expect(page.getByRole('banner', { name: 'Command bar' })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Mail folders' })).toBeVisible();
        await expect(page.getByTestId('mail-landmark-message-list')).toBeVisible();
        await page.getByTestId('msg-row-1001').click();
        await expect(page.getByTestId('mail-landmark-reading-pane')).toBeVisible();
        await expect(page.getByRole('main', { name: 'Reading pane' })).toBeVisible();
    });

    test('skip link moves focus to the message list landmark', async ({ page }) => {
        await login(page);
        const skip = page.getByTestId('mail-skip-link');
        await skip.focus();
        await expect(skip).toBeFocused();
        await skip.click();
        const listLandmark = page.locator(`#mail-message-list-landmark`);
        await expect(listLandmark).toBeFocused();
    });
});
