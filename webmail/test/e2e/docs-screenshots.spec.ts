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
const ASSET5 = 'docs/assets/outlook-slice5';
const ASSET6 = 'docs/assets/outlook-slice6';
const ASSET7 = 'docs/assets/outlook-slice7';
const ASSET8 = 'docs/assets/outlook-slice8';
const ASSET9 = 'docs/assets/outlook-slice9';
const ASSET10 = 'docs/assets/outlook-slice10';
const ASSET11 = 'docs/assets/outlook-slice11';
const ASSET12 = 'docs/assets/outlook-slice12';
const ASSET13 = 'docs/assets/outlook-slice13';
const ASSET14 = 'docs/assets/outlook-slice14';
const ASSET15 = 'docs/assets/outlook-slice15';
const ASSET16 = 'docs/assets/outlook-slice16';
const ASSET17 = 'docs/assets/outlook-slice17';
const ASSET18 = 'docs/assets/outlook-slice18';
const ASSET19 = 'docs/assets/outlook-slice19';
const ASSET20 = 'docs/assets/outlook-slice20';
const ASSET22 = 'docs/assets/outlook-slice22';
const ASSET24 = 'docs/assets/outlook-slice24';
for (const d of [DOCS, ASSET1, ASSET2, ASSET3, ASSET5, ASSET6, ASSET7, ASSET8, ASSET9, ASSET10, ASSET11, ASSET12, ASSET13, ASSET14, ASSET15, ASSET16, ASSET17, ASSET18, ASSET19, ASSET20, ASSET22, ASSET24]) mkdirSync(d, { recursive: true });

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

    test('natural-language search hint', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings({ aiFeatures: true, naturalLanguageSearch: true }));
        await login(page);
        await page.getByTestId('search-input').fill('invoices from acme billing');
        await expect(page.getByTestId('search-nl-hint')).toContainText('from:billing@acme.example', { timeout: 8000 });
        await shot(page, `${ASSET5}/34-nl-search-hint.png`);
    });

    test('quick filter bar menu', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'dark');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.getByTestId('quick-filter-trigger').click();
        await expect(page.getByTestId('quick-filter-menu')).toBeVisible();
        await shot(page, `${ASSET6}/35-quick-filter-menu-open.png`);
    });

    test('message category stripe', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        const row = page.getByTestId('msg-row-1001');
        await row.click({ button: 'right' });
        await page.getByTestId('ctx-category-trigger').hover();
        await page.getByTestId('ctx-category-item-orange').click();
        await expect(page.getByTestId('msg-category-1001')).toBeVisible();
        await shot(page, `${ASSET7}/36-message-category-stripe.png`);
    });

    test('keyboard shortcuts help', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.keyboard.press('Shift+?');
        await expect(page.getByTestId('mail-shortcut-help')).toBeVisible();
        await shot(page, `${ASSET8}/37-keyboard-shortcuts-help.png`);
    });

    test('pinned message row', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.getByTestId('msg-pin-1018').click({ force: true });
        await expect(page.getByTestId('msg-row-1018')).toHaveAttribute('data-pinned', 'true');
        await page.getByTestId('msg-row-1018').hover();
        await shot(page, `${ASSET9}/38-pinned-message-row.png`);
    });

    test('sender sweep context submenu', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.getByTestId('msg-row-1017').click({ button: 'right' });
        await page.getByTestId('ctx-sweep-trigger').hover();
        await expect(page.getByTestId('ctx-sweep-item-keep-latest')).toBeVisible();
        await shot(page, `${ASSET10}/39-sender-sweep-menu.png`);
    });

    test('quick steps menu with selection', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.getByTestId('msg-row-check-1001').click();
        await page.getByTestId('quick-steps-trigger').click();
        await expect(page.getByTestId('quick-step-done')).toBeVisible();
        await shot(page, `${ASSET11}/40-quick-steps-menu.png`);
    });

    test('undo send toast', async ({ page }) => {
        await page.route(/\/health$/, (route) => {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ok: true,
                    cache: 0,
                    pool: 0,
                    capabilities: { ai: true, ocr: true, smtp: true, drive: true }
                })
            });
        });
        await page.route('**/imap-rest/health', (route) => {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ok: true,
                    cache: 0,
                    pool: 0,
                    capabilities: { ai: true, ocr: true, smtp: true, drive: true }
                })
            });
        });
        await page.route('**/v1/messages/send', (route) => {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ messageId: '<docs-shot@local>' })
            });
        });
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings({ undoSendSeconds: 10, aiFeatures: false, preSendCheck: false }));
        await login(page);
        await page.reload();
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid=compose-btn]');
        await page.fill('[data-testid=compose-to]', 'friend@example.com');
        await page.fill('[data-testid=compose-subject]', 'Slice 12 undo send');
        await page.getByTestId('compose-send').click();
        await expect(page.getByTestId('send-undo-btn')).toBeVisible();
        await shot(page, `${ASSET12}/41-undo-send-toast.png`);
    });

    test('schedule send dialog', async ({ page }) => {
        await page.route(/\/health$/, (route) => {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ok: true,
                    cache: 0,
                    pool: 0,
                    capabilities: { ai: true, ocr: true, smtp: true, drive: true }
                })
            });
        });
        await page.route('**/imap-rest/health', (route) => {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ok: true,
                    cache: 0,
                    pool: 0,
                    capabilities: { ai: true, ocr: true, smtp: true, drive: true }
                })
            });
        });
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings({ undoSendSeconds: 0, aiFeatures: false, preSendCheck: false }));
        await login(page);
        await page.reload();
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid=compose-btn]');
        await page.fill('[data-testid=compose-to]', 'friend@example.com');
        await page.fill('[data-testid=compose-subject]', 'Slice 13 schedule send');
        await page.getByTestId('compose-send-menu-btn').click();
        await page.getByTestId('compose-schedule-send').click();
        await expect(page.getByTestId('schedule-send-dialog')).toBeVisible();
        await page.getByTestId('schedule-preset-tomorrow-morning').click();
        await shot(page, `${ASSET13}/42-schedule-send-dialog.png`);
    });

    test('save draft compose chrome', async ({ page }) => {
        await page.route('**/v1/mailboxes/Drafts/messages**', (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ path: 'Drafts', uid: 9001, uidValidity: 1 })
            });
        });
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings({ undoSendSeconds: 0, aiFeatures: false, preSendCheck: false }));
        await login(page);
        await page.reload();
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid=compose-btn]');
        await page.fill('[data-testid=compose-to]', 'draft@example.com');
        await page.fill('[data-testid=compose-subject]', 'Slice 14 save draft');
        await page.locator('[data-testid=rich-editor-surface]').click();
        await page.keyboard.type('Draft body for screenshot.');
        await expect(page.getByTestId('compose-save-draft')).toBeVisible();
        await shot(page, `${ASSET14}/43-save-draft-compose.png`);
    });

    test('slice16 mail deep link reading pane', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.goto('/webmail/#mail?folder=INBOX&uid=1001');
        await page.waitForSelector('[data-testid=shell]');
        await expect(page.getByTestId('detail-subject')).toBeVisible();
        await expect(page.getByTestId('copy-message-link-btn')).toBeVisible();
        await shot(page, `${ASSET16}/45-mail-deep-link.png`);
    });

    test('slice17 skip link focused', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        await page.getByTestId('mail-skip-link').focus();
        await expect(page.getByTestId('mail-skip-link')).toBeFocused();
        await shot(page, `${ASSET17}/46-skip-link-focused.png`);
    });

    test('slice18 follow-up flag row label', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings());
        await login(page);
        const row = page.getByTestId('msg-row-1001');
        await row.click({ button: 'right' });
        await page.getByTestId('ctx-follow-up-trigger').hover();
        await page.getByTestId('ctx-follow-up-item-today').click();
        await expect(page.getByTestId('msg-follow-up-1001')).toBeVisible();
        await shot(page, `${ASSET18}/47-follow-up-today-row.png`);
    });
});

