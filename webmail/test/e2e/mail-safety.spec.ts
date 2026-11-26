import { test, expect, type Page } from '@playwright/test';
import { applyMocks, detailFor1001, login, mailboxes } from './fixtures';

async function addSecondAccount(page: Page) {
    await page.getByTestId('account-btn').click();
    await page.getByTestId('account-menu-add').click();
    await page.getByTestId('login-user').fill('second@test.local');
    await page.getByTestId('login-pass').fill('hunter3');
    await page.getByTestId('login-submit').click();
    await expect(page.locator('[data-testid="account-btn"] .user-email')).toContainText('second@test.local');
}

test('a late mailbox response cannot cross an account switch', async ({ page }) => {
    await applyMocks(page);
    await login(page);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    await page.route(/\/v1\/mailboxes\?counts=true/, async (route) => {
        calls++;
        if (calls === 1) {
            markStarted();
            await gate;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([...mailboxes, { path: 'Old Only', name: 'Old Only', delimiter: '/', flags: [], subscribed: true }])
            });
        } else {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([...mailboxes, { path: 'Second', name: 'Second', delimiter: '/', flags: [], subscribed: true }])
            });
        }
    });

    await page.getByTestId('sidebar-refresh-btn').click();
    await started;
    await addSecondAccount(page);
    await expect(page.getByTestId('folder-Second')).toBeVisible();

    release();
    await page.waitForTimeout(100);
    await expect(page.getByTestId('folder-Second')).toBeVisible();
    await expect(page.getByTestId('folder-Old Only')).toHaveCount(0);
});

test('a late message body cannot cross an account switch', async ({ page }) => {
    await applyMocks(page);
    await login(page);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    await page.route('**/v1/mailboxes/INBOX/messages/1001', async (route) => {
        markStarted();
        await gate;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detailFor1001) });
    });

    await page.getByTestId('msg-row-1001').click();
    await started;
    await addSecondAccount(page);
    release();
    await page.waitForTimeout(100);
    await expect(page.getByTestId('detail-subject')).toHaveCount(0);
});

test('aggregated search results cannot mutate the wrong folder', async ({ page }) => {
    await applyMocks(page);
    await login(page);
    const flagRequests: string[] = [];
    await page.route('**/v1/mailboxes/*/messages/*/flags', async (route) => {
        flagRequests.push(route.request().url());
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ flags: ['\\Seen', '\\Flagged'] }) });
    });

    await page.getByTestId('search-input').fill('invoice');
    await page.getByTestId('search-scope-all').click();
    await expect(page.getByTestId('search-scope-folder')).toBeVisible();
    await page.waitForLoadState('networkidle');

    const row = page.getByTestId('msg-row-1001');
    await row.hover();
    await row.getByRole('button', { name: 'Star', exact: true }).click();
    await expect(page.locator('[data-testid="toast"]')).toContainText(/Open the message first/i);
    expect(flagRequests).toHaveLength(0);

    // Opening a result scopes the list to its real folder; normal actions are
    // available again and target that folder.
    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('detail-subject')).toContainText('Welcome');
    await expect(page.getByTestId('search-scope-all')).toBeVisible();
});

test('a failed message load replaces the previous body with an error', async ({ page }) => {
    await applyMocks(page);
    await login(page);
    await page.route('**/v1/mailboxes/INBOX/messages/1000', (route) => {
        route.fulfill({
            status: 500,
            contentType: 'application/problem+json',
            body: JSON.stringify({ status: 500, title: 'Internal Server Error', detail: 'Failed to load message' })
        });
    });

    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('detail-subject')).toContainText('Welcome');
    await page.getByTestId('msg-row-1000').click();
    await expect(page.getByRole('alert')).toContainText('Failed to load message');
    await expect(page.getByTestId('detail-subject')).toHaveCount(0);
});
