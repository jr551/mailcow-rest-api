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

test.describe('Outlook compose focus return (slice 47)', () => {
    test('Discard on reply compose focuses the reading pane landmark', async ({ page }) => {
        await login(page);
        await page.getByTestId('msg-row-1001').click();
        await expect(page.locator('#mail-reading-pane-landmark')).toBeFocused();
        await page.keyboard.press('r');
        await expect(page.getByTestId('compose-to')).toBeVisible();
        await page.getByTestId('compose-discard').click();
        await expect(page.getByTestId('compose-to')).not.toBeVisible();
        await expect(page.locator('#mail-reading-pane-landmark')).toBeFocused();
    });
});
