/**
 * Regenerate committed README / docs screenshots from Playwright mocks only.
 * Desktop: 1440×900 @2x. Mobile: 390×844 @2x. Viewport shots (not fullPage).
 *
 *   npm run docs:screenshots
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login, messages, MOCK_USER } from './fixtures';

const DOCS = 'docs/screenshots';
const ASSET1 = 'docs/assets/outlook-slice1';
const ASSET2 = 'docs/assets/outlook-slice2';
const ASSET3 = 'docs/assets/outlook-slice3';
for (const d of [DOCS, ASSET1, ASSET2, ASSET3]) mkdirSync(d, { recursive: true });

const baseSettings = {
    aiFeatures: false,
    density: 'comfortable',
    listFilter: 'all',
    inboxTab: 'focused',
    readingPaneLayout: 'right',
    groupThreads: true,
    useCustomLlm: false,
    llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
};

function seedSettings(extra: Record<string, unknown> = {}) {
    return JSON.stringify({ ...baseSettings, ...extra });
}

async function settleForScreenshot(page: Page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
}

async function shot(page: Page, path: string) {
    await settleForScreenshot(page);
    await page.screenshot({ path, fullPage: false });
}

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test.describe('docs desktop (1440×900 @2x)', () => {
    test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

    test('inbox, message, compose, settings, context menu, gmail skin', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await expect(page.getByTestId('inbox-tabs')).toBeVisible();
        await page.getByTestId('msg-row-1001').click();
        await expect(page.getByTestId('detail-subject')).toContainText('Welcome');
        await shot(page, `${DOCS}/outlook-inbox.png`);

        await page.click('[data-testid=settings-btn]');
        await page.click('[data-testid=settings-tab-appearance]');
        await page.click('[data-testid=skin-gmail]');
        await page.click('[data-testid=settings-done]');
        await page.getByTestId('msg-row-1018').click();
        await shot(page, `${DOCS}/gmail-inbox.png`);

        await page.click('[data-testid=settings-btn]');
        await expect(page.getByTestId('settings-modal')).toBeVisible();
        await shot(page, `${DOCS}/settings-groups.png`);
        await page.click('[data-testid=settings-done]');

        await page.locator('.row').first().click({ button: 'right' });
        await expect(page.getByTestId('msg-ctx')).toBeVisible();
        await shot(page, `${DOCS}/message-context-menu.png`);
        await page.keyboard.press('Escape');

        await page.click('[data-testid=compose-btn]');
        await expect(page.getByTestId('compose-modal')).toBeVisible();
        await page.fill('[data-testid=compose-to]', 'recipient@example.com');
        await page.fill('[data-testid=compose-subject]', 'Project update');
        await shot(page, `${DOCS}/desktop-compose.png`);
        await page.click('[data-testid=compose-modal-close]');
    });

    test('message reading dark', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'dark');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.getByTestId('msg-row-1016').click();
        await expect(page.getByTestId('detail-subject')).toBeVisible();
        await shot(page, `${DOCS}/desktop-message-dark.png`);
    });

    test('link safety prompt', async ({ page }) => {
        const linkHtml =
            '<p>Hello</p><p><a href="https://billing.acme-secure.test/invoice/8891">Download your invoice</a></p>';
        await page.route('**/v1/link-check/config', (route) =>
            route.fulfill({ json: { configured: true } })
        );
        await page.route('**/v1/link-check*', (route) => {
            const q = new URL(route.request().url()).searchParams.get('url') || '';
            route.fulfill({ json: { url: q, verdict: 'harmless', harmless: 70, malicious: 0, suspicious: 0, undetected: 0, timeout: 0 } });
        });
        await page.route('**/v1/mailboxes/INBOX/messages/1001', (route) =>
            route.fulfill({
                json: {
                    uid: 1001, seq: 1, flags: [], size: 1234,
                    internalDate: '2026-04-29T10:32:00Z',
                    envelope: messages[0].envelope,
                    text: 'Hello', html: linkHtml, attachments: []
                }
            })
        );
        await page.addInitScript(() => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', JSON.stringify({
                aiFeatures: true,
                linkSafetyCheck: true,
                density: 'comfortable',
                listFilter: 'all',
                useCustomLlm: false,
                llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
            }));
        });
        await login(page);
        await page.getByTestId('msg-row-1001').click();
        await expect(page.locator('iframe.html-frame')).toBeVisible();
        await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();
        await expect(page.getByTestId('linkcheck-dialog')).toBeVisible();
        await shot(page, `${DOCS}/link-safety-prompt.png`);
    });

    test('AI panel docked beside reading pane', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('webmail.theme', 'dark');
            localStorage.setItem('webmail.settings.v1', JSON.stringify({
                aiFeatures: true,
                density: 'comfortable',
                listFilter: 'all',
                readingPaneLayout: 'right',
                useCustomLlm: false,
                llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
            }));
        });
        await login(page);
        await page.getByTestId('msg-row-1001').click();
        await page.getByTestId('ai-menu-btn').click();
        await page.getByTestId('ai-tools-btn').click();
        await expect(page.getByTestId('ai-panel')).toBeVisible();
        await shot(page, `${DOCS}/desktop-ai-panel.png`);
    });

    test('Focused and Other tabs', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'dark');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.getByTestId('msg-row-1001').click();
        await shot(page, `${ASSET1}/26-inbox-focused-tab.png`);
        await page.getByTestId('inbox-tab-other').click();
        await page.getByTestId('msg-row-1000').click();
        await shot(page, `${ASSET1}/27-inbox-other-tab.png`);
    });

    test('conversation stack', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'dark');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings({ groupThreads: true }));
        await login(page);
        await page.getByTestId('msg-row-999').click();
        await expect(page.getByTestId('conversation-stack')).toBeVisible();
        await shot(page, `${ASSET2}/28-conversation-stack-collapsed.png`);
        await page.getByTestId('conversation-expand-997').click();
        await shot(page, `${ASSET2}/29-conversation-stack-expanded.png`);
    });

    test('reading pane bottom and hidden', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'dark');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.getByTestId('reading-pane-layout-bottom').click();
        await page.getByTestId('msg-row-1001').click();
        await shot(page, `${ASSET3}/30-reading-pane-bottom.png`);

        await page.keyboard.press('Escape');
        await page.getByTestId('reading-pane-layout-hidden').click();
        await page.getByTestId('msg-row-1018').click({ force: true });
        await expect(page.getByTestId('reading-pane-flyout')).toBeVisible();
        await shot(page, `${ASSET3}/31-reading-pane-hidden-flyout.png`);
    });
});

test.describe('docs mobile (390×844 @2x)', () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

    test('mobile inbox', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
        await shot(page, `${DOCS}/mobile-inbox.png`);
    });
});
