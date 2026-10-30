import { test, expect } from '@playwright/test';
import { applyMocks, login, detailFor1001 } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook mail deep links (slice 16)', () => {
    test('Hash URL opens folder and message', async ({ page }) => {
        await login(page);
        await page.goto('/webmail/#mail?folder=INBOX&uid=1001');
        await page.waitForSelector('[data-testid=shell]');
        await expect(page.getByTestId('detail-subject')).toContainText(detailFor1001.envelope.subject);
        await expect(page).toHaveURL(/#mail\?folder=INBOX&uid=1001/);
    });

    test('Copy link writes shareable URL to clipboard', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await login(page);
        await page.waitForSelector('[data-testid=shell]');
        await page.getByTestId('msg-row-1001').click();
        await expect(page.getByTestId('copy-message-link-btn')).toBeVisible();
        await page.getByTestId('copy-message-link-btn').click();
        await expect(page.getByTestId('toast')).toContainText('Link copied');
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toMatch(/#mail\?folder=INBOX&uid=\d+/);
    });
});
