import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mobile message list focus return (slice 44)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('Esc leaves full-screen message and focuses the message list landmark', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('msg-row-1001').click();
        await expect(page.locator('#mail-reading-pane-landmark')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('mobile-mail-landmark-message-list')).toBeVisible();
        await expect(page.locator('#mail-message-list-landmark')).toBeFocused();
    });
});
