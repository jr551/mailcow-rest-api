import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

let sendCalls = 0;

async function enableSmtp(page: import('@playwright/test').Page) {
    await page.route(/\/health$/, (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true,
                cache: 0,
                pool: 0,
                capabilities: { ai: true, ocr: true, smtp: true, drive: true }
            })
        });
    });
    await page.route('**/imap-rest/health', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true,
                cache: 0,
                pool: 0,
                capabilities: { ai: true, ocr: true, smtp: true, drive: true }
            })
        });
    });
    await page.route('**/v1/messages/send', (route) => {
        sendCalls += 1;
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ sent: true, messageId: '<mock-mobile-sent@local>' })
        });
    });
}

async function patchSettings(page: import('@playwright/test').Page, patch: Record<string, unknown>) {
    await page.evaluate((p) => {
        const key = 'webmail.settings.v1';
        let base: Record<string, unknown> = {};
        try {
            const raw = localStorage.getItem(key);
            if (raw) base = JSON.parse(raw);
        } catch { /* noop */ }
        localStorage.setItem(key, JSON.stringify({ ...base, ...p, aiFeatures: false, preSendCheck: false }));
    }, patch);
}

async function loginMobile(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    sendCalls = 0;
    await page.setViewportSize({ width: 390, height: 844 });
    await applyMocks(page);
    await enableSmtp(page);
});

test('mobile undo send restores compose from toast', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    await patchSettings(page, { undoSendSeconds: 8 });
    await page.reload();
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();

    await page.getByTestId('compose-btn').click();
    await expect(page.getByTestId('compose-send')).toBeVisible();
    await page.fill('[data-testid=compose-to]', 'friend@example.com');
    await page.fill('[data-testid=compose-subject]', 'Mobile undo me');
    await page.fill('[data-testid=compose-body]', 'Hello mobile');
    await page.getByTestId('compose-send').click();

    await expect(page.getByTestId('compose-send')).toHaveCount(0);
    await expect(page.getByTestId('mobile-send-undo-btn')).toBeVisible();
    expect(sendCalls).toBe(0);

    await page.getByTestId('mobile-send-undo-btn').click();
    await expect(page.getByTestId('compose-send')).toBeVisible();
    await expect(page.getByTestId('compose-subject')).toHaveValue('Mobile undo me');
    await expect(page.getByTestId('compose-body')).toHaveValue('Hello mobile');
    expect(sendCalls).toBe(0);
});

test('mobile undo send toast screenshot', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await loginMobile(page);
    await patchSettings(page, { undoSendSeconds: 10 });
    await page.reload();
    await page.getByTestId('compose-btn').click();
    await page.fill('[data-testid=compose-to]', 'friend@example.com');
    await page.fill('[data-testid=compose-subject]', 'Undo toast shot');
    await page.fill('[data-testid=compose-body]', 'Body');
    await page.getByTestId('compose-send').click();
    await expect(page.getByTestId('mobile-send-undo-btn')).toBeVisible();
});
