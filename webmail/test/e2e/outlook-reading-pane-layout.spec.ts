import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice3';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('bottom reading pane stacks list above message body', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            readingPaneLayout: 'bottom',
            phishingScan: false
        }));
    });
    await login(page);
    await expect(page.getByTestId('mail-content')).toHaveAttribute('data-reading-pane-layout', 'bottom');
    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('detail-body')).toBeVisible();
    await expect(page.getByTestId('reading-pane-flyout')).toHaveCount(0);

    await page.screenshot({ path: `${SCREEN_DIR}/30-reading-pane-bottom.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/30-reading-pane-bottom.png`, fullPage: true });
});

test('hidden reading pane opens slide-over flyout on select', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            readingPaneLayout: 'hidden',
            phishingScan: false
        }));
    });
    await login(page);
    await expect(page.getByTestId('mail-content')).toHaveAttribute('data-reading-pane-layout', 'hidden');
    await expect(page.getByTestId('pane-resizer')).toHaveCount(0);
    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('reading-pane-flyout')).toBeVisible();
    await expect(page.getByTestId('detail-body')).toBeVisible();

    await page.screenshot({ path: `${SCREEN_DIR}/31-reading-pane-hidden-flyout.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/31-reading-pane-hidden-flyout.png`, fullPage: true });

    await page.getByTestId('reading-pane-flyout-close').click();
    await expect(page.getByTestId('reading-pane-flyout')).toHaveCount(0);
});

test('quick layout control and Alt+Shift keyboard chords persist layout', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            readingPaneLayout: 'right',
            phishingScan: false
        }));
    });
    await login(page);
    await page.getByTestId('reading-pane-layout-bottom').click();
    await expect(page.getByTestId('mail-content')).toHaveAttribute('data-reading-pane-layout', 'bottom');

    await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            altKey: true, shiftKey: true, key: 'H', bubbles: true, cancelable: true
        }));
    });
    await expect(page.getByTestId('mail-content')).toHaveAttribute('data-reading-pane-layout', 'hidden');

    await page.evaluate(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            altKey: true, shiftKey: true, key: 'R', bubbles: true, cancelable: true
        }));
    });
    await expect(page.getByTestId('mail-content')).toHaveAttribute('data-reading-pane-layout', 'right');
});
