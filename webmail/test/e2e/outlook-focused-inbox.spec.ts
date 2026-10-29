import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
mkdirSync(SCREEN_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('INBOX shows Focused and Other tabs; Other hides bulk mail', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            density: 'comfortable',
            listFilter: 'all',
            inboxTab: 'focused',
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });

    await login(page);
    await expect(page.getByTestId('inbox-tabs')).toBeVisible();
    await expect(page.getByTestId('inbox-tab-focused')).toHaveClass(/active/);

    // Fixture: welcome + sam (focused), billing invoice (other), tracker row (focused)
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-999')).toBeVisible();
    await expect(page.getByTestId('msg-row-1000')).not.toBeVisible();

    await page.screenshot({ path: `${SCREEN_DIR}/26-inbox-focused-tab.png`, fullPage: true });

    await page.getByTestId('inbox-tab-other').click();
    await expect(page.getByTestId('inbox-tab-other')).toHaveClass(/active/);
    await expect(page.getByTestId('msg-row-1000')).toBeVisible();
    await expect(page.getByTestId('msg-row-1001')).not.toBeVisible();

    await page.screenshot({ path: `${SCREEN_DIR}/27-inbox-other-tab.png`, fullPage: true });
});

test('Focused/Other tabs hide outside INBOX', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.getByTestId('folder-Sent').click();
    await expect(page.getByTestId('inbox-tabs')).toHaveCount(0);
});
