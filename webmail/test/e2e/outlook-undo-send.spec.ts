import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

let sendCalls = 0;

async function enableSmtpAndUndoSend(page: import('@playwright/test').Page) {
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
            body: JSON.stringify({ messageId: '<mock-sent-1@local>' })
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

test.beforeEach(async ({ page }) => {
    sendCalls = 0;
    await applyMocks(page);
    await enableSmtpAndUndoSend(page);
});

test.describe('Outlook undo send (slice 12)', () => {
    test('undo cancels the delayed send and restores compose', async ({ page }) => {
        await login(page);
        await patchSettings(page, { undoSendSeconds: 8 });
        await page.reload();
        await page.waitForSelector('[data-testid=shell]');

        await page.click('[data-testid=compose-btn]');
        await expect(page.getByTestId('compose-modal')).toBeVisible();
        await page.fill('[data-testid=compose-to]', 'friend@example.com');
        await page.fill('[data-testid=compose-subject]', 'Undo me');
        await page.locator('[data-testid=rich-editor-surface]').click();
        await page.keyboard.type('Hello there');
        await page.getByTestId('compose-send').click();

        await expect(page.getByTestId('compose-modal')).toHaveCount(0);
        await expect(page.getByTestId('send-undo-btn')).toBeVisible();
        expect(sendCalls).toBe(0);

        await page.getByTestId('send-undo-btn').click();
        await expect(page.getByTestId('compose-modal')).toBeVisible();
        await expect(page.getByTestId('compose-subject')).toHaveValue('Undo me');
        expect(sendCalls).toBe(0);
    });

    test('message sends after the undo window', async ({ page }) => {
        await login(page);
        await patchSettings(page, { undoSendSeconds: 1 });
        await page.reload();
        await page.waitForSelector('[data-testid=shell]');

        await page.click('[data-testid=compose-btn]');
        await page.fill('[data-testid=compose-to]', 'friend@example.com');
        await page.fill('[data-testid=compose-subject]', 'Go now');
        await page.getByTestId('compose-send').click();
        await expect(page.getByTestId('compose-modal')).toHaveCount(0);

        await page.waitForTimeout(1600);
        expect(sendCalls).toBe(1);
    });
});
