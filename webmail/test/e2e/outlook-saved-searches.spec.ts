import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
});

test('saved search appears in dropdown and runs the stored query', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            'webmail.saved-searches.v1',
            JSON.stringify([
                {
                    id: 'saved-invoices',
                    name: 'Acme invoices',
                    query: 'from:concierge@example.com',
                    scope: 'folder'
                }
            ])
        );
    });

    await login(page);
    await page.getByTestId('search-input').click();
    await expect(page.getByTestId('saved-search-saved-invoices')).toBeVisible();
    await page.getByTestId('saved-search-saved-invoices').click();
    await expect(page.getByTestId('search-input')).toHaveValue('from:concierge@example.com');
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-1018')).toHaveCount(0);
});

test('user can save the current search from the header dropdown', async ({ page }) => {
    await login(page);
    await page.getByTestId('search-input').fill('subject:Welcome');
    await page.waitForTimeout(400);
    await page.getByTestId('search-input').click();
    await page.getByTestId('search-save-trigger').click();
    await page.getByTestId('search-save-name').fill('Welcome mail');
    await page.getByTestId('search-save-confirm').click();
    await page.getByTestId('search-input').click();
    await expect(page.getByTestId('search-suggest')).toContainText('Welcome mail');
});

test('removing a saved search drops it from the list', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            'webmail.saved-searches.v1',
            JSON.stringify([
                { id: 'rm-me', name: 'Temp', query: 'is:unread', scope: 'folder' }
            ])
        );
    });

    await login(page);
    await page.getByTestId('search-input').click();
    await expect(page.getByTestId('saved-search-rm-me')).toBeVisible();
    await page.getByTestId('saved-search-remove-rm-me').click();
    await expect(page.getByTestId('saved-search-rm-me')).toHaveCount(0);
});
