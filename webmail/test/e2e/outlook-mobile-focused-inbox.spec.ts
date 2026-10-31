import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice19';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

async function loginMobile(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.waitForLoadState('networkidle');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await applyMocks(page);
});

test('mobile INBOX shows Focused and Other tabs', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'light');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            density: 'comfortable',
            listFilter: 'all',
            inboxTab: 'focused',
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });

    await loginMobile(page);
    await expect(page.getByTestId('inbox-tabs')).toBeVisible();
    await expect(page.getByTestId('inbox-tab-focused')).toHaveClass(/active/);

    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-999')).toBeVisible();
    await expect(page.getByTestId('msg-row-1000')).not.toBeVisible();

    await page.screenshot({ path: `${SCREEN_DIR}/48-mobile-inbox-focused-tab.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/48-mobile-inbox-focused-tab.png`, fullPage: true });

    await page.getByTestId('inbox-tab-other').click();
    await expect(page.getByTestId('inbox-tab-other')).toHaveClass(/active/);
    await expect(page.getByTestId('msg-row-1000')).toBeVisible();
    await expect(page.getByTestId('msg-row-1001')).not.toBeVisible();

    await page.screenshot({ path: `${SCREEN_DIR}/49-mobile-inbox-other-tab.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/49-mobile-inbox-other-tab.png`, fullPage: true });
});

test('mobile Focused/Other tabs hide outside INBOX', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    await page.locator('.nav-item:has-text("Folders")').click();
    await page.locator('.ios-row').filter({ hasText: 'Sent' }).first().click();
    await expect(page.getByTestId('inbox-tabs')).toHaveCount(0);
});
