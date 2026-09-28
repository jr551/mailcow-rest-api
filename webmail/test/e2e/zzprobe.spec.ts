import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test('probe: calendar/people sections render nothing', async ({ page }) => {
    await applyMocks(page);
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await expect(page.getByTestId('settings-modal')).toBeVisible();

    for (const q of ['ticker', 'vip', 'caldav', 'birthday']) {
        await page.fill('[data-testid=settings-search]', q);
        const n = await page.locator('[data-testid^=settings-tab-]').count();
        console.log(`query "${q}" -> ${n} rail entries`);
    }

    await page.fill('[data-testid=settings-search]', '');
    await page.click('[data-testid=settings-tab-calendar]');
    const panelHtml = await page.locator('.panel').innerHTML();
    console.log('CALENDAR panel innerHTML length:', panelHtml.trim().length);
    console.log('CALENDAR panel:', JSON.stringify(panelHtml.slice(0, 200)));

    await page.click('[data-testid=settings-tab-people]');
    const panelHtml2 = await page.locator('.panel').innerHTML();
    console.log('PEOPLE panel innerHTML length:', panelHtml2.trim().length);
    console.log('placeholder notes:', await page.locator('.rail-cat-note').count());
});

test('probe: search with no hits leaves stale pane', async ({ page }) => {
    await applyMocks(page);
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-privacy]');
    const before = await page.locator('.panel > section').getAttribute('data-testid');
    await page.fill('[data-testid=settings-search]', 'zzzzz');
    const railCount = await page.locator('[data-testid^=settings-tab-]').count();
    const after = await page.locator('.panel > section').getAttribute('data-testid');
    console.log(`no-hit search: rail=${railCount} pane before=${before} after=${after}`);
});
