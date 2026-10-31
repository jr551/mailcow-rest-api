import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login } from './fixtures';

const ASSET_DIR = 'docs/assets/outlook-slice30';
mkdirSync(ASSET_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'light');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            density: 'comfortable',
            listFilter: 'all',
            groupThreads: true,
            inboxTab: 'focused',
            readingPaneLayout: 'right',
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });
});

test('collapsed sibling shows attachment hint; expanded shows chips', async ({ page }) => {
    await login(page);
    await page.getByTestId('msg-row-999').click();
    await expect(page.getByTestId('conversation-att-hint-997')).toContainText('lunch-menu.pdf');
    await page.getByTestId('conversation-expand-997').click();
    await expect(page.getByTestId('conversation-attachments-997')).toContainText('lunch-menu.pdf');
    await page.screenshot({ path: `${ASSET_DIR}/60-conversation-attachment-chips.png`, fullPage: false });
});
