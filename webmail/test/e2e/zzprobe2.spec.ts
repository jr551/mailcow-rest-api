import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test('probe2: rail placeholders + no-match state', async ({ page }) => {
    await applyMocks(page);
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.fill('[data-testid=settings-search]', '   ');
    console.log('whitespace-only query -> rail entries:', await page.locator('[data-testid^=settings-tab-]').count());
    console.log('rail-cat-note count:', await page.locator('.rail-cat-note').count());
    console.log('rail-cat-note text:', JSON.stringify(await page.locator('.rail-cat-note').allTextContents()));
    console.log('rail-cat headings:', JSON.stringify(await page.locator('.rail-cat').allTextContents()));

    await page.fill('[data-testid=settings-search]', 'nomatchxyz');
    console.log('no-match rail entries:', await page.locator('[data-testid^=settings-tab-]').count());
    console.log('rail text now:', JSON.stringify(await page.locator('.settings-rail').innerText()));
});

test('probe3: outbound webhook secret not surfaced', async ({ page }) => {
    await applyMocks(page);
    await page.route('**/v1/me/outbound-webhooks', async (route) => {
        if (route.request().method() === 'POST') {
            return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
                id: 'ow1', label: 'My agent', url: 'https://a.example/h', keep: true, prepend: '', secret: 'deadbeefcafe'
            })});
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ webhooks: [], limit: 10 }) });
    });
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.fill('[data-testid=settings-search]', 'outbound');
    await page.click('[data-testid=settings-tab-outbound-hooks]');
    await page.fill('[data-testid=ow-url]', 'https://a.example/h');
    await page.fill('[data-testid=ow-label]', 'My agent');
    await page.click('[data-testid=ow-create]');
    await page.waitForTimeout(500);
    const panel = await page.locator('.panel').innerText();
    console.log('PANEL AFTER CREATE:\n' + panel);
    console.log('secret visible?', panel.includes('deadbeef'));
    console.log('localStorage has secret?', await page.evaluate(() => (localStorage.getItem('webmail.settings.v1')||'').includes('deadbeef')));
});

test('probe4: stale webhook id after delete', async ({ page }) => {
    await applyMocks(page);
    let hooks: any[] = [{ id: 'owA', label: 'A', url: 'https://a.example/h', keep: true, prepend: '' },
                        { id: 'owB', label: 'B', url: 'https://b.example/h', keep: true, prepend: '' }];
    await page.route('**/v1/me/outbound-webhooks**', async (route) => {
        const m = route.request().method();
        const u = route.request().url();
        if (m === 'DELETE') {
            const id = u.split('/').pop();
            hooks = hooks.filter(h => h.id !== id);
            return route.fulfill({ status: 204, body: '' });
        }
        if (m === 'POST') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(hooks[0]||{}) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ webhooks: hooks, limit: 10 }) });
    });
    page.on('dialog', d => d.accept());
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.fill('[data-testid=settings-search]', 'outbound');
    await page.click('[data-testid=settings-tab-outbound-hooks]');
    await page.click('[data-testid=ow-remove-owA]');
    await page.waitForTimeout(400);
    console.log('hooks after delete:', JSON.stringify(hooks.map(h=>h.id)));

    await page.fill('[data-testid=settings-search]', '');
    await page.click('[data-testid=settings-tab-mail-rules]');
    await page.selectOption('[data-testid=rule-action-type]', 'webhook');
    const sel = page.getByTestId('rule-action-webhook');
    console.log('select value after deleting selected hook:', JSON.stringify(await sel.inputValue()));
    console.log('select visible text:', JSON.stringify(await sel.evaluate(e => (e as HTMLSelectElement).selectedOptions[0]?.textContent)));
});
