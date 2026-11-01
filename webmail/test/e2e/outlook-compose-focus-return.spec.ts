import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook compose focus return (slice 45)', () => {
    test('Discard closes compose and focuses the message list landmark', async ({ page }) => {
        await login(page);
        await page.keyboard.press('n');
        await expect(page.getByTestId('compose-to')).toBeVisible();
        await page.getByTestId('compose-discard').click();
        await expect(page.getByTestId('compose-to')).not.toBeVisible();
        await expect(page.locator('#mail-message-list-landmark')).toBeFocused();
    });
});
