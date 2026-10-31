import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

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
            body: JSON.stringify({ path: 'Drafts', uid: 9101, uidValidity: 1 })
        });
    });
});

test.describe('Outlook mobile save draft (slice 37)', () => {
    test('Save draft button appends to Drafts', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', MOCK_PASS);
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('compose-btn').click();
        await page.fill('[data-testid=compose-to]', 'draft-mobile@example.com');
        await page.fill('[data-testid=compose-subject]', 'Slice 37 mobile draft');
        await page.fill('[data-testid=compose-body]', 'Saved from mobile compose.');
        await page.getByTestId('compose-save-draft').click();
        await expect.poll(() => draftAppends).toBe(1);
        expect(lastDraftBody).toMatch(/Subject: Slice 37 mobile draft/);
        expect(lastDraftBody).toMatch(/draft-mobile@example.com/);
        await expect(page.getByText('Draft saved to Drafts')).toBeVisible();
    });
});
