import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

type Contact = { uid: string; address: string; name: string | null; lastSeen: number; count: number };

function installContactApi(page: Page, seed: Contact[]) {
    const store = new Map(seed.map((c) => [c.address.toLowerCase(), c]));
    page.route('**/v1/me/contacts**', async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ contacts: [...store.values()], folder: '.book-addresses' })
            });
        }
        return route.fulfill({ status: 405, body: '{}' });
    });
}

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
    installContactApi(page, [
        {
            uid: 'c1',
            address: 'alice@example.com',
            name: 'Alice Example',
            count: 5,
            lastSeen: Date.now()
        }
    ]);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
});

test('mobile search category tabs switch Mail, People, and Files', async ({ page }) => {
    await loginMobile(page);
    await expect(page.getByTestId('mobile-search-category-tabs')).toBeVisible();
    await expect(page.getByTestId('mobile-search-category-mail')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId('mobile-search-category-people').click();
    await expect(page.getByTestId('mobile-search-category-people')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('mobile-search-input').click();
    await page.getByTestId('mobile-search-input').fill('Alice');
    await expect(page.getByTestId('mobile-search-suggest')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('mobile-search-people-result').first()).toContainText('alice@example.com');
    await page.getByTestId('mobile-search-people-result').first().click();
    await expect(page.getByTestId('compose-to')).toBeVisible();
    await expect(page.getByTestId('compose-to')).toHaveValue('alice@example.com');
});

test('mobile Files search adds attachment scope chip', async ({ page }) => {
    await loginMobile(page);
    await page.getByTestId('mobile-search-category-files').click();
    await page.getByTestId('mobile-search-input').fill('Welcome');
    await page.waitForTimeout(450);
    await expect(page.getByTestId('mobile-search-files-scope')).toBeVisible();
});
