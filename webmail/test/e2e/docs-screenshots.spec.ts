/**
 * Regenerate committed README / docs screenshots from Playwright mocks only.
 * Writes to webmail/docs/screenshots/ (tracked) — not test/screenshots/ (gitignored).
 *
 *   npm run docs:screenshots
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { applyMocks, login, messages, MOCK_USER } from './fixtures';

const DOCS = 'docs/screenshots';
mkdirSync(DOCS, { recursive: true });

const baseSettings = {
    aiFeatures: false,
    density: 'comfortable',
    listFilter: 'all',
    inboxTab: 'focused',
    readingPaneLayout: 'right',
    useCustomLlm: false,
    llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
};

function seedSettings(extra: Record<string, unknown> = {}) {
    return JSON.stringify({ ...baseSettings, ...extra });
}

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

async function openContextMenu(page: Page) {
    await page.locator('.row').first().click({ button: 'right' });
    await expect(page.getByTestId('msg-ctx')).toBeVisible();
}

test('refresh core README screenshots (mock API only)', async ({ page }) => {
    // --- Outlook inbox (light, Focused tab, reading pane right) ---
    await page.addInitScript((blob) => {
        localStorage.setItem('webmail.theme', 'light');
        localStorage.setItem('webmail.settings.v1', blob);
    }, seedSettings());
    await login(page);
    await expect(page.getByTestId('inbox-tabs')).toBeVisible();
    await expect(page.getByTestId('msg-list')).toBeVisible();
    await page.screenshot({ path: `${DOCS}/outlook-inbox.png`, fullPage: true });

    // --- Gmail skin inbox ---
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-appearance]');
    await page.click('[data-testid=skin-gmail]');
    await page.click('[data-testid=settings-done]');
    await page.screenshot({ path: `${DOCS}/gmail-inbox.png`, fullPage: true });

    // --- Settings rail (grouped sections) ---
    await page.click('[data-testid=settings-btn]');
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await expect(page.locator('.settings-rail')).toBeVisible();
    await page.screenshot({ path: `${DOCS}/settings-groups.png`, fullPage: true });
    await page.click('[data-testid=settings-done]');

    // --- Message context menu ---
    await openContextMenu(page);
    await page.screenshot({ path: `${DOCS}/message-context-menu.png`, fullPage: true });
    await page.keyboard.press('Escape');

    // --- Compose ---
    await page.click('[data-testid=compose-btn]');
    await expect(page.getByTestId('compose-modal')).toBeVisible();
    await page.fill('[data-testid=compose-to]', 'recipient@example.com');
    await page.fill('[data-testid=compose-subject]', 'Project update');
    await page.screenshot({ path: `${DOCS}/desktop-compose.png`, fullPage: true });
    await page.click('[data-testid=compose-modal-close]');

    // --- Message reading (dark) ---
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await page.reload();
    await expect(page.getByTestId('msg-list')).toBeVisible();
    await page.click('[data-testid=msg-row-1001]');
    await expect(page.getByTestId('detail-subject')).toBeVisible();
    await page.screenshot({ path: `${DOCS}/desktop-message-dark.png`, fullPage: true });
});

test('link safety prompt screenshot (mock API only)', async ({ page }) => {
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
    await page.locator('.row').first().click();
    await expect(page.locator('iframe.html-frame')).toBeVisible();
    await page.frameLocator('iframe.html-frame').getByText('Download your invoice').click();
    await expect(page.getByTestId('linkcheck-dialog')).toBeVisible();
    await page.screenshot({ path: `${DOCS}/link-safety-prompt.png`, fullPage: true });
});

test('AI panel screenshot when features are enabled (mock API only)', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: true,
            density: 'comfortable',
            listFilter: 'all',
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    await page.getByTestId('ai-menu-btn').click();
    await page.getByTestId('ai-tools-btn').click();
    await expect(page.getByTestId('ai-panel')).toBeVisible();
    await page.screenshot({ path: `${DOCS}/desktop-ai-panel.png`, fullPage: true });
});

test('refresh mobile inbox screenshot (mock API only)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((blob) => {
        localStorage.setItem('webmail.settings.v1', blob);
    }, seedSettings());
    await page.goto('/webmail/mobile/');
    await page.fill('input[type="email"]', MOCK_USER);
    await page.fill('input[type="password"]', 'hunter2');
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${DOCS}/mobile-inbox.png`, fullPage: false });
});
