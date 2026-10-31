import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, MOCK_USER } from './fixtures';

const ASSET_DIR = 'docs/assets/outlook-slice25';
mkdirSync(ASSET_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

async function mobileLogin(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', 'hunter2');
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1')).toBeVisible();
}

test.describe('Outlook mobile keyboard shortcuts (slice 25)', () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

    test('? opens the mobile shortcut help sheet', async ({ page }) => {
        await mobileLogin(page);
        await page.keyboard.press('Shift+?');
        const sheet = page.getByTestId('mobile-mail-shortcut-help');
        await expect(sheet).toBeVisible();
        await expect(sheet.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
        await page.screenshot({ path: `${ASSET_DIR}/55-mobile-keyboard-shortcuts-help.png`, fullPage: true });
        await page.getByTestId('mobile-mail-shortcut-help-close').click();
        await expect(sheet).not.toBeVisible();
    });

    test('/ focuses the mobile search field', async ({ page }) => {
        await mobileLogin(page);
        await page.keyboard.press('/');
        await expect(page.getByTestId('mobile-search-input')).toBeFocused();
    });

    test('E archives the keyboard-highlighted message', async ({ page }) => {
        await page.route('**/v1/mailboxes/INBOX/messages/1001/move', (route) => {
            route.fulfill({ json: { uid: 1001, path: 'Archive', destUid: 5001 } });
        });
        await mobileLogin(page);
        await page.getByTestId('msg-row-1001').click();
        await expect(page.locator('.message-view')).toBeVisible();
        await page.goBack();
        await expect(page.getByTestId('msg-row-1001')).toBeVisible();
        await page.keyboard.press('e');
        await expect(page.getByTestId('mobile-toast')).toContainText('Archived');
        await expect(page.getByTestId('msg-row-1001')).not.toBeVisible();
    });

    test('Settings opens the same help sheet', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Settings' }).click();
        await page.getByTestId('mobile-settings-keyboard-shortcuts').click();
        await expect(page.getByTestId('mobile-mail-shortcut-help')).toBeVisible();
    });
});
