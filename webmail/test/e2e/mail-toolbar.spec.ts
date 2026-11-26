import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => {
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            readingPaneLayout: 'right',
            listFilter: 'all',
            density: 'comfortable'
        }));
    });
});

test('default mail toolbar keeps every core filter visible without horizontal scrolling', async ({ page }) => {
    await login(page);
    const filters = page.getByTestId('filter-chips');
    await expect(filters).toBeVisible();

    const geometry = await filters.evaluate((el) => ({
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        right: el.getBoundingClientRect().right,
        attachmentsRight: el.querySelector('[data-testid="filter-attachments"]')?.getBoundingClientRect().right ?? 0
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.attachmentsRight).toBeLessThanOrEqual(geometry.right);

    await expect(page.getByTestId('filter-attachments')).toBeVisible();
    await expect(page.getByTestId('select-all-btn')).toHaveAttribute('aria-label', /Select all \d+ visible messages/);
    await page.screenshot({ path: 'test/screenshots/mail-toolbar.png', fullPage: true });
});

test('reading-pane shortcuts are compact icons with accessible names', async ({ page }) => {
    await login(page);

    for (const [id, name] of [
        ['right', 'Show on the right'],
        ['bottom', 'Show on the bottom'],
        ['hidden', 'Hide']
    ] as const) {
        const button = page.getByTestId(`reading-pane-layout-${id}`);
        await expect(button).toHaveAttribute('aria-label', name);
        await expect(button.locator('svg')).toBeVisible();
        const box = await button.boundingBox();
        expect(box?.width).toBeLessThanOrEqual(30);
    }

    await page.getByTestId('reading-pane-layout-right').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('mail-content')).toHaveAttribute('data-reading-pane-layout', 'bottom');
    await expect(page.getByTestId('reading-pane-layout-bottom')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('mail-content')).toHaveAttribute('data-reading-pane-layout', 'hidden');
});
