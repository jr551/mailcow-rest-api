import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
});

async function mobileLogin(page: import('@playwright/test').Page) {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'light');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            density: 'comfortable',
            listFilter: 'all',
            groupThreads: true,
            inboxTab: 'focused',
            phishingScan: false,
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', 'hunter2');
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

test('mobile message view stacks a grouped thread', async ({ page }) => {
    await mobileLogin(page);
    await page.getByTestId('msg-row-999').click();
    await expect(page.getByTestId('conversation-stack')).toBeVisible();
    await expect(page.getByTestId('conversation-msg-997')).toHaveAttribute('data-expanded', 'false');
    await expect(page.getByTestId('conversation-msg-999')).toHaveAttribute('data-expanded', 'true');
    await expect(page.getByTestId('conversation-body-999')).toContainText('noon at the usual place');
});

test('mobile single message does not show conversation stack', async ({ page }) => {
    await mobileLogin(page);
    await page.getByTestId('msg-row-1001').click();
    await expect(page.locator('.message-view')).toBeVisible();
    await expect(page.getByTestId('conversation-stack')).toHaveCount(0);
});

test('mobile stack hidden when group threads is off', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            groupThreads: false,
            phishingScan: false
        }));
    });
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', 'hunter2');
    await page.click('button:has-text("Sign in")');
    await page.getByTestId('msg-row-999').click();
    await expect(page.getByTestId('conversation-stack')).toHaveCount(0);
});
