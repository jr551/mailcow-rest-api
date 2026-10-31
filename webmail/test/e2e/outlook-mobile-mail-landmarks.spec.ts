import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mobile mail landmarks (slice 33)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('inbox exposes command bar, message list, and app navigation regions', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await expect(page.getByRole('banner', { name: 'Command bar' })).toBeVisible();
        await expect(page.getByTestId('mobile-mail-landmark-message-list')).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'App navigation' })).toBeVisible();
    });

    test('skip link moves focus to the mobile message list landmark', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        const skip = page.getByTestId('mobile-mail-skip-link');
        await skip.focus();
        await expect(skip).toBeFocused();
        await skip.click();
        const listLandmark = page.locator(`#mail-message-list-landmark`);
        await expect(listLandmark).toBeFocused();
    });

    test('message view exposes reading pane landmark', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('msg-row-1001').click();
        await expect(page.getByTestId('mobile-mail-landmark-reading-pane')).toBeVisible();
        await expect(page.getByRole('main', { name: 'Reading pane' })).toBeVisible();
    });
});
