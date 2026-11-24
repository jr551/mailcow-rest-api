import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('INBOX is a single list: no Focused/Other tabs, bulk mail included', async ({ page }) => {
    // Seed a legacy profile last left on the removed Other tab. The stale
    // key must be ignored, not hide personal mail.
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            density: 'comfortable',
            listFilter: 'all',
            inboxTab: 'other',
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });

    await login(page);
    await expect(page.getByTestId('inbox-tabs')).toHaveCount(0);

    // Personal mail and the billing invoice that used to sit in Other are
    // all in the one list.
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-999')).toBeVisible();
    await expect(page.getByTestId('msg-row-1000')).toBeVisible();
});
