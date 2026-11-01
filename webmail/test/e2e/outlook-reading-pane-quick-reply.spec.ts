import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

let sendCalls = 0;

async function enableSmtpSend(page: import('@playwright/test').Page) {
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
            body: JSON.stringify({ messageId: '<mock-quick-reply@local>' })
        });
    });
}

test.beforeEach(async ({ page }) => {
    sendCalls = 0;
    await applyMocks(page);
    await enableSmtpSend(page);
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'light');
        const key = 'webmail.settings.v1';
        let base: Record<string, unknown> = {};
        try {
            const raw = localStorage.getItem(key);
            if (raw) base = JSON.parse(raw);
        } catch { /* noop */ }
        localStorage.setItem(
            key,
            JSON.stringify({ ...base, undoSendSeconds: 0, aiFeatures: false, preSendCheck: false })
        );
    });
});

test('reading pane quick reply expands and sends', async ({ page }) => {
    await login(page);
    await page.evaluate(() => {
        const key = 'webmail.settings.v1';
        let base: Record<string, unknown> = {};
        try {
            const raw = localStorage.getItem(key);
            if (raw) base = JSON.parse(raw);
        } catch { /* noop */ }
        localStorage.setItem(key, JSON.stringify({ ...base, undoSendSeconds: 0 }));
    });
    await page.reload();
    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('reading-pane-quick-reply')).toBeVisible();
    await page.getByTestId('reading-pane-quick-reply-trigger').click();
    await page.getByTestId('reading-pane-quick-reply-input').fill('Thanks for the welcome!');
    await page.getByTestId('reading-pane-quick-reply-send').click();
    await expect(page.getByText("Sending… we'll let you know when it's delivered.")).toBeVisible({ timeout: 10_000 });
    expect(sendCalls).toBe(1);
});

test('Open full reply opens compose modal', async ({ page }) => {
    await login(page);
    await page.getByTestId('msg-row-1001').click();
    await page.getByTestId('reading-pane-quick-reply-trigger').click();
    await page.getByTestId('reading-pane-quick-reply-full').click();
    await expect(page.getByTestId('compose-modal')).toBeVisible();
});
