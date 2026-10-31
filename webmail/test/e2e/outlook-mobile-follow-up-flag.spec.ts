import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice21';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

async function loginMobile(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

async function openFollowUpSheet(page: import('@playwright/test').Page, uid: number) {
    const row = page.getByTestId(`msg-row-${uid}`);
    await row.dispatchEvent('pointerdown', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
    await page.waitForTimeout(600);
    await row.dispatchEvent('pointerup', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
    await expect(page.getByRole('dialog', { name: 'Message actions' })).toBeVisible();
    await page.getByTestId('mobile-follow-up-trigger').click();
    await expect(page.getByRole('dialog', { name: 'Message actions' })).toContainText('Flag for follow-up');
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await applyMocks(page);
});

test('mobile long-press Flag menu sets follow-up today on the row', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    const uid = 1001;
    await openFollowUpSheet(page, uid);
    await page.getByTestId('mobile-follow-up-item-today').click();
    const row = page.getByTestId(`msg-row-${uid}`);
    await expect(row).toHaveAttribute('data-follow-up', 'Follow up today');
    await expect(page.getByTestId(`msg-follow-up-${uid}`)).toHaveText('Follow up today');
    await page.screenshot({ path: `${SCREEN_DIR}/51-mobile-follow-up-today-row.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/51-mobile-follow-up-today-row.png`, fullPage: true });
});

test('mobile Clear flag removes follow-up hint', async ({ page }) => {
    await loginMobile(page);
    const uid = 1001;
    await openFollowUpSheet(page, uid);
    await page.getByTestId('mobile-follow-up-item-today').click();
    await expect(page.getByTestId(`msg-row-${uid}`)).toHaveAttribute('data-follow-up', 'Follow up today');

    await openFollowUpSheet(page, uid);
    await page.getByTestId('mobile-follow-up-item-clear').click();
    await expect(page.getByTestId(`msg-row-${uid}`)).toHaveAttribute('data-follow-up', '');
});
