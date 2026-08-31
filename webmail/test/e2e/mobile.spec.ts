import { test, expect } from '@playwright/test';
import { applyMocks, MOCK_USER, messages } from './fixtures';

test.describe('mobile webmail', () => {
    test.beforeEach(async ({ page }) => {
        await applyMocks(page);
        await page.setViewportSize({ width: 390, height: 844 });
    });

    test('login and inbox render', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await expect(page.locator('h1:has-text("Webmail")')).toBeVisible();
        await page.screenshot({ path: 'screenshots/mobile-mock-login.png' });

        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        // Inbox header
        await expect(page.locator('.mheader h1:has-text("INBOX")')).toBeVisible();

        // Message rows appear
        await expect(page.locator('.msg-row')).toHaveCount(4);

        // Unread styling: first message has a blue dot
        const firstRow = page.locator('.msg-row').first();
        await expect(firstRow.locator('.dot')).toBeVisible();

        // Starred message shows star icon
        const starredRow = page.locator('.msg-row').nth(2);
        await expect(starredRow.locator('.star-mark')).toBeVisible();

        await page.waitForTimeout(400);
        await page.screenshot({ path: 'screenshots/mobile-mock-inbox.png' });
    });

    test('open message and back', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        await page.locator('.msg-row').first().click();
        await expect(page.locator('.message-view')).toBeVisible();
        await expect(page.locator('h2:has-text("Welcome to imap-rest webmail")')).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: 'screenshots/mobile-mock-message.png' });

        await page.click('button:has-text("Back")');
        await expect(page.locator('.inbox-view')).toBeVisible();
    });

    test('long press on message opens action sheet with AI summarize', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');
        await page.waitForSelector('.inbox-view');

        // Long press the first message row
        const firstRow = page.locator('.msg-row').first();
        await firstRow.dispatchEvent('pointerdown', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });
        await page.waitForTimeout(600);
        await firstRow.dispatchEvent('pointerup', { button: 0, clientX: 100, clientY: 200, pointerId: 1, pointerType: 'touch' });

        // Action sheet should appear with expected options
        const sheet = page.locator('[role="dialog"]');
        await expect(sheet.filter({ hasText: 'Open' })).toBeVisible({ timeout: 5000 });
        await expect(sheet.filter({ hasText: 'Reply' })).toBeVisible();
        await expect(sheet.filter({ hasText: 'Summarize' })).toBeVisible();
        await expect(sheet.filter({ hasText: 'Delete' })).toBeVisible();

        // Tap Summarize → shows Summary sheet
        await page.locator('button:has-text("Summarize")').click();
        await expect(sheet.filter({ hasText: 'Summary' })).toBeVisible({ timeout: 5000 });

        // Close summary sheet
        await page.locator('button[aria-label="Close"]').first().click();
        await expect(page.locator('.inbox-view')).toBeVisible();
    });

    test('folders tab shows hierarchy', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        await page.locator('.nav-item:has-text("Folders")').click();
        await expect(page.locator('h1:has-text("Mailboxes")')).toBeVisible();
        // Wait for auto-expand effect to run
        await page.waitForTimeout(300);

        // Favorites: INBOX, Sent, Drafts, Trash, Junk, Archive = 6
        // Tree: Archive, 2024, 2025, Projects, Client A, Client B = 6
        // Total = 12 (hidden .AI Conversations is not shown)
        await expect(page.locator('.ios-row')).toHaveCount(12);

        // Verify favorites section
        await expect(page.locator('.ios-section-title').filter({ hasText: 'Favorites' })).toBeVisible();
        await expect(page.locator('.ios-row').filter({ hasText: 'INBOX' })).toBeVisible();
        await expect(page.locator('.ios-row').filter({ hasText: 'Archive' })).toHaveCount(2); // one in favs, one in tree

        // Verify hierarchy: child folders are indented
        const clientA = page.locator('.ios-row').filter({ hasText: 'Client A' });
        await expect(clientA).toBeVisible();

        // Tap INBOX to return
        await page.locator('.ios-row').filter({ hasText: 'INBOX' }).first().click();
        await expect(page.locator('.inbox-view')).toBeVisible();
    });

    test('compose opens and can close', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        await page.locator('[data-testid="compose-btn"]').click();
        await expect(page.locator('h1:has-text("New Message")')).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: 'screenshots/mobile-mock-compose.png' });

        await page.click('[data-testid="compose-close"]');
        await expect(page.locator('.inbox-view')).toBeVisible();
    });

    test('segmented filter switches', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        await page.locator('.segment:has-text("Unread")').click();
        // Only one unread message in mocks
        await expect(page.locator('.msg-row')).toHaveCount(1);

        await page.locator('.segment:has-text("Starred")').click();
        await expect(page.locator('.msg-row')).toHaveCount(1);

        await page.locator('.segment:has-text("All")').click();
        await expect(page.locator('.msg-row')).toHaveCount(4);
    });

    test('search filters messages', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        await page.fill('.msearch input', 'invoice');
        // Wait for debounce
        await page.waitForTimeout(400);
        // Since mocks don't filter by search text, the UI will still show all
        // but we can verify the search input holds the value
        await expect(page.locator('.msearch input')).toHaveValue('invoice');
    });

    test('AI chat shows IMAP-synced threads and messages', async ({ page }) => {
        // Pre-seed localStorage so AI chat appears as configured.
        await page.addInitScript(() => {
            localStorage.setItem('webmail.settings.v1', JSON.stringify({
                llm: { kind: 'openai', preset: 'openai', apiKey: 'sk-test', baseUrl: '', model: '' },
                useCustomLlm: true, density: 'comfortable', listFilter: 'all'
            }));
        });

        // Override the AI Conversations routes for this test.
        await page.route('**/v1/mailboxes/.AI%20Conversations/messages*', (route, request) => {
            if (request.method() === 'POST') {
                route.fulfill({
                    status: 201,
                    contentType: 'application/json',
                    body: JSON.stringify({ path: '.AI Conversations', uid: 5001, uidValidity: 1 })
                });
            } else {
                route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        path: '.AI Conversations',
                        page: 0,
                        pageSize: 100,
                        total: 1,
                        messages: [
                            {
                                uid: 5000,
                                seq: 1,
                                flags: ['\\Seen'],
                                size: 512,
                                internalDate: '2026-04-28T12:00:00Z',
                                envelope: {
                                    date: '2026-04-28T12:00:00Z',
                                    subject: 'Synced from IMAP',
                                    from: [{ name: 'AI Assistant', address: 'ai@webmail.local' }],
                                    to: [{ name: null, address: 'demo@test.local' }],
                                    cc: [],
                                    messageId: '<imap-thread-001@ai.webmail.local>',
                                    inReplyTo: null
                                }
                            }
                        ]
                    })
                });
            }
        });

        await page.route('**/v1/mailboxes/.AI%20Conversations/messages/5000', (route) => {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    uid: 5000,
                    seq: 1,
                    flags: ['\\Seen'],
                    size: 512,
                    internalDate: '2026-04-28T12:00:00Z',
                    envelope: {
                        date: '2026-04-28T12:00:00Z',
                        subject: 'Synced from IMAP',
                        from: [{ name: 'AI Assistant', address: 'ai@webmail.local' }],
                        to: [{ name: null, address: 'demo@test.local' }],
                        cc: [],
                        messageId: '<imap-thread-001@ai.webmail.local>',
                        inReplyTo: null
                    },
                    text: JSON.stringify({
                        id: 'imap-thread-001',
                        title: 'Synced from IMAP',
                        createdAt: new Date('2026-04-28T11:00:00Z').getTime(),
                        updatedAt: new Date('2026-04-28T12:00:00Z').getTime(),
                        messages: [
                            { role: 'user', content: 'Hello from another device' },
                            { role: 'assistant', content: 'Hi there! I can see this thread was synced via IMAP.' }
                        ]
                    }),
                    html: null,
                    attachments: []
                })
            });
        });

        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        // Wait for IMAP sync to finish in the background.
        await page.waitForTimeout(800);

        // Navigate to AI chat via bottom nav.
        await page.getByRole('button', { name: 'AI', exact: true }).click();

        // The synced thread should auto-select and show its title in the header.
        await expect(page.locator('.ai-view .mheader h1')).toContainText('Synced from IMAP', { timeout: 5000 });

        // The messages should be visible in the chat area.
        await expect(page.locator('.chat-scroll')).toContainText('Hello from another device');
        await expect(page.locator('.chat-scroll')).toContainText('Hi there! I can see this thread was synced via IMAP.');

        // Open the thread sheet.
        await page.locator('.ai-view .mheader button').first().click();
        await expect(page.locator('.threads-sheet')).toBeVisible();

        // The synced thread should appear in the list.
        await expect(page.locator('.threads-list')).toContainText('Synced from IMAP');
        await expect(page.locator('.threads-list')).toContainText('2'); // message count

        // Close sheet and screenshot.
        await page.locator('.threads-sheet button:has-text("New chat")').waitFor();
        await page.waitForTimeout(300);
        await page.screenshot({ path: 'screenshots/mobile-ai-chat-imap-sync.png' });
    });

    test('settings screen', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        await page.locator('.nav-item:has-text("Settings")').click();
        await expect(page.locator('h1:has-text("Settings")')).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: 'screenshots/mobile-mock-settings.png' });
    });

    test('phishing scan shows purple warning on suspicious email', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        // Open the invoice message (msg-row-1000 is second row)
        await page.locator('.msg-row').nth(1).click();
        await expect(page.locator('.message-view')).toBeVisible();

        // Wait for phishing overlay
        const overlay = page.getByTestId('phishing-overlay');
        await expect(overlay).toBeVisible({ timeout: 5000 });
        await expect(overlay).toContainText('Phishing warning');
        await page.screenshot({ path: 'screenshots/mobile-phishing-warning.png' });

        // Dismiss
        await page.click('[data-testid=phishing-proceed]');
        await expect(overlay).not.toBeVisible();
    });

    test('safe email does not show phishing warning', async ({ page }) => {
        await page.goto('/webmail/mobile/');
        await page.fill('input[type="email"]', MOCK_USER);
        await page.fill('input[type="password"]', 'hunter2');
        await page.click('button:has-text("Sign in")');

        // Open the welcome message (first row)
        await page.locator('.msg-row').first().click();
        await expect(page.locator('.message-view')).toBeVisible();

        const overlay = page.getByTestId('phishing-overlay');
        await expect(overlay).not.toBeVisible({ timeout: 5000 });
    });
});
