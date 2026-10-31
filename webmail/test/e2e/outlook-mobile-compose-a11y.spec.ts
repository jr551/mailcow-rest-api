import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';
import { MOBILE_COMPOSE_LANDMARK_ID } from '../../src/lib/mobile-compose-landmarks';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mobile compose accessibility (slice 38)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('compose exposes labelled main landmark and focuses To', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('compose-btn').click();
        await expect(page.getByTestId('mobile-compose-landmark')).toBeVisible();
        await expect(page.getByRole('main', { name: 'Compose message' })).toBeVisible();
        await expect(page.getByRole('banner', { name: 'Compose message' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Message fields' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Compose actions' })).toBeVisible();
        await expect(page.locator('[data-testid="compose-to"]')).toBeFocused();
    });

    test('compose landmark can receive programmatic focus', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('compose-btn').click();
        await page.evaluate((id) => document.getElementById(id)?.focus(), MOBILE_COMPOSE_LANDMARK_ID);
        await expect(page.locator(`#${MOBILE_COMPOSE_LANDMARK_ID}`)).toBeFocused();
    });
});
