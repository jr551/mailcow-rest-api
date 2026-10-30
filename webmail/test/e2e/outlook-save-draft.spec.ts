import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

let draftAppends = 0;
let lastDraftBody = '';

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
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ messageId: '<mock-sent@local>', sent: true })
        });
    });
}

test.beforeEach(async ({ page }) => {
    draftAppends = 0;
    lastDraftBody = '';
    await applyMocks(page);
    await enableSmtp(page);
    await page.route('**/v1/mailboxes/Drafts/messages**', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        draftAppends += 1;
        lastDraftBody = route.request().postDataBuffer()?.toString('utf8') || '';
        const flags = new URL(route.request().url()).searchParams.get('flags');
        expect(flags).toBe('Draft');
        await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({ path: 'Drafts', uid: 9001, uidValidity: 1 })
        });
    });
});

test.describe('Outlook explicit save draft (slice 14)', () => {
    test('Save draft button appends to Drafts with Ctrl+S shortcut', async ({ page }) => {
        await login(page);
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid=compose-btn]');
        await expect(page.getByTestId('compose-modal')).toBeVisible();
        await page.fill('[data-testid=compose-to]', 'draft@example.com');
        await page.fill('[data-testid=compose-subject]', 'Slice 14 save draft');
        await page.locator('[data-testid=rich-editor-surface]').click();
        await page.keyboard.type('Body for draft save test.');
        await page.getByTestId('compose-save-draft').click();
        await expect.poll(() => draftAppends).toBe(1);
        expect(lastDraftBody).toMatch(/Subject: Slice 14 save draft/);
        expect(lastDraftBody).toMatch(/draft@example.com/);
        await expect(page.getByText('Draft saved to Drafts')).toBeVisible();

        draftAppends = 0;
        await page.locator('[data-testid=rich-editor-surface]').click();
        await page.keyboard.press('Control+s');
        await expect.poll(() => draftAppends).toBe(1);
    });
});
