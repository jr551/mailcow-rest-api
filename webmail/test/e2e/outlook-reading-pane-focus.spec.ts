import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook reading pane focus (slice 41)', () => {
    test('docked reading pane receives focus when a message opens', async ({ page }) => {
        await login(page);
        await page.getByTestId('msg-row-1001').click();
        await expect(page.getByTestId('mail-landmark-reading-pane')).toBeVisible();
        await expect(page.locator('#mail-reading-pane-landmark')).toBeFocused();
    });

    test('hidden layout flyout reading pane receives focus when a message opens', async ({ page }) => {
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
        await expect(page.locator('#mail-reading-pane-landmark')).toBeFocused();
    });
});
