import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice4';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('default Favorites section shows Inbox, Sent, and Drafts', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.removeItem('webmail.folder-favorites.v1');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            phishingScan: false
        }));
    });
    await login(page);
    const fav = page.getByTestId('folder-favorites');
    await expect(fav).toBeVisible();
    await expect(page.getByTestId('favorite-INBOX')).toBeVisible();
    await expect(page.getByTestId('favorite-Sent')).toBeVisible();
    await expect(page.getByTestId('favorite-Drafts')).toBeVisible();

    await page.screenshot({ path: `${SCREEN_DIR}/32-folder-favorites-default.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/32-folder-favorites-default.png`, fullPage: true });
});

test('context menu adds a folder to Favorites and persists', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.folder-favorites.v1', JSON.stringify(['INBOX']));
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            phishingScan: false
        }));
    });
    await login(page);
    await expect(page.getByTestId('favorite-Projects')).toHaveCount(0);

    await page.getByTestId('folder-Projects').click({ button: 'right' });
    await page.getByTestId('folder-favorite-toggle').click();
    await expect(page.getByTestId('favorite-Projects')).toBeVisible();

    await page.screenshot({ path: `${SCREEN_DIR}/33-folder-favorites-custom.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/33-folder-favorites-custom.png`, fullPage: true });

    const stored = await page.evaluate(() => localStorage.getItem('webmail.folder-favorites.v1'));
    expect(stored).toContain('Projects');
});
