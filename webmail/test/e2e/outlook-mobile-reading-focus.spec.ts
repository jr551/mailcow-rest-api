import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mobile reading pane focus (slice 40)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('opening a message focuses the reading pane landmark', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('msg-row-1001').click();
        await expect(page.getByTestId('mobile-mail-landmark-reading-pane')).toBeVisible();
        await expect(page.locator('#mail-reading-pane-landmark')).toBeFocused();
    });

    test('tablet embedded reading pane does not steal focus from the list', async ({ page }) => {
        await page.setViewportSize({ width: 834, height: 1194 });
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await expect(page.getByTestId('tablet-mail-split')).toBeVisible();
        await page.getByTestId('msg-row-1001').click();
        await expect(page.locator('.message-view.embedded')).toBeVisible();
        await expect(page.locator('#mail-reading-pane-landmark')).not.toBeFocused();
    });
});
