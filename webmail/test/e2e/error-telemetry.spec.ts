import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test('error telemetry is opt-in and sends a redacted, query-free report', async ({ page }) => {
    await applyMocks(page);
    // Force the fetch fallback so Playwright can inspect the payload; beacon
    // requests are intentionally fire-and-forget and may bypass route mocks.
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
    });
    const reports: Array<Record<string, unknown>> = [];
    await page.route('**/v1/telemetry/error', async (route) => {
        reports.push(JSON.parse(route.request().postData() || '{}'));
        await route.fulfill({ status: 204, body: '' });
    });

    await login(page);
    await page.evaluate(() => {
        const error = new Error('password: hunter2');
        window.onerror?.('password: hunter2', '/v1/test?search=private%20phrase', 1, 1, error);
    });
    expect(reports).toHaveLength(0);

    await page.getByTestId('settings-btn').click();
    await page.getByTestId('settings-tab-privacy').click();
    const toggle = page.getByTestId('settings-error-telemetry');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.keyboard.press('Escape');

    await page.evaluate(() => {
        const error = new Error('apiKey: sk-browser-secret');
        window.onerror?.('apiKey: sk-browser-secret', '/v1/public/ical/private-feed.ics?search=second%20phrase', 2, 1, error);
    });
    await expect.poll(() => reports.length).toBe(1);

    const report = reports[0];
    expect(report.url).toBe('/v1/public/ical/[redacted]');
    expect(report.page).toMatch(/\/webmail\/$/);
    expect(JSON.stringify(report)).not.toContain('private phrase');
    expect(JSON.stringify(report)).not.toContain('second phrase');
    expect(JSON.stringify(report)).not.toContain('private-feed.ics');
    expect(JSON.stringify(report)).not.toContain('hunter2');
    expect(JSON.stringify(report)).not.toContain('sk-browser-secret');

    // Network failures used to copy the full request target into `detail`,
    // bypassing the query-free URL field. Exercise the real search request.
    await page.route('**/v1/mailboxes/INBOX/messages?*', (route) => route.abort('failed'));
    await page.getByTestId('search-input').fill('private phrase');
    await page.getByTestId('search-input').press('Enter');
    await expect.poll(() => reports.some((report) => report.type === 'network')).toBe(true);
    const networkReport = reports.find((report) => report.type === 'network');
    expect(networkReport?.detail).toBe('GET /v1/mailboxes/INBOX/messages');
    expect(JSON.stringify(networkReport)).not.toContain('private phrase');
});
