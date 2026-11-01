import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mobile compose focus return (slice 46)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('closing empty compose from inbox focuses the message list landmark', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('compose-btn').click();
        await expect(page.getByTestId('compose-to')).toBeVisible();
        await page.getByTestId('compose-close').click();
        await expect(page.getByTestId('compose-to')).not.toBeVisible();
        await expect(page.locator('#mail-message-list-landmark')).toBeFocused();
    });
});
