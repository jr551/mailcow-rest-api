import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

async function mobileLogin(
    page: import('@playwright/test').Page,
    extraSettings: Record<string, unknown> = {}
) {
    await page.addInitScript((settingsExtra) => {
        localStorage.setItem('webmail.theme', 'light');
        localStorage.setItem(
            'webmail.settings.v1',
            JSON.stringify({
                aiFeatures: false,
                density: 'comfortable',
                listFilter: 'all',
                groupThreads: true,
                inboxTab: 'focused',
                readingPaneLayout: 'right',
                phishingScan: false,
                useCustomLlm: false,
                llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' },
                ...settingsExtra
            })
        );
    }, extraSettings);
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', 'hunter2');
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

test('tablet width shows split list and reading pane', async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1194 });
    await mobileLogin(page);
    await expect(page.getByTestId('tablet-mail-split')).toBeVisible();
    await expect(page.getByTestId('tablet-reading-empty')).toBeVisible();
    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('tablet-reading-empty')).toHaveCount(0);
    await expect(page.locator('.message-view.embedded')).toBeVisible();
    await expect(page.locator('.message-view.embedded .back-btn')).toHaveCount(0);
    await expect(page.getByTestId('msg-row-1001')).toHaveClass(/selected/);
});

test('phone width keeps full-screen message view', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mobileLogin(page);
    await expect(page.getByTestId('tablet-mail-split')).toHaveCount(0);
    await page.getByTestId('msg-row-1001').click();
    await expect(page.locator('.message-view.embedded')).toHaveCount(0);
    await expect(page.locator('.message-view .back-btn')).toBeVisible();
});

test('hidden reading pane on tablet uses full-screen message', async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1194 });
    await mobileLogin(page, { readingPaneLayout: 'hidden' });
    await expect(page.getByTestId('tablet-mail-split')).toHaveCount(0);
    await page.getByTestId('msg-row-1001').click();
    await expect(page.locator('.message-view .back-btn')).toBeVisible();
});

test('bottom reading pane stacks vertically on tablet', async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1194 });
    await mobileLogin(page, { readingPaneLayout: 'bottom' });
    await expect(page.getByTestId('tablet-mail-split')).toHaveAttribute('data-pane-axis', 'vertical');
});
