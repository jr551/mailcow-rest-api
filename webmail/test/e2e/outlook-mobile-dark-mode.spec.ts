import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice22';
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

test('mobile Settings theme picker applies dark mode to the shell', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.settings-view h1')).toHaveText('Settings');
    await page.getByTestId('mobile-theme-dark').click();
    await expect(page.getByTestId('mobile-theme-dark')).toHaveClass(/active/);
    const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(themeAttr).toBe('dark');
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim());
    expect(bg).not.toBe('#ffffff');
    await page.screenshot({ path: `${SCREEN_DIR}/52-mobile-settings-dark-theme.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/52-mobile-settings-dark-theme.png`, fullPage: true });
});

test('mobile message reader keeps dark theme after opening a message', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await loginMobile(page);
    await page.getByTestId('msg-row-1001').click();
    await expect(page.locator('.message-view')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    const shellBg = await page.locator('.message-view').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(shellBg).not.toBe('rgb(255, 255, 255)');
});
