import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const TARGET_UID = 1001;

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook message categories (slice 7)', () => {
    test('context menu assigns a colour category with list stripe', async ({ page }) => {
        await login(page);
        const row = page.getByTestId(`msg-row-${TARGET_UID}`);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute('data-category', '');

        await row.click({ button: 'right' });
        await expect(page.getByTestId('msg-ctx')).toBeVisible();
        await page.getByTestId('ctx-category-trigger').hover();
        await page.getByTestId('ctx-category-item-blue').click();

        await expect(row).toHaveAttribute('data-category', 'blue');
        const stripe = page.getByTestId(`msg-category-${TARGET_UID}`);
        await expect(stripe).toBeVisible();
        await expect(stripe).toHaveCSS('background-color', 'rgb(0, 120, 212)');

        await row.click({ button: 'right' });
        await page.getByTestId('ctx-category-trigger').hover();
        await page.getByTestId('ctx-category-item-clear').click();
        await expect(row).toHaveAttribute('data-category', '');
    });

    test('category keywords persist on mocked IMAP flags', async ({ page }) => {
        await login(page);
        const row = page.getByTestId(`msg-row-${TARGET_UID}`);
        await row.click({ button: 'right' });
        await page.getByTestId('ctx-category-trigger').hover();
        await page.getByTestId('ctx-category-item-green').click();
        await expect(row).toHaveAttribute('data-category', 'green');

        await page.reload();
        await expect(page.getByTestId(`msg-row-${TARGET_UID}`)).toHaveAttribute('data-category', 'green');
        await expect(page.getByTestId(`msg-category-${TARGET_UID}`)).toHaveCSS(
            'background-color',
            'rgb(16, 124, 16)'
        );
    });
});
