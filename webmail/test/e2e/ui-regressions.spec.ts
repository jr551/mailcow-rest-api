import { test, expect } from '@playwright/test';
import { applyMocks, detailFor1001, login, MOCK_PASS, MOCK_USER } from './fixtures';

test('narrow desktop sidebar keeps names and reveals footer controls on focus', async ({ page }) => {
    await applyMocks(page);
    await page.setViewportSize({ width: 700, height: 800 });
    await login(page);

    await expect(page.getByTestId('compose-btn')).toHaveAttribute('aria-label', 'Compose new message');
    await expect(page.getByTestId('folder-INBOX')).toHaveAttribute('aria-label', 'Inbox');
    const newFolder = page.getByTestId('sidebar-new-folder');
    await newFolder.focus();
    await expect.poll(() => newFolder.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe('1');
});

test('mobile HTML email links are allowed to open a new tab', async ({ page }) => {
    await applyMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/v1/mailboxes/INBOX/messages/1001', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ...detailFor1001,
                text: null,
                html: '<p>Hello <a href="https://example.com/article" target="_blank">article</a></p>'
            })
        });
    });

    await page.goto('/webmail/mobile/');
    await page.getByLabel('Email').fill(MOCK_USER);
    await page.locator('input[type="password"]').fill(MOCK_PASS);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.locator('.msg-row').first().click();
    const iframe = page.locator('iframe[title="Message body"]');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('sandbox', /allow-popups/);
    await expect(iframe).toHaveAttribute('sandbox', /allow-popups-to-escape-sandbox/);
});
