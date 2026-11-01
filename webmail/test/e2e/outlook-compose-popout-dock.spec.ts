import { test, expect } from '@playwright/test';
import { applyMocks, installPopoutMockForwarding, login } from './fixtures';

test.beforeEach(async ({ page, context }) => {
    installPopoutMockForwarding(context);
    await applyMocks(page);
});

test.describe('Outlook compose pop-out dock (slice 58)', () => {
    test('Open in main window restores compose on the mail tab', async ({ page, context }) => {
        await login(page);
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid=compose-btn]');
        await expect(page.getByTestId('compose-modal')).toBeVisible();
        await page.fill('[data-testid=compose-to]', 'dock@example.com');
        await page.fill('[data-testid=compose-subject]', 'Slice 58 dock back');
        await page.locator('[data-testid=rich-editor-surface]').click();
        await page.keyboard.type('Dock body text.');

        const popupPromise = context.waitForEvent('page');
        await page.getByTestId('compose-modal-pop-out').click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        await expect(popup.getByTestId('compose-popout-shell')).toBeVisible();
        await expect(popup.getByTestId('compose-modal-dock-in')).toBeVisible();
        await expect(page.getByTestId('compose-modal')).toHaveCount(0);

        await popup.getByTestId('compose-modal-dock-in').click();
        await expect(page.getByTestId('compose-modal')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('[data-testid=compose-subject]')).toHaveValue('Slice 58 dock back');
        await expect(page.getByTestId('compose-to-chip')).toContainText('dock@example.com');
    });

    test('pop-out window title follows the draft subject', async ({ page, context }) => {
        await login(page);
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid=compose-btn]');
        await page.fill('[data-testid=compose-subject]', 'Pop-out title test');

        const popupPromise = context.waitForEvent('page');
        await page.getByTestId('compose-modal-pop-out').click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        await expect.poll(() => popup.title()).toContain('Pop-out title test');
    });
});
