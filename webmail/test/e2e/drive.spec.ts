import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';
import { mkdirSync } from 'node:fs';

const SCREEN_DIR = 'test/screenshots';
mkdirSync(SCREEN_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('drive tab is visible and clickable', async ({ page }) => {
    await login(page);
    const driveBtn = page.getByTestId('app-switch-drive');
    await expect(driveBtn).toBeVisible();
    await driveBtn.click();
    await expect(page.getByTestId('drive-app')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/20-drive-grid.png`, fullPage: true });
});

test('lists folders and files in grid view', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-drive').click();
    await expect(page.getByTestId('drive-grid')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('drive-item-Projects')).toBeVisible();
    await expect(page.getByTestId('drive-item-Photos')).toBeVisible();
    await expect(page.getByTestId('drive-item-report.pdf')).toBeVisible();
    await expect(page.getByTestId('drive-item-notes.txt')).toBeVisible();
});

test('navigate into folder and back', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-drive').click();
    await expect(page.getByTestId('drive-item-Projects')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('drive-item-Projects').click();
    await expect(page.getByTestId('drive-item-plan.md')).toBeVisible();
    // Breadcrumb shows Projects
    await expect(page.getByText('Projects')).toBeVisible();
});

test('toggle list view', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-drive').click();
    await expect(page.getByTestId('drive-grid')).toBeVisible({ timeout: 10_000 });
    await page.getByTitle('List view').click();
    await expect(page.getByTestId('drive-list')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/21-drive-list.png`, fullPage: true });
});

test('select and delete file', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-drive').click();
    await expect(page.getByTestId('drive-item-report.pdf')).toBeVisible({ timeout: 10_000 });
    const item = page.getByTestId('drive-item-report.pdf');
    await item.locator('input[type="checkbox"]').click();
    await expect(page.getByText(/selected/)).toBeVisible();
    await page.getByRole('button', { name: /Delete/i }).click();
    // Wait for the selection bar to disappear (deleteSelected clears it).
    await expect(page.getByText(/selected/)).not.toBeVisible();
});

test('upload file via drag and drop', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-drive').click();
    await expect(page.getByTestId('drive-app')).toBeVisible();
    // Create a DataTransfer with a mock file
    const dataTransfer = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        const file = new File(['hello world'], 'drag-test-upload.txt', { type: 'text/plain' });
        dt.items.add(file);
        return dt;
    });
    // Use dragenter (counter-based tracking) so the overlay stays stable
    await page.dispatchEvent('body', 'dragenter', { dataTransfer });
    await expect(page.getByTestId('drive-upload-zone')).toBeVisible();
    await page.dispatchEvent('body', 'drop', { dataTransfer });
    await expect(page.getByTestId('drive-upload-zone')).not.toBeVisible();
    // Upload tray should show the file and eventually complete
    await expect(page.locator('.upload-tray')).toContainText('drag-test-upload.txt', { timeout: 5000 });
    await expect(page.locator('.upload-tray')).toContainText('Done', { timeout: 5000 });
});

test('create new folder', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-drive').click();
    await expect(page.getByTestId('drive-app')).toBeVisible();
    await page.getByRole('button', { name: /New/i }).click();
    await page.locator('[placeholder="Folder name"]').fill('NewFolder');
    await page.locator('[placeholder="Folder name"] + button').click();
    // The mock S3 always returns the same list, so we just verify the success toast.
    await expect(page.getByText(/Folder .* created/)).toBeVisible();
});

test('quota gauge is visible', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-drive').click();
    await expect(page.getByTestId('drive-app')).toBeVisible();
    // The quota component shows "121.1 KB / 5.0 GB" from the mock
    await expect(page.getByText(/KB.*GB/)).toBeVisible();
});
