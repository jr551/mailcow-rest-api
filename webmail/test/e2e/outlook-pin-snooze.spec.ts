import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const PIN_UID = 1018;
const SNOOZE_UID = 1001;

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('Outlook pin and snooze (slice 9)', () => {
    test('pin keeps a message at the top after reload', async ({ page }) => {
        await login(page);
        const row = page.getByTestId(`msg-row-${PIN_UID}`);
        await expect(row).toHaveAttribute('data-pinned', 'false');
        await page.getByTestId(`msg-pin-${PIN_UID}`).click({ force: true });
        await expect(row).toHaveAttribute('data-pinned', 'true');

        const firstRow = page.locator('[data-testid^="msg-row-"]').first();
        await expect(firstRow).toHaveAttribute('data-testid', `msg-row-${PIN_UID}`);

        await page.reload();
        await expect(page.getByTestId(`msg-row-${PIN_UID}`)).toHaveAttribute('data-pinned', 'true');
    });

    test('snooze hides a message until the wake time passes', async ({ page }) => {
        await page.addInitScript(({ mailbox, uid, until }) => {
            const key = `${mailbox}\u0000${uid}`;
            localStorage.setItem(
                'webmail.message-pin-snooze.v1',
                JSON.stringify({ pinned: {}, snoozeUntil: { [key]: until } })
            );
        }, { mailbox: 'INBOX', uid: SNOOZE_UID, until: Date.now() + 86400000 });

        await login(page);
        await expect(page.getByTestId(`msg-row-${SNOOZE_UID}`)).toHaveCount(0);

        await page.addInitScript(({ mailbox, uid, until }) => {
            const key = `${mailbox}\u0000${uid}`;
            localStorage.setItem(
                'webmail.message-pin-snooze.v1',
                JSON.stringify({ pinned: {}, snoozeUntil: { [key]: until } })
            );
        }, { mailbox: 'INBOX', uid: SNOOZE_UID, until: Date.now() - 1000 });

        await page.reload();
        await expect(page.getByTestId(`msg-row-${SNOOZE_UID}`)).toBeVisible();
    });

    test('context menu snooze removes the row', async ({ page }) => {
        await login(page);
        const row = page.getByTestId(`msg-row-${SNOOZE_UID}`);
        await row.click({ button: 'right' });
        await page.getByTestId('ctx-snooze-trigger').hover();
        await page.getByTestId('ctx-snooze-item-later-today').click();
        await expect(row).toHaveCount(0);
    });
});
