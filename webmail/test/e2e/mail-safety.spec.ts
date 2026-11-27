import { test, expect, type Page } from '@playwright/test';
import { applyMocks, detailFor1001, login, mailboxes, messages, MOCK_USER, MOCK_PASS } from './fixtures';

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

test('a late 401 is not retried under the newly active account', async ({ page }) => {
    await applyMocks(page);
    await login(page);

    let authPosts = 0;
    page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/auth/session') {
            authPosts++;
        }
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markFinished!: () => void;
    const finished = new Promise<void>((resolve) => { markFinished = resolve; });
    let calls = 0;
    await page.route(/\/v1\/mailboxes\?counts=true/, async (route) => {
        calls++;
        if (calls === 1) {
            markStarted();
            await gate;
            await route.fulfill({
                status: 401,
                contentType: 'application/problem+json',
                body: JSON.stringify({ status: 401, title: 'Unauthorized' })
            });
            markFinished();
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
    const authPostsAfterSwitch = authPosts;

    release();
    await finished;
    await expect.poll(() => calls).toBe(2);
    await expect.poll(() => authPosts).toBe(authPostsAfterSwitch);
    await expect(page.getByTestId('folder-Second')).toBeVisible();
});

test('a pending 401 renewal cannot steal focus from the account switched to', async ({ page }) => {
    await applyMocks(page);
    await login(page);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markRenewalStarted!: () => void;
    const renewalStarted = new Promise<void>((resolve) => { markRenewalStarted = resolve; });
    let markRenewalFinished!: () => void;
    const renewalFinished = new Promise<void>((resolve) => { markRenewalFinished = resolve; });
    const primaryBasic = `Basic ${Buffer.from(`${MOCK_USER}:${MOCK_PASS}`).toString('base64')}`;
    await page.route('**/v1/auth/session', async (route) => {
        const request = route.request();
        if (request.method() === 'POST' && request.headers().authorization === primaryBasic) {
            markRenewalStarted();
            await gate;
            await route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ token: 'renewed-primary-token', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
            });
            markRenewalFinished();
            return;
        }
        await route.fallback();
    });

    let mailboxCalls = 0;
    await page.route(/\/v1\/mailboxes\?counts=true/, async (route) => {
        mailboxCalls++;
        if (mailboxCalls === 1) {
            await route.fulfill({
                status: 401,
                contentType: 'application/problem+json',
                body: JSON.stringify({ status: 401, title: 'Unauthorized' })
            });
            return;
        }
        await route.fallback();
    });

    await page.getByTestId('sidebar-refresh-btn').click();
    await renewalStarted;
    await addSecondAccount(page);
    await expect(page.getByTestId('account-btn')).toContainText('second@test.local');

    release();
    await renewalFinished;
    await expect(page.getByTestId('account-btn')).toContainText('second@test.local');
    await expect.poll(() => mailboxCalls).toBe(2);
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

test('a late move response cannot remove or create undo state in another account', async ({ page }) => {
    await applyMocks(page);
    await login(page);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markFinished!: () => void;
    const finished = new Promise<void>((resolve) => { markFinished = resolve; });
    await page.route('**/v1/mailboxes/INBOX/messages/1001/move', async (route) => {
        markStarted();
        await gate;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ uid: 1001, path: 'Trash', destUid: 2001 })
        });
        markFinished();
    });

    const row = page.getByTestId('msg-row-1001');
    await row.hover();
    await row.getByRole('button', { name: 'Move to Trash' }).click({ force: true });
    await started;
    await addSecondAccount(page);
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();

    release();
    await finished;
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
});

test('a late load-more response cannot append another account’s messages', async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => {
        localStorage.setItem('webmail.settings.v1', JSON.stringify({ pageSize: 'unlimited' }));
    });

    const firstPage = Array.from({ length: 100 }, (_, i) => {
        const source = messages[i % messages.length];
        return {
            ...source,
            uid: 3000 + i,
            seq: i + 1,
            envelope: {
                ...source.envelope,
                subject: `Page one message ${i + 1}`,
                messageId: `<page-one-${i + 1}@test.local>`,
                inReplyTo: null
            }
        };
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markFinished!: () => void;
    const finished = new Promise<void>((resolve) => { markFinished = resolve; });
    await page.route(/\/v1\/mailboxes\/INBOX\/messages\?/, async (route) => {
        const url = new URL(route.request().url());
        const pageNumber = Number(url.searchParams.get('page') || 0);
        if (pageNumber === 1) {
            markStarted();
            await gate;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    path: 'INBOX',
                    page: 1,
                    pageSize: 100,
                    total: 101,
                    messages: [{ ...firstPage[0], uid: 3999, seq: 101, envelope: { ...firstPage[0].envelope, subject: 'Old account only' } }]
                })
            });
            markFinished();
        } else {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ path: 'INBOX', page: 0, pageSize: 100, total: 101, messages: firstPage })
            });
        }
    });

    await login(page);
    await expect(page.getByTestId('msg-row-3099')).toBeVisible();
    await page.getByTestId('msg-list').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
    });
    await started;

    await addSecondAccount(page);
    await expect(page.getByTestId('msg-row-3099')).toBeVisible();
    release();
    await finished;
    await expect(page.getByTestId('msg-row-3999')).toHaveCount(0);
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

test('aggregate context menus resolve the clicked folder when UIDs collide', async ({ page }) => {
    await applyMocks(page);
    const sentMessage = {
        ...messages[0],
        uid: 1001,
        seq: 1,
        envelope: {
            ...messages[0].envelope,
            subject: 'Sent invoice follow-up',
            messageId: '<sent-invoice@example.test>',
            inReplyTo: null,
            from: [{ name: 'Sent Sender', address: 'sent-sender@example.test' }]
        }
    };
    await page.route('**/v1/mailboxes/Sent/messages?*', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ path: 'Sent', page: 0, pageSize: 100, total: 1, messages: [sentMessage] })
        });
    });

    await login(page);
    await page.getByTestId('search-input').fill('invoice');
    await page.getByTestId('search-scope-all').click();
    const sentRow = page.locator('.row').filter({ hasText: 'Sent Sender' });
    await expect(sentRow).toBeVisible();
    await sentRow.click({ button: 'right' });
    await page.getByTestId('msg-ctx').getByRole('menuitem', { name: 'Create rule from message' }).click();

    await expect(page.getByTestId('rule-from-message-source')).toContainText('sent-sender@example.test');
    await expect(page.getByTestId('rule-condition-value')).toHaveValue('sent-sender@example.test');
});

test('opening a global-search result cancels remaining folder requests', async ({ page }) => {
    await applyMocks(page);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markFinished!: () => void;
    const finished = new Promise<void>((resolve) => { markFinished = resolve; });
    const fromAnotherFolder = {
        ...messages[0],
        uid: 2001,
        envelope: { ...messages[0].envelope, subject: 'Late result from Sent' }
    };
    await page.route(/\/v1\/mailboxes\/Sent\/messages\?/, async (route) => {
        markStarted();
        await gate;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ path: 'Sent', page: 0, pageSize: 100, total: 1, messages: [fromAnotherFolder] })
        });
        markFinished();
    });

    await login(page);
    await page.getByTestId('search-input').fill('invoice');
    await page.getByTestId('search-scope-all').click();
    await started;
    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('detail-subject')).toContainText('Welcome');

    release();
    await finished;
    await expect(page.getByTestId('msg-row-2001')).toHaveCount(0);
    await expect(page.locator('.folder-badge')).toHaveCount(0);
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
