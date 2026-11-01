import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const JORDAN_NEWER = 1017;

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook sender sweep automation (slice 54)', () => {
    test('Sweep dialog creates always-trash rule without one-time confirm', async ({ page }) => {
        await login(page);
        await page.getByTestId(`msg-row-${JORDAN_NEWER}`).click({ button: 'right' });
        await page.getByTestId('ctx-sweep-trigger').click();
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

    test('Sweep dialog shows automation checkbox for archive action', async ({ page }) => {
        await login(page);
        await page.getByTestId(`msg-row-${JORDAN_NEWER}`).click({ button: 'right' });
        await page.getByTestId('ctx-sweep-trigger').click();
        await page.getByTestId('sender-sweep-action-archive-all').check();
        await expect(page.getByTestId('sender-sweep-automation-archive')).toBeVisible();
        await expect(page.getByTestId('sender-sweep-automation-trash')).toHaveCount(0);
    });
});
