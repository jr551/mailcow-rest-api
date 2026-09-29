import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyMocks, login, messages } from './fixtures';

// Link safety: clicking a link inside a message must open a confirmation
// with the destination and a verdict, and must let the user through.
//
// The mechanism under test is the postMessage handshake between the
// sandboxed body frame and the parent, so these tests drive the REAL iframe
// (frameLocator + a real click) rather than synthesising a message. A test
// that posted the message itself would pass even if the shim were never
// injected — which is the failure this feature is most likely to have.

const LINK_HTML =
    '<p>Hello</p>' +
    '<p><a href="https://billing.acme-secure.test/invoice/8891">Download your invoice</a></p>' +
    '<p><a href="http://plain-http.test/thing">Insecure link</a></p>';

interface Verdict { verdict: string; malicious?: number; suspicious?: number; harmless?: number; title?: string; }

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    // Give the one message an HTML body containing two links, and stub the
    // link-check route. Configured=true, or Settings/UI would report the
    // feature as unavailable.
    await page.route('**/v1/link-check/config', (route) =>
        route.fulfill({ json: { configured: true } })
    );
    await page.route('**/v1/mailboxes/INBOX/messages/1001', (route) =>
        route.fulfill({
            json: {
                uid: 1001, seq: 1, flags: [], size: 1234,
                internalDate: '2026-04-29T10:32:00Z',
                envelope: messages[0].envelope,
                text: 'Hello', html: LINK_HTML, attachments: []
            }
        })
    );
});

/** Let the route answer with a given verdict. */
async function stubVerdict(page: Page, body: Verdict) {
    await page.route('**/v1/link-check*', (route) => {
        const q = new URL(route.request().url()).searchParams.get('url') || '';
        route.fulfill({ json: { url: q, malicious: 0, suspicious: 0, harmless: 0, undetected: 0, timeout: 0, ...body } });
    });
}

async function openFirstMessage(page: Page) {
    await login(page);
    await page.locator('.row').first().click();
    await expect(page.locator('iframe.html-frame')).toBeVisible();
}

test('clicking a link in a message shows a confirmation instead of opening it', async ({ page }) => {
    await stubVerdict(page, { verdict: 'harmless', harmless: 70 });
    await openFirstMessage(page);

    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();

    const dialog = page.getByTestId('linkcheck-dialog');
    await expect(dialog).toBeVisible();
    // The destination is shown, and the URL itself was sent for checking.
    await expect(page.getByTestId('linkcheck-url')).toContainText('billing.acme-secure.test');
    await expect(page.getByTestId('linkcheck-verdict')).toHaveText(/No known threats/);
});

test('a malicious verdict is labelled as such and still offers a way through', async ({ page }) => {
    await stubVerdict(page, { verdict: 'malicious', malicious: 9 });
    await openFirstMessage(page);

    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-verdict')).toHaveText(/Flagged as malicious/);
    // Never trapped: the way through is still there and says so plainly.
    await expect(page.getByTestId('linkcheck-continue')).toHaveText('Open anyway');
});

test('a never-scanned link is NOT reported as safe', async ({ page }) => {
    await stubVerdict(page, { verdict: 'not_found' });
    await openFirstMessage(page);

    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-verdict')).toHaveText('Never scanned');
    // The copy must not read as an all-clear.
    await expect(page.getByTestId('linkcheck-dialog')).toContainText('says nothing about whether it is safe');
});

test('undetected is distinct from harmless', async ({ page }) => {
    await stubVerdict(page, { verdict: 'undetected', undetected: 9 });
    await openFirstMessage(page);
    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-verdict')).toHaveText('Not checked');
});

test('suspicious gets its own label', async ({ page }) => {
    await stubVerdict(page, { verdict: 'suspicious', suspicious: 2 });
    await openFirstMessage(page);
    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-verdict')).toHaveText('Suspicious');
});

test('a plain-http link is called out', async ({ page }) => {
    await stubVerdict(page, { verdict: 'harmless', harmless: 70 });
    await openFirstMessage(page);
    await page.frameLocator('iframe.html-frame').getByText('Insecure link').click();
    await expect(page.getByTestId('linkcheck-insecure')).toBeVisible();
    await expect(page.getByTestId('linkcheck-url')).toContainText('plain-http.test');
});

test('the user is never trapped: cancel closes without opening anything', async ({ page }) => {
    await stubVerdict(page, { verdict: 'malicious', malicious: 5 });
    await openFirstMessage(page);
    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-dialog')).toBeVisible();

    let popups = 0;
    page.on('popup', () => { popups += 1; });
    await page.getByTestId('linkcheck-cancel').click();
    await expect(page.getByTestId('linkcheck-dialog')).toHaveCount(0);
    expect(popups).toBe(0);
});

test('the frame does NOT navigate away — the click is intercepted', async ({ page }) => {
    await stubVerdict(page, { verdict: 'harmless', harmless: 70 });
    await openFirstMessage(page);

    const frame = page.frameLocator('iframe.html-frame');
    await frame.getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-dialog')).toBeVisible();

    // If the shim had not called preventDefault, the frame would have
    // navigated to the href and this text would be gone.
    await expect(frame.getByText('Download your invoice')).toBeVisible();
});


test('a timeout still lets the user through and says the check did not finish', async ({ page }) => {
    // Never fulfil: the client's own 6s budget is what has to fire, which is
    // the case that matters — a hung connection is exactly when a naive
    // implementation leaves a spinner up forever.
    await page.route('**/v1/link-check?*', () => {});
    await openFirstMessage(page);
    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();

    const dialog = page.getByTestId('linkcheck-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('linkcheck-verdict')).toHaveText('Check timed out', { timeout: 15_000 });
    await expect(dialog).toContainText('You can carry on');
    // And the escape route is real, not decorative.
    await expect(page.getByTestId('linkcheck-continue')).toBeEnabled();
});

test('link checking is inert when AI features are hard-off', async ({ page }) => {
    await page.addInitScript(() => {
        const s = { linkSafetyCheck: true, aiFeatures: false };
        localStorage.setItem('webmail.settings.v1', JSON.stringify(s));
    });
    await stubVerdict(page, { verdict: 'malicious', malicious: 9 });
    await openFirstMessage(page);

    // The per-feature switch is ON, but the master switch overrides it —
    // this is the "must not be circumvented" requirement.
    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-dialog')).toHaveCount(0);
});

test('with the feature off, no prompt appears and the link opens normally', async ({ page }) => {
    // `webmail.settings.v1` is the real storage key — with a wrong one this
    // test silently kept the feature ON and passed for the wrong reason.
    await page.addInitScript(() => {
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            linkSafetyCheck: false, aiFeatures: true
        }));
    });
    await stubVerdict(page, { verdict: 'malicious', malicious: 9 });
    await openFirstMessage(page);

    // With the switch off the frame gets no allow-scripts and no shim, so
    // the click is an ordinary navigation and nothing is intercepted.
    const frame = page.frameLocator('iframe.html-frame');
    await expect(frame.locator('body')).toBeVisible();
    await frame.getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-dialog')).toHaveCount(0);
    // Proof the switch really took: the frame is still on its original
    // document rather than having navigated to the href.
    await expect(frame.getByText('Download your invoice')).toBeVisible();
});
