import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER } from './fixtures';

const SCREEN_DIR = 'test/screenshots';

test.describe('mobile drive', () => {
    test.beforeEach(async ({ page }) => {
        await applyMocks(page);
        await page.setViewportSize({ width: 390, height: 844 });
    });

    async function mobileLogin(page: any) {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await page.waitForSelector('.inbox-view');
    }

    test('drive tab is visible and clickable', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();
        await page.screenshot({ path: `${SCREEN_DIR}/mobile-drive-list.png`, fullPage: false });
    });

    test('lists root contents with folders and files', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();

        // Should show Projects and Photos folders + report.pdf and notes.txt
        await expect(page.getByTestId('mobile-drive-item-Projects')).toBeVisible();
        await expect(page.getByTestId('mobile-drive-item-Photos')).toBeVisible();
        await expect(page.getByTestId('mobile-drive-item-report.pdf')).toBeVisible();
        await expect(page.getByTestId('mobile-drive-item-notes.txt')).toBeVisible();
    });

    test('navigates into a folder and back', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();

        // Click Projects folder
        await page.getByTestId('mobile-drive-item-Projects').click();
        await expect(page.getByTestId('mobile-drive-item-plan.md')).toBeVisible();

        // Go back via breadcrumbs
        await page.locator('.breadcrumbs button:has-text("Drive")').click();
        await expect(page.getByTestId('mobile-drive-item-Projects')).toBeVisible();
    });

    test('creates a folder via FAB', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();

        const folder = `Mobile-${Date.now()}`;
        await page.getByTestId('mobile-drive-new-folder').click({ force: true });
        await page.locator('[placeholder="Folder name"]').fill(folder);
        await page.locator('[placeholder="Folder name"] ~ button').click();

        // The folder should appear in the list
        await expect(page.getByTestId(`mobile-drive-item-${folder}`)).toBeVisible({ timeout: 5_000 });
    });

    test('uploads a file via drag-and-drop', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();

        const fileName = `mobile-upload-${Date.now()}.txt`;
        const dataTransfer = await page.evaluateHandle((name) => {
            const dt = new DataTransfer();
            const file = new File([`Mobile upload at ${new Date().toISOString()}`], name, { type: 'text/plain' });
            dt.items.add(file);
            return dt;
        }, fileName);

        await page.dispatchEvent('body', 'dragenter', { dataTransfer });
        await expect(page.getByTestId('drive-upload-zone')).toBeVisible();
        await page.dispatchEvent('body', 'drop', { dataTransfer });
        await expect(page.getByTestId('drive-upload-zone')).not.toBeVisible();

        // Mobile doesn't have an upload tray; verify the drop completed and zone is gone
        await expect(page.getByTestId('drive-upload-zone')).not.toBeVisible();
    });

    test('selects and deletes an item via context menu', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();

        // Right-click (contextmenu) on a file to select it
        const item = page.getByTestId('mobile-drive-item-report.pdf');
        await expect(item).toBeVisible();
        await item.dispatchEvent('contextmenu');

        // Selection bar should appear
        await expect(page.locator('.selection-bar').filter({ hasText: /selected/ })).toBeVisible();

        // Delete via trash button in selection bar (force because FABs may overlap)
        await page.locator('.selection-bar .delete-btn').click({ force: true });
        await expect(page.locator('.selection-bar')).not.toBeVisible();

        // Item should be gone
        await expect(page.getByTestId('mobile-drive-item-report.pdf')).not.toBeVisible();
    });

    test('opens a file preview', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();

        // Click a non-folder file
        await page.getByTestId('mobile-drive-item-report.pdf').click();

        // Preview modal should appear
        await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 });
        await page.screenshot({ path: `${SCREEN_DIR}/mobile-drive-preview.png`, fullPage: false });
        // Close preview so it doesn't block subsequent interactions
        await page.keyboard.press('Escape');
        await expect(page.locator('[role="dialog"]')).not.toBeVisible();
    });

    test('shows empty state in a new folder', async ({ page }) => {
        await mobileLogin(page);
        await page.getByRole('button', { name: 'Drive', exact: true }).click();
        await expect(page.getByTestId('mobile-drive-view')).toBeVisible();

        // Navigate into Photos folder (mock returns empty)
        await page.getByTestId('mobile-drive-item-Photos').click();
        await expect(page.getByText('This folder is empty')).toBeVisible();
    });
});
