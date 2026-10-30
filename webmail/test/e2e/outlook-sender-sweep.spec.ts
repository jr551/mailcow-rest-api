import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const JORDAN_NEWER = 1017;
const JORDAN_OLDER = 1021;

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook sender sweep (slice 10)', () => {
    test('keep only the latest removes older messages from Jordan Lee', async ({ page }) => {
        await login(page);
        await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toBeVisible();
        await expect(page.getByTestId(`msg-row-${JORDAN_NEWER}`)).toBeVisible();

        page.once('dialog', (d) => d.accept());
        const row = page.getByTestId(`msg-row-${JORDAN_NEWER}`);
        await row.click({ button: 'right' });
        await page.getByTestId('ctx-sweep-trigger').hover();
        await page.getByTestId('ctx-sweep-item-keep-latest').click();

        await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toHaveCount(0);
        await expect(page.getByTestId(`msg-row-${JORDAN_NEWER}`)).toBeVisible();
    });

    test('delete all from sender removes every Jordan Lee message', async ({ page }) => {
        await login(page);
        page.once('dialog', (d) => d.accept());
        await page.getByTestId(`msg-row-${JORDAN_NEWER}`).click({ button: 'right' });
        await page.getByTestId('ctx-sweep-trigger').hover();
        await page.getByTestId('ctx-sweep-item-delete-all').click();

        await expect(page.getByTestId(`msg-row-${JORDAN_OLDER}`)).toHaveCount(0);
        await expect(page.getByTestId(`msg-row-${JORDAN_NEWER}`)).toHaveCount(0);
    });

    test('sweep submenu is visible in the context menu', async ({ page }) => {
        await login(page);
        await page.getByTestId(`msg-row-${JORDAN_NEWER}`).click({ button: 'right' });
        await expect(page.getByTestId('ctx-sweep-trigger')).toBeVisible();
        await page.getByTestId('ctx-sweep-trigger').hover();
        await expect(page.getByTestId('ctx-sweep-item-archive-all')).toContainText('Archive');
    });
});
