import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

async function seedRules(page: { evaluate: (fn: () => Promise<unknown>) => Promise<unknown> }) {
    await page.evaluate(async () => {
        await fetch('/v1/me/mail-rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Sweep: Trash mail from newsletters@bulk.example',
                condition: { type: 'from-contains', value: 'newsletters@bulk.example' },
                action: { type: 'fileinto', folder: 'Trash' }
            })
        });
        await fetch('/v1/me/mail-rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Forward press releases',
                condition: { type: 'from-contains', value: 'press.example' },
                action: { type: 'redirect', to: 'team@elsewhere.example' }
            })
        });
    });
}

test.describe('Outlook mail rules management (slice 57)', () => {
    test('Settings rules filter shows Sweep badge and hides other rules', async ({ page }) => {
        await login(page);
        await seedRules(page);
        await page.click('[data-testid=settings-btn]');
        await page.click('[data-testid=settings-tab-mail-rules]');
        await page.locator('[data-testid=mail-rules-block]').scrollIntoViewIfNeeded();
        await expect(page.getByTestId('mail-rules-filter')).toBeVisible();
        await expect(page.getByTestId('rule-item-r1')).toBeVisible();
        await expect(page.getByTestId('rule-item-r2')).toBeVisible();

        await page.getByTestId('mail-rules-filter-sweep').click();
        await expect(page.getByTestId('rule-list')).toContainText('Sweep:');
        await expect(page.getByTestId('rule-sweep-badge')).toBeVisible();
        await expect(page.locator('[data-testid^=rule-item-]')).toHaveCount(1);

        await page.getByTestId('mail-rules-filter-other').click();
        await expect(page.locator('[data-testid^=rule-item-]')).toHaveCount(1);
        await expect(page.getByTestId('rule-list')).toContainText('press releases');
        await expect(page.getByTestId('rule-sweep-badge')).toHaveCount(0);
    });

    test('Sweep filter empty state when only manual rules exist', async ({ page }) => {
        await login(page);
        await page.evaluate(async () => {
            await fetch('/v1/me/mail-rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Block cold outreach',
                    condition: { type: 'from-contains', value: 'spam.example' },
                    action: { type: 'discard' }
                })
            });
        });
        await page.click('[data-testid=settings-btn]');
        await page.click('[data-testid=settings-tab-mail-rules]');
        await page.getByTestId('mail-rules-filter-sweep').click();
        await expect(page.getByTestId('mail-rules-filter-empty')).toContainText(/No Sweep automation/i);
    });
});
