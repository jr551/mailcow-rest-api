import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

// The tldraw pad is a React tree mounted inside a Svelte dialog; the tldraw
// chunk is lazily imported on open. This guards the major-version bump
// (tldraw 4 → 5) mounting path end to end: React root creation, editor
// instantiation, and the Save path's export machinery.

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('drive: create drawing mounts the tldraw editor', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-drive').click();
    await expect(page.getByTestId('drive-grid')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.locator('#drive-new-drawing-name').fill('smoke-test');
    await page.getByRole('button', { name: 'Create drawing' }).click();

    // Pad dialog opens; the lazy tldraw chunk must actually render a
    // working editor (canvas + UI chrome), not just the mount div.
    await expect(page.getByTestId('tldraw-pad')).toBeVisible({ timeout: 30_000 });
    const mount = page.getByTestId('tldraw-mount');
    await expect(mount.locator('.tl-container')).toBeVisible({ timeout: 30_000 });
    await expect(mount.locator('canvas')).toBeVisible({ timeout: 30_000 });

    // Once loaded, Save becomes enabled — proves editorRef is a live editor.
    // Once loaded, Save becomes enabled — proves editorRef is a live editor.
    await expect(page.getByTestId('tldraw-save')).toBeEnabled({ timeout: 30_000 });

    // Save drives editor.getSnapshot() → .tldr blob → signed PUT to object
    // storage. Intercept the PUT so we prove the snapshot serialized under
    // tldraw 5's store format.
    const putPromise = page.waitForRequest(
        (req) => req.method() === 'PUT' && req.url().includes('s3.mock.local') && req.url().includes('.tldr')
    );
    await page.route('**/s3.mock.local/**', (route) =>
        route.fulfill({ status: 200, body: '' })
    );
    await page.getByTestId('tldraw-save').click();
    await putPromise;

    // Pad closes and the success toast lands.
    await expect(page.getByTestId('tldraw-pad')).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Saved "smoke-test\.tldr"/)).toBeVisible();
});
