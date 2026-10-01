import { test, expect, type Page } from '@playwright/test';
import { applyMocks, login, detailFor1000, detailFor1001 } from './fixtures';

// The desktop scam badge has three states, and the middle one is the subtle
// one: a verdict that did NOT cross the user's confidence floor but came
// close enough that a reassuring green tick would be a lie.
//
// These tests exist because the mocked scan fixture used to return 87/12
// while the server contract is 0.0–1.0 (src/routes/ai.js), so every mocked
// scan clamped to 1.0 and a clean email rendered as a "Near miss" — a state
// prod would never show for that message. Nothing asserted on the badges, so
// the suite stayed green while showing the wrong thing.

const SCAN_ROUTE = '**/v1/ai/phishing-scan';

/** The badge rail lives inside the HTML branch of the message view, and both
 *  message fixtures ship `html: null` — so the detail route is re-served with
 *  a body. Everything else about the fixture stays as-is. */
async function withHtmlBody(page: Page, uid: 1000 | 1001) {
    const detail = uid === 1001 ? detailFor1001 : detailFor1000;
    const route = `**/v1/mailboxes/INBOX/messages/${uid}`;
    await page.unroute(route);
    await page.route(route, (r) => {
        r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ...detail, html: '<p>Body text</p>' })
        });
    });
}

async function scanWith(page: Page, body: Record<string, unknown>) {
    await page.unroute(SCAN_ROUTE);
    await page.route(SCAN_ROUTE, (route) => {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
}

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('a clean verdict reads as scanned, not as a near miss', async ({ page }) => {
    await withHtmlBody(page, 1001);
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    const badge = page.getByTestId('scam-scanned-badge');
    await expect(badge).toHaveText('Scam-scanned', { timeout: 10_000 });
    await expect(badge).not.toHaveClass(/hedged/);
});

test('a verdict close to the floor is a near miss, not a clean tick', async ({ page }) => {
    // 0.5 is under the 0.7 floor, so it is not flagged — but it is above
    // 0.6 × floor, so the clean tick is not earned either.
    await scanWith(page, {
        isPhishing: false,
        confidence: 0.5,
        reasoning: 'Borderline signals.',
        indicators: [],
        isSpam: false,
        spamConfidence: 0,
        spamReasoning: '',
        model: 'test'
    });
    await withHtmlBody(page, 1001);
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    const badge = page.getByTestId('scam-scanned-badge');
    await expect(badge).toHaveText('Near miss', { timeout: 10_000 });
    await expect(badge).toHaveClass(/hedged/);
});

test('a flagged verdict reads as phishing risk with the model’s confidence', async ({ page }) => {
    await withHtmlBody(page, 1000);
    await login(page);
    await page.click('[data-testid=msg-row-1000]');
    const badge = page.getByTestId('scam-scanned-badge');
    await expect(badge).toHaveText('Phishing risk', { timeout: 10_000 });
    await expect(badge).toHaveClass(/warn/);
    await expect(badge).toHaveAttribute('title', /87% confidence/);
});