test.describe('docs outlook slice 15 (compose pop-out)', () => {
    test('compose pop-out window', async ({ page, context }) => {
        await page.goto('/webmail/');
        await login(page);
        await page.waitForSelector('[data-testid=shell]');
        await page.click('[data-testid=compose-btn]');
        await page.fill('[data-testid=compose-to]', 'popout-shot@example.com');
        await page.fill('[data-testid=compose-subject]', 'Slice 15 compose pop-out');
        const popupPromise = context.waitForEvent('page');
        await page.getByTestId('compose-modal-pop-out').click();
        const popup = await popupPromise;
        await popup.waitForLoadState('networkidle');
        await expect(popup.getByTestId('compose-popout-shell')).toBeVisible();
        await shot(popup, `${ASSET15}/44-compose-pop-out.png`);
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

    test('slice19 mobile focused tab', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings({ inboxTab: 'focused' }));
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await expect(page.getByTestId('inbox-tab-focused')).toHaveClass(/active/);
        await expect(page.getByTestId('msg-row-1000')).not.toBeVisible();
        await shot(page, `${ASSET19}/48-mobile-inbox-focused-tab.png`);
    });

    test('slice20 mobile conversation stack', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings({ groupThreads: true }));
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await page.getByTestId('msg-row-999').click();
        await expect(page.getByTestId('conversation-stack')).toBeVisible();
        await expect(page.getByTestId('conversation-msg-999')).toHaveAttribute('data-expanded', 'true');
        await shot(page, `${ASSET20}/50-mobile-conversation-stack.png`);
    });

    test('slice22 mobile dark theme settings', async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await page.getByRole('button', { name: 'Settings' }).click();
        await page.getByTestId('mobile-theme-dark').click();
        await expect(page.getByTestId('mobile-theme-dark')).toHaveClass(/active/);
        await shot(page, `${ASSET22}/52-mobile-settings-dark-theme.png`);
    });
});

test.describe('docs tablet mobile (834×1194 @2x)', () => {
    test.use({ viewport: { width: 834, height: 1194 }, deviceScaleFactor: 2 });

    test('slice24 tablet split reading pane', async ({ page }) => {
        await page.addInitScript((blob) => {
            localStorage.setItem('webmail.theme', 'light');
            localStorage.setItem('webmail.settings.v1', blob);
        }, seedSettings({ readingPaneLayout: 'right' }));
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await expect(page.getByTestId('tablet-mail-split')).toBeVisible();
        await page.getByTestId('msg-row-1001').click();
        await expect(page.locator('.message-view.embedded')).toBeVisible();
        await shot(page, `${ASSET24}/54-tablet-split-reading-pane.png`);
    });
});
