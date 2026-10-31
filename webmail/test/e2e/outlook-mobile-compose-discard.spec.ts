import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mobile compose discard confirm (slice 39)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('empty compose closes without confirmation', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('compose-btn').click();
        await page.getByTestId('compose-close').click();
        await expect(page.locator('.inbox-view')).toBeVisible();
        await expect(page.getByTestId('compose-discard-dialog')).toHaveCount(0);
    });

    test('unsaved compose shows discard sheet on close', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('compose-btn').click();
        await page.fill('[data-testid=compose-subject]', 'Unsaved note');
        await page.getByTestId('compose-close').click();
        await expect(page.getByTestId('compose-discard-dialog')).toBeVisible();
        await page.getByTestId('compose-discard-keep').click();
        await expect(page.getByTestId('compose-discard-dialog')).toHaveCount(0);
        await expect(page.locator('h1:has-text("New Message")')).toBeVisible();
    });

    test('discard button leaves compose', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('compose-btn').click();
        await page.fill('[data-testid=compose-body]', 'Throw away');
        await page.getByTestId('compose-close').click();
        await page.getByTestId('compose-discard-confirm').click();
        await expect(page.locator('.inbox-view')).toBeVisible();
    });
});
