import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const FLAG_UID = 1001;

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook follow-up flags (slice 18)', () => {
    test('Flag submenu sets follow-up today on the row', async ({ page }) => {
        await login(page);
        const row = page.getByTestId(`msg-row-${FLAG_UID}`);
        await row.click({ button: 'right' });
        await page.getByTestId('ctx-follow-up-trigger').hover();
        await page.getByTestId('ctx-follow-up-item-today').click();
        await expect(row).toHaveAttribute('data-follow-up', 'Follow up today');
        await expect(page.getByTestId(`msg-follow-up-${FLAG_UID}`)).toHaveText('Follow up today');
    });

    test('Clear flag removes follow-up hint', async ({ page }) => {
        await login(page);
        const row = page.getByTestId(`msg-row-${FLAG_UID}`);
        await row.click({ button: 'right' });
        await page.getByTestId('ctx-follow-up-trigger').hover();
        await page.getByTestId('ctx-follow-up-item-today').click();
        await expect(row).toHaveAttribute('data-follow-up', 'Follow up today');

        await row.click({ button: 'right' });
        await page.getByTestId('ctx-follow-up-trigger').hover();
        await page.getByTestId('ctx-follow-up-item-clear').click();
        await expect(row).toHaveAttribute('data-follow-up', '');
    });
});
