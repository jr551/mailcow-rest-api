import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook message list focus return (slice 43)', () => {
    test('Esc closes docked reading pane and focuses the message list', async ({ page }) => {
        await login(page);
        await page.getByTestId('msg-row-1001').click();
        await expect(page.locator('#mail-reading-pane-landmark')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('#mail-message-list-landmark')).toBeFocused();
    });

    test('Esc closes hidden-layout flyout and focuses the message list', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('webmail.settings.v1', JSON.stringify({
                aiFeatures: false,
                readingPaneLayout: 'hidden',
                phishingScan: false
            }));
        });
        await login(page);
        await page.getByTestId('msg-row-1001').click();
        await expect(page.getByTestId('reading-pane-flyout')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('reading-pane-flyout')).not.toBeVisible();
        await expect(page.locator('#mail-message-list-landmark')).toBeFocused();
    });
});
