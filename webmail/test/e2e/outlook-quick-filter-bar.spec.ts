import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login, MOCK_USER } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice6';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('Outlook Filter menu: unread, flagged, has files, to me, mentions', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
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

    await login(page);
    await expect(page.getByTestId('quick-filter-bar')).toBeVisible();
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();

    await page.getByTestId('quick-filter-trigger').click();
    await expect(page.getByTestId('quick-filter-menu')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/35-quick-filter-menu-open.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/35-quick-filter-menu-open.png`, fullPage: true });

    await page.getByTestId('filter-unread').click();
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-1000')).not.toBeVisible();

    await page.getByTestId('quick-filter-trigger').click();
    await page.getByTestId('filter-starred').click();
    await expect(page.getByTestId('msg-row-999')).toBeVisible();

    await page.getByTestId('quick-filter-trigger').click();
    await page.getByTestId('filter-attachments').click();
    await expect(page.getByTestId('msg-row-1017')).toBeVisible();
    await expect(page.getByTestId('msg-row-1001')).not.toBeVisible();

    await page.getByTestId('quick-filter-trigger').click();
    await page.getByTestId('filter-to-me').click();
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-1020')).not.toBeVisible();

    await page.getByTestId('quick-filter-trigger').click();
    await page.getByTestId('filter-mentions').click();
    await expect(page.getByTestId('msg-row-1021')).toBeVisible();
    await expect(page.getByTestId('msg-row-1001')).not.toBeVisible();
});

test('Sort menu updates the active sort label', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            listFilter: 'all',
            listSort: 'date-desc'
        }));
    });
    await login(page);
    await page.getByTestId('quick-sort-trigger').click();
    await page.getByTestId('sort-subject-asc').click();
    await expect(page.getByTestId('quick-sort-trigger')).toContainText('Subject A to Z');
});
