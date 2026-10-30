import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const SAMPLE_UID = 1001;

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook quick steps (slice 11)', () => {
    test('quick steps menu appears when a message is selected', async ({ page }) => {
        await login(page);
        await expect(page.getByTestId('quick-steps-trigger')).toHaveCount(0);
        await page.getByTestId(`msg-row-check-${SAMPLE_UID}`).click();
        await expect(page.getByTestId('quick-steps-trigger')).toBeVisible();
        await page.getByTestId('quick-steps-trigger').click();
        await expect(page.getByTestId('quick-step-done')).toBeVisible();
        await expect(page.getByTestId('quick-step-read-flag')).toContainText('flag');
    });

    test('Done archives the selected message', async ({ page }) => {
        await login(page);
        await page.getByTestId(`msg-row-check-${SAMPLE_UID}`).click();
        await page.getByTestId('quick-steps-trigger').click();
        await page.getByTestId('quick-step-done').click();
        await expect(page.getByTestId(`msg-row-${SAMPLE_UID}`)).toHaveCount(0);
        await expect(page.getByText('Done applied to 1 message')).toBeVisible();
    });

    test('Mark read & flag keeps the row and sets the flag control', async ({ page }) => {
        await login(page);
        await page.getByTestId(`msg-row-check-${SAMPLE_UID}`).click();
        await page.getByTestId('quick-steps-trigger').click();
        await page.getByTestId('quick-step-read-flag').click();
        await expect(page.getByTestId(`msg-row-${SAMPLE_UID}`)).toBeVisible();
        await expect(page.getByTestId(`msg-row-${SAMPLE_UID}`).locator('.star-on')).toBeVisible();
    });
});
