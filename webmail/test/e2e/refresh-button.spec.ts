import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER } from './fixtures';

test.describe('Drive refresh button', () => {
    test('desktop drive toolbar has a refresh button', async ({ page }) => {
        await applyMocks(page);
        await page.goto('/webmail/');
        await page.fill('[data-testid=login-user]', MOCK_USER);
        await page.fill('[data-testid=login-pass]', 'hunter2');
        await page.click('[data-testid=login-submit]');
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid="app-switch-drive"]');
        await page.waitForSelector('[data-testid="drive-app"]');
        const refreshBtn = page.locator('[data-testid="drive-refresh-btn"]');
        await expect(refreshBtn).toBeVisible();
    });

    test('mobile drive header has a refresh button', async ({ page }) => {
        await applyMocks(page);
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await page.waitForSelector('.inbox-view');
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();
        const refreshBtn = page.locator('[data-testid="mobile-drive-refresh"]');
        await expect(refreshBtn).toBeVisible();
    });
});
