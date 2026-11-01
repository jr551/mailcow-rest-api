import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';
import { enableAiFeatures, seedWebmailSettings } from './e2e-helpers';

async function loginMobile(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await enableAiFeatures(page);
    await seedWebmailSettings(page, { naturalLanguageSearch: true, useCustomLlm: true });
});

test('mobile natural-language search translates via configured provider', async ({ page }) => {
    await page.unroute('**/v1/ai/llm/chat/completions');
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '{"search":"from:billing@acme.example subject:invoice"}'
                    }
                }]
            })
        });
    });

    await loginMobile(page);
    await page.getByTestId('mobile-search-input').fill('invoices from acme billing');
    await expect(page.getByTestId('mobile-search-nl-hint')).toContainText('from:billing@acme.example', {
        timeout: 8000
    });
});

test('mobile tag-syntax queries skip NL translation', async ({ page }) => {
    let llmCalls = 0;
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        llmCalls++;
        route.fulfill({ status: 500, body: 'should not run' });
    });

    await loginMobile(page);
    await page.getByTestId('mobile-search-input').fill('from:concierge@example.com');
    await page.waitForTimeout(500);
    expect(llmCalls).toBe(0);
    await expect(page.getByTestId('mobile-search-nl-hint')).toHaveCount(0);
});

test('mobile NL search stays off unless the user enables it', async ({ page }) => {
    await seedWebmailSettings(page, { naturalLanguageSearch: false });
    let llmCalls = 0;
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        llmCalls++;
        route.fulfill({ status: 500, body: 'should not run' });
    });

    await loginMobile(page);
    await page.getByTestId('mobile-search-input').fill('find my lunch plans');
    await page.waitForTimeout(500);
    expect(llmCalls).toBe(0);
});
