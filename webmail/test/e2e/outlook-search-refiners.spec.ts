import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
});

test('search refiners appear for an active query and toggle has:attachment', async ({ page }) => {
    await login(page);
    await page.getByTestId('search-input').fill('Welcome');
    await page.waitForTimeout(450);
    await expect(page.getByTestId('search-refiners')).toBeVisible();
    await expect(page.getByTestId('search-refiner-has-attachment')).toBeVisible();

    await page.getByTestId('search-refiner-has-attachment').click();
    await expect(page.getByTestId('search-input')).toHaveValue(/has:attachment/);
    await expect(page.getByTestId('search-refiner-has-attachment')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('search-refiner-has-attachment').click();
    await expect(page.getByTestId('search-input')).toHaveValue('Welcome');
    await expect(page.getByTestId('search-refiner-has-attachment')).toHaveAttribute('aria-pressed', 'false');
});

test('is:unread refiner narrows mock search results', async ({ page }) => {
    await login(page);
    await page.getByTestId('search-input').fill('subject:');
    await page.waitForTimeout(450);
    await page.getByTestId('search-refiner-is-unread').click();
    await expect(page.getByTestId('search-input')).toHaveValue(/is:unread/);
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
});
