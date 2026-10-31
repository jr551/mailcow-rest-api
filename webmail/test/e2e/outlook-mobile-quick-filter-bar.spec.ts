import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice27';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

async function loginMobile(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await applyMocks(page);
});

test('mobile Filter menu matches desktop Outlook filters', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'light');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            density: 'comfortable',
            listFilter: 'all',
            listSort: 'date-desc',
            inboxTab: 'focused',
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });
    await loginMobile(page);
    await expect(page.getByTestId('mobile-quick-filter-bar')).toBeVisible();

    await page.getByTestId('mobile-quick-filter-trigger').click();
    await expect(page.getByTestId('mobile-quick-filter-menu')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/57-mobile-quick-filter-menu.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/57-mobile-quick-filter-menu.png`, fullPage: true });

    await page.getByTestId('mobile-filter-unread').click();
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-1000')).not.toBeVisible();

    await page.getByTestId('mobile-quick-filter-trigger').click();
    await page.getByTestId('mobile-filter-attachments').click();
    await expect(page.getByTestId('msg-row-1017')).toBeVisible();
    await expect(page.getByTestId('msg-row-1001')).not.toBeVisible();
});

test('mobile Sort menu updates label', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            listFilter: 'all',
            listSort: 'date-desc'
        }));
    });
    await loginMobile(page);
    await page.getByTestId('mobile-quick-sort-trigger').click();
    await page.getByTestId('mobile-sort-subject-asc').click();
    await expect(page.getByTestId('mobile-quick-sort-trigger')).toContainText('Subject A to Z');
});
