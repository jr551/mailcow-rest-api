import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook conversation stack HTML (slice 42)', () => {
    test('expanded sibling renders sanitized HTML in the stack', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('webmail.theme', 'dark');
            localStorage.setItem('webmail.settings.v1', JSON.stringify({
                aiFeatures: false,
                groupThreads: true,
                phishingScan: false
            }));
        });

        await login(page);
        await page.getByTestId('msg-row-999').click();
        await expect(page.getByTestId('conversation-stack')).toBeVisible();
        await page.getByTestId('conversation-expand-997').click();
        await expect(page.getByTestId('conversation-html-997')).toBeVisible();
        const frame = page.frameLocator('[data-testid="conversation-html-997"]');
        await expect(frame.locator('strong')).toHaveText('Friday');
        await expect(frame.locator('body')).toContainText('new place on Main');
    });

    test('text-only stack messages keep the plain pre body', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('webmail.settings.v1', JSON.stringify({
                aiFeatures: false,
                groupThreads: true,
                phishingScan: false
            }));
        });
        await login(page);
        await page.getByTestId('msg-row-999').click();
        await expect(page.getByTestId('conversation-body-999')).toBeVisible();
        await expect(page.getByTestId('conversation-html-999')).toHaveCount(0);
        await expect(page.getByTestId('conversation-body-999')).toContainText('noon at the usual place');
    });
});
