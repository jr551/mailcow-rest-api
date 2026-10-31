import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const PIN_UID = 1018;
const OTHER_UID = 1001;

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

test('mobile action sheet pin keeps message at top', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    const row = page.getByTestId(`msg-row-${PIN_UID}`);
    await expect(row).toHaveAttribute('data-pinned', 'false');
    await openActionSheet(page, PIN_UID);
    await page.getByTestId('mobile-pin-toggle').click();
    await expect(row).toHaveAttribute('data-pinned', 'true');
    await expect(page.getByTestId(`msg-pin-mark-${PIN_UID}`)).toBeVisible();
    const firstRow = page.locator('[data-testid^="msg-row-"]').first();
    await expect(firstRow).toHaveAttribute('data-testid', `msg-row-${PIN_UID}`);
});

test('mobile pin toggle unpins from action sheet', async ({ page }) => {
    await loginMobile(page);
    await openActionSheet(page, PIN_UID);
    await page.getByTestId('mobile-pin-toggle').click();
    await expect(page.getByTestId(`msg-row-${PIN_UID}`)).toHaveAttribute('data-pinned', 'true');
    await openActionSheet(page, OTHER_UID);
    await page.getByRole('dialog', { name: 'Message actions' }).getByRole('button', { name: 'Close' }).click();
    await openActionSheet(page, PIN_UID);
    await expect(page.getByTestId('mobile-pin-toggle')).toContainText('Unpin');
    await page.getByTestId('mobile-pin-toggle').click();
    await expect(page.getByTestId(`msg-row-${PIN_UID}`)).toHaveAttribute('data-pinned', 'false');
});
