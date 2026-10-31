import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice32';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

async function loginMobile(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

async function openCategorySheet(page: import('@playwright/test').Page, uid: number) {
    const row = page.getByTestId(`msg-row-${uid}`);
    await row.dispatchEvent('pointerdown', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
    await page.waitForTimeout(600);
    await row.dispatchEvent('pointerup', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
    await expect(page.getByRole('dialog', { name: 'Message actions' })).toBeVisible();
    await page.getByTestId('mobile-category-trigger').click();
    await expect(page.getByRole('dialog', { name: 'Message actions' })).toContainText('Categorize');
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await applyMocks(page);
});

test('mobile long-press Categorize sets row stripe', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    const uid = 1001;
    await openCategorySheet(page, uid);
    await page.getByTestId('mobile-category-item-green').click();
    const row = page.getByTestId(`msg-row-${uid}`);
    await expect(row).toHaveAttribute('data-category', 'green');
    await expect(page.getByTestId(`msg-category-${uid}`)).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/62-mobile-category-green-row.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/62-mobile-category-green-row.png`, fullPage: true });
});

test('mobile Clear category removes stripe', async ({ page }) => {
    await loginMobile(page);
    const uid = 1001;
    await openCategorySheet(page, uid);
    await page.getByTestId('mobile-category-item-blue').click();
    await expect(page.getByTestId(`msg-row-${uid}`)).toHaveAttribute('data-category', 'blue');

    await openCategorySheet(page, uid);
    await page.getByTestId('mobile-category-item-clear').click();
    await expect(page.getByTestId(`msg-row-${uid}`)).toHaveAttribute('data-category', '');
});
