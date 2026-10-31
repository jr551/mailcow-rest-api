import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice26';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

const SNOOZE_UID = 1001;
const JORDAN_NEWER = 1017;
const JORDAN_OLDER = 1021;

async function loginMobile(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

async function openActionSheet(page: import('@playwright/test').Page, uid: number) {
    const row = page.getByTestId(`msg-row-${uid}`);
    await row.dispatchEvent('pointerdown', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
    await page.waitForTimeout(600);
    await row.dispatchEvent('pointerup', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
    await expect(page.getByRole('dialog', { name: 'Message actions' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await applyMocks(page);
});

test('mobile action sheet snooze hides the row', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    await openActionSheet(page, SNOOZE_UID);
    await page.getByTestId('mobile-snooze-trigger').click();
    await expect(page.getByRole('dialog', { name: 'Message actions' })).toContainText('Snooze');
    await page.getByTestId('mobile-snooze-item-later-today').click();
    await expect(page.getByTestId(`msg-row-${SNOOZE_UID}`)).toHaveCount(0);
});

test('mobile action sheet snooze submenu screenshot', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    await openActionSheet(page, SNOOZE_UID);
    await page.getByTestId('mobile-snooze-trigger').click();
    await expect(page.getByTestId('mobile-snooze-item-later-today')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/56-mobile-snooze-menu.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/56-mobile-snooze-menu.png`, fullPage: true });
});

test('mobile sweep keep latest removes older messages from sender', async ({ page }) => {
    await loginMobile(page);
    await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await openActionSheet(page, JORDAN_NEWER);
    await page.getByTestId('mobile-sweep-trigger').click();
    await page.getByTestId('mobile-sweep-item-keep-latest').click();
    await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toHaveCount(0);
    await expect(page.getByTestId(`msg-row-${JORDAN_NEWER}`)).toBeVisible();
});
