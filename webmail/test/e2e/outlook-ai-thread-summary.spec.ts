import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';
import { enableAiFeatures, openMessageByUid, seedWebmailSettings } from './e2e-helpers';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

async function openAiPanel(page: import('@playwright/test').Page) {
    await page.getByTestId('ai-menu-btn').click();
    await expect(page.getByTestId('ai-menu-pop')).toBeVisible();
    await page.getByTestId('ai-tools-btn').click();
    await expect(page.getByTestId('ai-panel')).toBeVisible();
}

test('AI panel summarizes a grouped thread when aiThreadSummary is on', async ({ page }) => {
    await enableAiFeatures(page);
    await seedWebmailSettings(page, {
        groupThreads: true,
        aiThreadSummary: true,
        inboxTab: 'focused'
    });
    await login(page);
    await openMessageByUid(page, 999);
    await expect(page.getByTestId('conversation-stack')).toBeVisible();
    await openAiPanel(page);
    await expect(page.getByTestId('ai-summarize-btn')).toContainText(/Summarize thread/i);
    await page.getByTestId('ai-summarize-btn').click();
    await expect(page.getByTestId('ai-summary-out')).toBeVisible();
    await expect(page.getByTestId('ai-summary-out')).toContainText(/lunch thread/i);
});

test('aiThreadSummary off keeps single-message summarize label', async ({ page }) => {
    await enableAiFeatures(page);
    await seedWebmailSettings(page, { groupThreads: true, aiThreadSummary: false });
    await login(page);
    await openMessageByUid(page, 999);
    await expect(page.getByTestId('conversation-stack')).toBeVisible();
    await openAiPanel(page);
    await expect(page.getByTestId('ai-summarize-btn')).toHaveText(/Summarize$/);
});
