import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const ASSET_DIR = 'docs/assets/outlook-slice31';
mkdirSync(ASSET_DIR, { recursive: true });

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
});

test('mobile saved search runs stored query from search panel', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            'webmail.saved-searches.v1',
            JSON.stringify([
                {
                    id: 'mob-invoices',
                    name: 'Acme invoices',
                    query: 'from:concierge@example.com',
                    scope: 'folder'
                }
            ])
        );
    });
    await loginMobile(page);
    await page.getByTestId('mobile-search-input').click();
    await expect(page.getByTestId('saved-search-mob-invoices')).toBeVisible();
    await page.getByTestId('saved-search-mob-invoices').click();
    await expect(page.getByTestId('mobile-search-input')).toHaveValue('from:concierge@example.com');
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
});

test('mobile user can save current search from panel', async ({ page }) => {
    await loginMobile(page);
    await page.getByTestId('mobile-search-input').fill('subject:Welcome');
    await page.waitForTimeout(400);
    await page.getByTestId('mobile-search-input').click();
    await page.getByTestId('search-save-trigger').click();
    await page.getByTestId('search-save-name').fill('Welcome mail');
    await page.getByTestId('search-save-confirm').click();
    await page.getByTestId('mobile-search-input').click();
    await expect(page.getByTestId('mobile-search-suggest')).toContainText('Welcome mail');
});

test('mobile saved search panel screenshot', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            'webmail.saved-searches.v1',
            JSON.stringify([
                { id: 'shot-team', name: 'Team updates', query: 'subject:team', scope: 'folder' },
                { id: 'shot-unread', name: 'Unread mail', query: 'is:unread', scope: 'all' }
            ])
        );
    });
    await loginMobile(page);
    await page.getByTestId('mobile-search-input').click();
    await expect(page.getByTestId('mobile-search-suggest')).toBeVisible();
    await page.screenshot({ path: `${ASSET_DIR}/61-mobile-saved-searches-panel.png`, fullPage: false });
});
