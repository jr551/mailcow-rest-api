import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const JORDAN_NEWER = 1017;
const JORDAN_OLDER = 1021;

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

async function openSweepDialog(page: import('@playwright/test').Page, uid: number) {
    await page.getByTestId(`msg-row-${uid}`).click({ button: 'right' });
    await page.getByTestId('ctx-sweep-trigger').click();
    await expect(page.getByTestId('sender-sweep-dialog')).toBeVisible();
}

test.describe('Outlook sender sweep (slice 10)', () => {
    test('keep only the latest removes older messages from Jordan Lee', async ({ page }) => {
        await login(page);
        await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toBeVisible();
        await expect(page.getByTestId(`msg-row-${JORDAN_NEWER}`)).toBeVisible();

        await openSweepDialog(page, JORDAN_NEWER);
        await page.getByTestId('sender-sweep-action-keep-latest').check();
        await page.getByTestId('sender-sweep-apply').click();

        await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toHaveCount(0);
        await expect(page.getByTestId(`msg-row-${JORDAN_NEWER}`)).toBeVisible();
    });

    test('delete all from sender removes every Jordan Lee message', async ({ page }) => {
        await login(page);
        await openSweepDialog(page, JORDAN_NEWER);
        await page.getByTestId('sender-sweep-action-delete-all').check();
        await page.getByTestId('sender-sweep-apply').click();

        await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toHaveCount(0);
        await expect(page.getByTestId(`msg-row-${JORDAN_NEWER}`)).toHaveCount(0);
    });

    test('sweep entry opens the Sweep dialog', async ({ page }) => {
        await login(page);
        await openSweepDialog(page, JORDAN_NEWER);
        await expect(page.getByTestId('sender-sweep-dialog')).toContainText('Move all messages');
    });
});
