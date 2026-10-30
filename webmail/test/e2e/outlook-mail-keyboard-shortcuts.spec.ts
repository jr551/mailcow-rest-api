import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice8';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mail keyboard shortcuts (slice 8)', () => {
    test('? opens the shortcut help dialog', async ({ page }) => {
        await login(page);
        await page.keyboard.press('Shift+?');
        const dlg = page.getByTestId('mail-shortcut-help');
        await expect(dlg).toBeVisible();
        await expect(dlg.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
        await page.screenshot({ path: `${SCREEN_DIR}/37-keyboard-shortcuts-help.png`, fullPage: true });
        await page.screenshot({ path: `${ASSET_DIR}/37-keyboard-shortcuts-help.png`, fullPage: true });
        await page.getByTestId('mail-shortcut-help-close').click();
        await expect(dlg).not.toBeVisible();
    });

    test('E archives the selected message', async ({ page }) => {
        await page.route('**/v1/mailboxes/INBOX/messages/1001/move', (route) => {
            route.fulfill({ json: { uid: 1001, path: 'Archive', destUid: 5001 } });
        });
        await login(page);
        await page.getByTestId('msg-row-1001').click();
        await expect(page.getByTestId('detail-subject')).toBeVisible();
        await page.keyboard.press('e');
        await expect(page.getByTestId('toast')).toContainText('Archived');
        await expect(page.getByTestId('msg-row-1001')).not.toBeVisible();
    });

    test('/ focuses the search box', async ({ page }) => {
        await login(page);
        await page.keyboard.press('/');
        const search = page.getByTestId('search-input');
        await expect(search).toBeFocused();
    });
});
