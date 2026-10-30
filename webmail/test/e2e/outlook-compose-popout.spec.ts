import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook compose pop-out (slice 15)', () => {
    test('Pop out opens compose in a new window with draft fields', async ({ page, context }) => {
        await login(page);
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid=compose-btn]');
        await expect(page.getByTestId('compose-modal')).toBeVisible();
        await page.fill('[data-testid=compose-to]', 'popout@example.com');
        await page.fill('[data-testid=compose-subject]', 'Slice 15 pop out');
        await page.locator('[data-testid=rich-editor-surface]').click();
        await page.keyboard.type('Pop-out body text.');

        const popupPromise = context.waitForEvent('page');
        await page.getByTestId('compose-modal-pop-out').click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        await expect(popup.getByTestId('compose-popout-shell')).toBeVisible();
        await expect(popup.getByTestId('compose-modal')).toBeVisible();
        await expect(popup.locator('[data-testid=compose-subject]')).toHaveValue('Slice 15 pop out');
        await expect(popup.getByTestId('compose-to-chip')).toContainText('popout@example.com');
        await expect(page.getByTestId('compose-modal')).toHaveCount(0);
        await expect(popup.getByTestId('compose-modal-pop-out')).toHaveCount(0);
    });
});
