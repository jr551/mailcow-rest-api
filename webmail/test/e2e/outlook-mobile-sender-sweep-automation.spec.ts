import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, MOCK_PASS } from './fixtures';

const JORDAN_NEWER = 1017;
const JORDAN_OLDER = 1021;

async function loginMobile(page: import('@playwright/test').Page) {
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', MOCK_PASS);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
}

async function openActionSheet(page: import('@playwright/test').Page, uid: number) {
    const row = page.getByTestId(`msg-row-${uid}`);
    await row.dispatchEvent('pointerdown', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
    await page.waitForTimeout(600);
    await row.dispatchEvent('pointerup', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
    await expect(page.getByRole('dialog', { name: 'Message actions' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await applyMocks(page);
});

test.describe('Outlook mobile sender sweep automation (slice 56)', () => {
    test('mobile Sweep dialog creates always-trash rule', async ({ page }) => {
        await loginMobile(page);
        await openActionSheet(page, JORDAN_NEWER);
        await page.getByTestId('mobile-sweep-trigger').click();
        await expect(page.getByTestId('sender-sweep-dialog')).toBeVisible();

        await page.getByTestId('sender-sweep-automation-trash').check();
        await page.getByTestId('sender-sweep-apply').click();
        await expect(page.getByTestId('sender-sweep-dialog')).toHaveCount(0);

        const body = await page.evaluate(async () => {
            const r = await fetch('/v1/me/mail-rules');
            return r.json() as Promise<{ rules: { name: string; condition: { value: string }; action: { folder?: string } }[] }>;
        });
        const rule = body.rules.find((r) => r.name.includes('Sweep:') && r.condition.value.includes('jordan.lee'));
        expect(rule).toBeTruthy();
        expect(rule?.action.folder).toBeTruthy();
    });

    test('mobile Sweep dialog keep-latest removes older messages from sender', async ({ page }) => {
        await loginMobile(page);
        await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toBeVisible();
        await openActionSheet(page, JORDAN_NEWER);
        await page.getByTestId('mobile-sweep-trigger').click();
        await expect(page.getByTestId('sender-sweep-dialog')).toBeVisible();
        await page.getByTestId('sender-sweep-action-keep-latest').check();
        await page.getByTestId('sender-sweep-apply').click();
        await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toHaveCount(0);
        await expect(page.getByTestId(`msg-row-${JORDAN_NEWER}`)).toBeVisible();
    });
});
