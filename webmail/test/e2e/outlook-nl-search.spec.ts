import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';
import { enableAiFeatures, seedWebmailSettings } from './e2e-helpers';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await enableAiFeatures(page);
    await seedWebmailSettings(page, { naturalLanguageSearch: true, useCustomLlm: true });
});

test('natural-language search translates to tag syntax via configured provider', async ({ page }) => {
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

    await login(page);
    await page.getByTestId('search-input').fill('invoices from acme billing');
    await expect(page.getByTestId('search-nl-hint')).toContainText('from:billing@acme.example', { timeout: 8000 });
    await expect(page.locator('.search-tag')).toContainText('from:billing@acme.example');
});

test('tag-syntax queries skip NL translation', async ({ page }) => {
    let llmCalls = 0;
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        llmCalls++;
        route.fulfill({ status: 500, body: 'should not run' });
    });

    await login(page);
    await page.getByTestId('search-input').fill('from:concierge@example.com');
    await page.waitForTimeout(500);
    expect(llmCalls).toBe(0);
    await expect(page.getByTestId('search-nl-hint')).toHaveCount(0);
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
});

test('NL search stays off unless the user enables it', async ({ page }) => {
    await seedWebmailSettings(page, { naturalLanguageSearch: false });
    let llmCalls = 0;
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        llmCalls++;
        route.fulfill({ status: 500, body: 'should not run' });
    });

    await login(page);
    await page.getByTestId('search-input').fill('find my lunch plans');
    await page.waitForTimeout(500);
    expect(llmCalls).toBe(0);
});
