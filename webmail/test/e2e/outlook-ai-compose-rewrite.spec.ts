import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';
import { enableAiFeatures, seedWebmailSettings } from './e2e-helpers';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('Compose rewrite replaces selected text when aiRewriteCompose is on', async ({ page }) => {
    await enableAiFeatures(page);
    await seedWebmailSettings(page, { aiRewriteCompose: true });
    await login(page);
    await page.click('[data-testid=compose-btn]');
    await expect(page.getByTestId('rich-editor-surface')).toBeVisible();
    const surface = page.locator('[data-testid=rich-editor-surface] .ProseMirror');
    await surface.click();
    await page.keyboard.type('Thanks so much!!! This is great.');
    await page.keyboard.press('Control+a');
    await expect(page.getByTestId('compose-rewrite-bar')).toBeVisible();
    await page.getByTestId('compose-rewrite-professional').click();
    await expect(surface).toContainText('Thank you — this looks excellent');
});

test('aiRewriteCompose off hides the rewrite bar even with a selection', async ({ page }) => {
    await enableAiFeatures(page);
    await seedWebmailSettings(page, { aiRewriteCompose: false });
    await login(page);
    await page.click('[data-testid=compose-btn]');
    const surface = page.locator('[data-testid=rich-editor-surface] .ProseMirror');
    await surface.click();
    await page.keyboard.type('Hello team');
    await page.keyboard.press('Control+a');
    await expect(page.getByTestId('compose-rewrite-bar')).toHaveCount(0);
});
