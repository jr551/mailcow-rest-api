import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login } from './fixtures';

const SCREEN_DIR = 'test/screenshots';
const ASSET_DIR = 'docs/assets/outlook-slice2';
mkdirSync(SCREEN_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('reading pane stacks a grouped thread with older message collapsed', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            density: 'comfortable',
            listFilter: 'all',
            groupThreads: true,
            inboxTab: 'focused',
            phishingScan: false,
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });

    await login(page);
    // Sam's lunch thread (997 + 999) collapses to one row headed by uid 999.
    await page.getByTestId('msg-row-999').click();
    await expect(page.getByTestId('conversation-stack')).toBeVisible();
    await expect(page.getByTestId('conversation-msg-997')).toHaveAttribute('data-expanded', 'false');
    await expect(page.getByTestId('conversation-msg-999')).toHaveAttribute('data-expanded', 'true');
    await expect(page.getByTestId('conversation-body-999')).toContainText('noon at the usual place');

    await page.screenshot({ path: `${SCREEN_DIR}/28-conversation-stack-collapsed.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/28-conversation-stack-collapsed.png`, fullPage: true });

    await page.getByTestId('conversation-expand-997').click();
    await expect(page.getByTestId('conversation-msg-997')).toHaveAttribute('data-expanded', 'true');
    await expect(page.getByTestId('conversation-body-997')).toContainText('lunch on Friday');

    await page.screenshot({ path: `${SCREEN_DIR}/29-conversation-stack-expanded.png`, fullPage: true });
    await page.screenshot({ path: `${ASSET_DIR}/29-conversation-stack-expanded.png`, fullPage: true });
});

test('single messages do not show conversation stack', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: false,
            groupThreads: true,
            phishingScan: false
        }));
    });
    await login(page);
    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('detail-body')).toBeVisible();
    await expect(page.getByTestId('conversation-stack')).toHaveCount(0);
});
