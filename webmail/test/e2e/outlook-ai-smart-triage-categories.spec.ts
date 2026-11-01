import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';
import { enableAiFeatures, seedWebmailSettings } from './e2e-helpers';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('Apply colour categories maps AI triage to OWA stripes when enabled', async ({ page }) => {
    await enableAiFeatures(page);
    await seedWebmailSettings(page, { aiSmartTriageCategories: true });
    await login(page);
    await expect(page.getByTestId('msg-list')).toBeVisible();

    await page.getByTestId('filter-ai-sorted').click();
    const rows = page.locator('.row[data-testid^="msg-row-"]');
    await expect.poll(async () => rows.count()).toBeGreaterThanOrEqual(3);
    await expect(rows.first()).toHaveClass(/ai-cat-human/);

    await expect(page.getByTestId('ai-smart-triage-apply-banner')).toBeVisible();
    await page.getByTestId('ai-smart-triage-apply-categories').click();

    await expect(page.getByTestId('msg-category-999')).toBeVisible();
});

test('aiSmartTriageCategories off hides the apply banner on AI sorted', async ({ page }) => {
    await enableAiFeatures(page);
    await seedWebmailSettings(page, { aiSmartTriageCategories: false });
    await login(page);
    await page.getByTestId('filter-ai-sorted').click();
    await expect.poll(async () =>
        page.locator('.row[data-testid^="msg-row-"]').count()
    ).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId('ai-smart-triage-apply-banner')).toHaveCount(0);
});
