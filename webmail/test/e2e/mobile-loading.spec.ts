import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_PASS, MOCK_USER } from './fixtures';

test('mobile inbox explains an initial slow load instead of showing a blank list', async ({ page }) => {
    await applyMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/v1\/mailboxes\/INBOX\/messages(\?|$)/, async (route) => {
        await waiting;
        await route.fallback();
    });

    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');

    await expect(page.getByTestId('mobile-inbox-loading')).toBeVisible();
    await expect(page.getByTestId('mobile-inbox-loading')).toContainText('Loading messages');

    release();
    await expect(page.locator('.msg-row')).toHaveCount(18);
    await expect(page.getByTestId('mobile-inbox-loading')).toHaveCount(0);
});
