import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

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
            body: JSON.stringify({ messageId: '<mock-scheduled@local>' })
        });
    });
}

async function patchSettings(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        const key = 'webmail.settings.v1';
        let base: Record<string, unknown> = {};
        try {
            const raw = localStorage.getItem(key);
            if (raw) base = JSON.parse(raw);
        } catch { /* noop */ }
        localStorage.setItem(key, JSON.stringify({ ...base, aiFeatures: false, preSendCheck: false, undoSendSeconds: 0 }));
    });
}

test.beforeEach(async ({ page }) => {
    sendCalls = 0;
    await applyMocks(page);
    await enableSmtp(page);
});

test.describe('Outlook scheduled send (slice 13)', () => {
    test('schedule send queues locally and flushes when due on reload', async ({ page }) => {
        await login(page);
        await patchSettings(page);
        await page.reload();
        await page.waitForSelector('[data-testid=shell]');

        await page.click('[data-testid=compose-btn]');
        await page.fill('[data-testid=compose-to]', 'later@example.com');
        await page.fill('[data-testid=compose-subject]', 'Scheduled hello');
        await page.locator('[data-testid=rich-editor-surface]').click();
        await page.keyboard.type('See you soon');

        await page.getByTestId('compose-send-menu-btn').click();
        await page.getByTestId('compose-schedule-send').click();
        await expect(page.getByTestId('schedule-send-dialog')).toBeVisible();
        await page.getByTestId('schedule-preset-in-one-hour').click();
        await page.getByTestId('schedule-send-confirm').click();

        await expect(page.getByTestId('compose-modal')).toHaveCount(0);
        expect(sendCalls).toBe(0);

        const queued = await page.evaluate(() => {
            const raw = localStorage.getItem('webmail.scheduled-sends.v1');
            return raw ? JSON.parse(raw) : [];
        });
        expect(queued.length).toBe(1);
        expect(queued[0].payload.subject).toContain('Scheduled hello');

        await page.evaluate(() => {
            const key = 'webmail.scheduled-sends.v1';
            const items = JSON.parse(localStorage.getItem(key) || '[]');
            items[0].sendAtMs = Date.now() - 5000;
            localStorage.setItem(key, JSON.stringify(items));
        });

        await page.reload();
        await page.waitForSelector('[data-testid=shell]');
        await expect.poll(() => sendCalls, { timeout: 8000 }).toBe(1);
    });
});
