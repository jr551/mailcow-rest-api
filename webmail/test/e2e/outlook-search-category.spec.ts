import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { applyMocks, login } from './fixtures';

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

test.beforeEach(async ({ page }) => {
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

test('search category tabs switch Mail, People, and Files', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('search-category-tabs')).toBeVisible();
    await expect(page.getByTestId('search-category-mail')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId('search-category-people').click();
    await expect(page.getByTestId('search-category-people')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('search-input').fill('Alice');
    await expect(page.getByTestId('search-suggest')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('search-people-result').first()).toContainText('alice@example.com');

    await page.getByTestId('search-people-result').first().click();
    await expect(page.getByTestId('compose-to')).toBeVisible();
    await expect(page.getByTestId('compose-to')).toHaveValue('alice@example.com');
});

test('Files category scopes search to attachments', async ({ page }) => {
    await login(page);
    await page.getByTestId('search-category-files').click();
    await page.getByTestId('search-input').fill('Welcome');
    await page.waitForTimeout(450);
    await expect(page.getByTestId('search-files-scope')).toBeVisible();
    await expect(page.getByTestId('search-input')).toHaveValue('Welcome');
});
