import { test, expect } from '@playwright/test';
import { applyMocks, login, MOCK_USER, MOCK_PASS, messages } from './fixtures';
import { mkdirSync } from 'node:fs';
import { addDays, addMonths, format } from 'date-fns';

const SCREEN_DIR = 'test/screenshots';
mkdirSync(SCREEN_DIR, { recursive: true });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('login screen renders (light)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await page.goto('/webmail/');
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await expect(page.getByText('Sign in to webmail')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/01-login-light.png`, fullPage: true });
});

test('login screen renders (dark)', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await page.goto('/webmail/');
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/02-login-dark.png`, fullPage: true });
});

test('shows error when API rejects credentials', async ({ page }) => {
    await page.unroute('**/v1/auth/session');
    await page.route('**/v1/auth/session', (route, request) => {
        if (request.method() === 'POST') {
            route.fulfill({
                status: 401,
                contentType: 'application/problem+json',
                body: JSON.stringify({ status: 401, title: 'Unauthorized', detail: 'Invalid credentials' })
            });
        } else {
            route.continue();
        }
    });
    await page.goto('/webmail/');
    await page.fill('[data-testid=login-user]', 'wrong@user');
    await page.fill('[data-testid=login-pass]', 'wrong');
    await page.click('[data-testid=login-submit]');
    await expect(page.getByTestId('login-error')).toBeVisible();
    await expect(page.getByTestId('login-error')).toContainText(/wrong|invalid/i);
    await page.screenshot({ path: `${SCREEN_DIR}/03-login-error.png` });
});

test('inbox lists messages and shows detail', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await expect(page.getByTestId('msg-list')).toBeVisible();
    await expect(page.getByText('Welcome to imap-rest webmail')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/04-inbox-dark.png`, fullPage: true });

    await page.click('[data-testid=msg-row-1001]');
    await expect(page.getByTestId('detail-subject')).toContainText('Welcome');
    await expect(page.getByText('The Concierge')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/05-message-dark.png`, fullPage: true });
});

test('inbox renders well in light theme', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await login(page);
    await expect(page.getByTestId('msg-list')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/04b-inbox-light.png`, fullPage: true });
    await page.click('[data-testid=msg-row-1001]');
    await expect(page.getByTestId('detail-subject')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/06-message-light.png`, fullPage: true });
});

test('empty detail pane shows hint with kbd glyphs', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await expect(page.getByText('Select a message to read')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/04c-empty-detail-dark.png`, fullPage: true });
});

test('message with attachments shows OCR action', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=msg-row-1000]');
    await expect(page.getByTestId('detail-subject')).toContainText('Q2 invoice');
    await expect(page.getByTestId('attachment-filename-2')).toContainText('invoice-q2-2026.pdf');
    await page.screenshot({ path: `${SCREEN_DIR}/05b-message-attachments.png`, fullPage: true });
});

test('phishing scan shows glassy purple warning on suspicious email', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=msg-row-1000]');
    await expect(page.getByTestId('detail-subject')).toContainText('Q2 invoice');

    // Wait for the phishing overlay to appear
    const overlay = page.getByTestId('phishing-overlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await expect(overlay).toContainText('Phishing warning');
    await expect(overlay).toContainText('Proceed anyway');
    await page.screenshot({ path: `${SCREEN_DIR}/05c-phishing-warning.png`, fullPage: true });

    // Dismiss the warning
    await page.click('[data-testid=phishing-proceed]');
    await expect(overlay).not.toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/05d-phishing-dismissed.png`, fullPage: true });
});

test('phishing scan clears on safe email', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    await expect(page.getByTestId('detail-subject')).toContainText('Welcome');

    // The scanning spinner may appear briefly, but should not show a warning
    const overlay = page.getByTestId('phishing-overlay');
    await expect(overlay).not.toBeVisible({ timeout: 5000 });
});

test('reply compose pre-fills To and Subject from open message', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    await page.click('[data-testid=reply-btn]');
    await expect(page.getByTestId('compose-modal')).toBeVisible();
    await expect(page.locator('[data-testid=compose-subject]')).toHaveValue(/^Re:/);
    // To pre-filled with the original sender's address.
    await expect(page.getByTestId('compose-to')).toHaveValue('concierge@example.com');
    await page.screenshot({ path: `${SCREEN_DIR}/07b-compose-reply.png`, fullPage: true });
});

test('Reply variants: Reply / Reply all / Forward each populate Compose correctly', async ({ page }) => {
    // Mock a message with cc + multiple to so reply-all has something
    // distinct from a plain reply.
    await page.route('**/v1/mailboxes/INBOX/messages/1001', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                uid: 1001, seq: 1, flags: [], size: 1500,
                internalDate: '2026-04-29T10:32:00Z',
                envelope: {
                    date: '2026-04-29T10:32:00Z',
                    subject: 'Q1 review',
                    from: [{ name: 'Concierge', address: 'concierge@example.com' }],
                    to: [
                        { name: null, address: 'demo@test.local' },
                        { name: 'Sam', address: 'sam@friend.example' }
                    ],
                    cc: [{ name: 'Marketing', address: 'marketing@example.com' }],
                    messageId: '<q1-review@imap-rest>',
                    inReplyTo: null
                },
                text: 'Hi all — quick recap of Q1.\nThanks.',
                html: null,
                attachments: []
            })
        });
    });
    await login(page);
    await page.click('[data-testid=msg-row-1001]');

    // 1. Reply — To is just the original sender; no CC.
    await page.click('[data-testid=reply-btn]');
    await expect(page.locator('[data-testid=compose-subject]')).toHaveValue(/^Re: /);
    await expect(page.getByTestId('compose-to')).toHaveValue('concierge@example.com');
    // Cc/Bcc field remains hidden until toggled.
    await expect(page.getByTestId('compose-show-ccbcc')).toBeVisible();
    // Close.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('compose-modal')).toHaveCount(0);

    // 2. Reply all — To is sender, Cc holds the other to + cc rows minus self.
    await page.click('[data-testid=msg-row-1001]');
    await page.click('[data-testid=reply-all-btn]');
    await expect(page.locator('[data-testid=compose-subject]')).toHaveValue(/^Re: /);
    await expect(page.getByTestId('compose-to')).toHaveValue('concierge@example.com');
    // Cc row is shown automatically with everyone except the active user.
    const ccVal = (await page.getByTestId('compose-cc').inputValue()).toLowerCase();
    expect(ccVal).toContain('sam@friend.example');
    expect(ccVal).toContain('marketing@example.com');
    expect(ccVal).not.toContain('demo@test.local');
    await page.keyboard.press('Escape');

    // 3. Forward — To is empty; subject prefixed Fwd:.
    await page.click('[data-testid=msg-row-1001]');
    await page.click('[data-testid=forward-btn]');
    await expect(page.locator('[data-testid=compose-subject]')).toHaveValue(/^Fwd: /);
    await expect(page.getByTestId('compose-to')).toHaveValue('');
});

test('Forward of HTML-only email quotes stripped HTML text, not blank', async ({ page }) => {
    const htmlOnlyMsg = {
        uid: 1002, seq: 2, flags: [], size: 2000,
        internalDate: '2026-03-27T22:20:00Z',
        envelope: {
            date: '2026-03-27T22:20:00Z',
            subject: 'Congratulations! You have earned a first Help to Save bonus',
            from: [{ name: 'GOV.UK', address: 'no-reply@help-to-save.hmrc.gov.uk' }],
            to: [{ name: null, address: 'demo@test.local' }],
            cc: [],
            messageId: '<html-only@example>',
            inReplyTo: null
        }
    };
    // Override the inbox list to include the HTML-only message.
    await page.route(/\/v1\/mailboxes\/INBOX\/messages(\?|$)/, (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                path: 'INBOX', page: 0, pageSize: 25, total: 5,
                messages: [...messages, htmlOnlyMsg]
            })
        });
    });
    // Mock the detail endpoint for the HTML-only message.
    await page.route('**/v1/mailboxes/INBOX/messages/1002', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ...htmlOnlyMsg,
                text: null,
                html: '<p>Dear saver,</p><p>You have earned a <strong>£500</strong> bonus.</p>',
                attachments: []
            })
        });
    });
    await login(page);
    await page.click('[data-testid=msg-row-1002]');
    await page.click('[data-testid=forward-btn]');

    // The rich-editor surface should contain the forwarded heading + the stripped HTML text.
    const surface = page.locator('[data-testid=rich-editor-surface]');
    await expect(surface).toBeVisible();
    const bodyHtml = await surface.evaluate((el: HTMLElement) => el.innerHTML || '');
    expect(bodyHtml).toContain('Forwarded message');
    expect(bodyHtml).toContain('Dear saver');
    expect(bodyHtml).toContain('£500');
});

test('compose modal: Send button is disabled when SMTP is not configured', async ({ page }) => {
    await login(page);
    await page.click('[data-testid=compose-btn]');
    await expect(page.getByTestId('compose-modal')).toBeVisible();
    await page.fill('[data-testid=compose-to]', 'a@b.test');
    await page.fill('[data-testid=compose-subject]', 'Hello');
    // Status line replaces the previous banner — present in the footer.
    await expect(page.getByTestId('compose-status')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/07-compose.png`, fullPage: true });

    // Send is disabled with a tooltip + label flips to "Save draft".
    const send = page.getByTestId('compose-send');
    await expect(send).toBeDisabled();
    await expect(send).toContainText(/Save draft/);
    const tooltip = await send.getAttribute('title');
    expect(tooltip).toMatch(/SMTP not configured|isn't enabled/i);
    await page.screenshot({ path: `${SCREEN_DIR}/08-compose-disabled.png`, fullPage: true });
});

test('AI panel summarizes and drafts a reply', async ({ page }) => {
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    await page.click('[data-testid=ai-btn]');
    await expect(page.getByTestId('ai-panel')).toBeVisible();

    await page.click('[data-testid=ai-summarize-btn]');
    await expect(page.getByTestId('ai-summary-out')).toBeVisible();
    await expect(page.getByTestId('ai-summary-out')).toContainText(/welcome/i);

    await page.click('[data-testid=ai-draft-btn]');
    await expect(page.getByTestId('ai-draft-out')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/09-ai-panel.png`, fullPage: true });
});

test('appearance control offers light/dark/auto and an accent palette', async ({ page }) => {
    await login(page);
    const html = page.locator('html');
    const toggle = page.getByTestId('theme-toggle');

    // Initial: whatever auto resolves to (likely light in headless)
    const initial = await html.getAttribute('data-theme');
    expect(['auto', 'light', 'dark']).toContain(initial);

    // The control is a popover now, not a cycle-on-click button. Both
    // capabilities have to survive that change, so both are exercised here.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(page.getByTestId('appearance-panel')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Mode: the segmented control writes data-theme and persists.
    await page.getByTestId('appearance-mode-dark').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('appearance-mode-light').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    const chosen = 'light';

    // Accent: picking a swatch retints the live accent var rather than
    // merely marking the chip selected.
    const accentOf = () =>
        html.evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim());
    const before = await accentOf();
    await page.getByTestId('accent-violet').click();
    const after = await accentOf();
    expect(after).not.toBe(before);

    // Escape closes and returns focus to the trigger, so a keyboard user is
    // not dropped somewhere unrelated with the panel still visually open.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('appearance-panel')).toBeHidden();
    await expect(toggle).toBeFocused();

    // Reload — both the mode and the accent survive.
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', chosen);
    const persisted = await accentOf();
    expect(persisted).toBe(after);
});

test('accent picks back to the skin default in one click', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await login(page);

    await page.getByTestId('theme-toggle').click();
    await page.getByTestId('accent-rose').click();
    await expect(page.getByTestId('appearance-accent-reset')).toBeEnabled();

    await page.getByTestId('appearance-accent-reset').click();
    // With no override the reset affordance reports the skin's own colour…
    await expect(page.getByTestId('appearance-accent-reset')).toContainText('Outlook default');
    // …and is inert, because there is nothing left to undo.
    await expect(page.getByTestId('appearance-accent-reset')).toBeDisabled();
});

test('search debounces and shows empty state', async ({ page }) => {
    await page.route(/\/v1\/mailboxes\/INBOX\/messages\?.*search=nothing/, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ path: 'INBOX', page: 0, pageSize: 25, total: 0, messages: [] })
        })
    );
    await login(page);
    await page.fill('[data-testid=search-input]', 'nothing');
    await expect(page.getByText('No matches found.')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/10-empty-state.png`, fullPage: true });
});

test('logout returns to login screen', async ({ page }) => {
    await login(page);
    // logout now lives inside the account dropdown
    await page.click('[data-testid=account-btn]');
    await page.click('[data-testid=logout-btn]');
    await expect(page.getByTestId('login-submit')).toBeVisible();
});

test('Settings opens, lets user pick a custom LLM provider', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await page.click('[data-testid=settings-tab-ai]');

    // Toggle "Use my own provider" and pick Ollama preset
    await page.check('[data-testid=settings-use-custom]');
    await page.selectOption('[data-testid=settings-preset]', 'ollama');
    await page.click('[data-testid=settings-ai-advanced]');
    await page.fill('[data-testid=settings-key]', 'sk-no-key');
    await page.screenshot({ path: `${SCREEN_DIR}/11-settings-dark.png`, fullPage: true });

    // Done closes the modal; settings persisted to localStorage.
    await page.click('[data-testid=settings-done]');
    await expect(page.getByTestId('settings-modal')).not.toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem('webmail.settings.v1'));
    expect(stored).toContain('ollama');
    expect(stored).toContain('sk-no-key');
});

test('Settings test-connection runs against configured provider', async ({ page }) => {
    // Test now calls the user's provider directly (same path as the chat
    // bot) when "Use my own" is on, bypassing /v1/ai/summarize. Mock the
    // provider's /chat/completions URL instead.
    await page.route('**/api.groq.com/openai/v1/chat/completions', (route) => {
        const auth = route.request().headers()['authorization'] || '';
        const ok = auth.includes('gsk_demo');
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                model: 'llama-3.1-70b-versatile',
                choices: [{ message: { role: 'assistant', content: ok ? 'ok' : 'wrong-key' } }]
            })
        });
    });
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-ai]');
    await page.check('[data-testid=settings-use-custom]');
    await page.selectOption('[data-testid=settings-preset]', 'groq');
    await page.click('[data-testid=settings-ai-advanced]');
    await page.fill('[data-testid=settings-key]', 'gsk_demo');
    await page.click('[data-testid=settings-test]');
    await expect(page.getByTestId('settings-test-result')).toContainText(/ok/);
});

test('AI button is replaced by "Set up AI" when no provider configured', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    // Override capabilities + health to indicate AI is NOT configured.
    await page.route('**/v1/ai/capabilities', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                configured: false, kind: 'openai', preset: '', model: '',
                allowClientOverride: true,
                presets: ['mistral', 'openai', 'anthropic']
            })
        })
    );
    await page.route(/\/health$/, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, capabilities: { ai: false, ocr: false, smtp: false } })
        })
    );
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    await expect(page.getByTestId('ai-setup-btn')).toBeVisible();
    await expect(page.getByTestId('ai-btn')).not.toBeVisible();
});

// These two need a real service worker — the suite-wide block would make
// them vacuous.
test.describe('service-worker tests', () => {
    test.use({ serviceWorkers: 'allow' });


test('PWA: manifest links + service worker register + offline fallback', async ({ page }) => {
    await page.goto('/webmail/');
    // Manifest is linked.
    const manifestHref = await page.getAttribute('link[rel=manifest]', 'href');
    expect(manifestHref).toBe('/webmail/manifest.webmanifest');
    // Manifest content is served and parses.
    const manifestRes = await page.request.get('/webmail/manifest.webmanifest');
    expect(manifestRes.ok()).toBeTruthy();
    const manifest = await manifestRes.json();
    expect(manifest.name).toMatch(/webmail/i);
    expect(manifest.icons.length).toBeGreaterThan(0);
    expect(manifest.scope).toBe('/webmail/');
    // Service worker file is reachable.
    const swRes = await page.request.get('/webmail/sw.js');
    expect(swRes.ok()).toBeTruthy();
    expect(await swRes.text()).toMatch(/addEventListener\(['"]push['"]/);
    // Once registered (browser-side), querying registrations shows ours.
    const registered = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        // Registration is async — poll rather than assume a fixed delay is enough.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const regs = await navigator.serviceWorker.getRegistrations();
            if (regs.length > 0 && regs.some((r) => (r.active || r.installing || r.waiting))) return true;
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 200);
            await promise;
        }
        return false;
    });
    expect(registered).toBeTruthy();
});

test('SW push event posts a webmail-new-mail message to the page', async ({ page }) => {
    // Simulates the SW dispatch by manually triggering the listener inline.
    // (We can't fire a real Push event in headless Playwright without a
    // platform push service.) The handler registered by Layout responds
    // by playing the chime + refreshing — we just verify the handler is
    // wired up.
    await login(page);
    const wired = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.ready;
        return !!reg && !!reg.active;
    });
    expect(wired).toBeTruthy();
});
});

test('Settings shows Install + Notification + Sounds controls', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    // Install + Notifications live under the Notifications tab now.
    await page.click('[data-testid=settings-tab-notifications]');
    await expect(page.getByTestId('settings-install')).toBeVisible();
    const onBtn = page.getByTestId('settings-notifications-on');
    const offBtn = page.getByTestId('settings-notifications-off');
    expect(await onBtn.count() + await offBtn.count()).toBeGreaterThan(0);
    // Sounds moved under the Sounds tab.
    await page.click('[data-testid=settings-tab-sounds]');
    await expect(page.getByTestId('settings-sound-toggle')).toBeVisible();
    await expect(page.getByTestId('settings-sound-preview')).toBeVisible();
    // Toggle sound off, then back on, and confirm localStorage tracks it.
    await page.click('[data-testid=settings-sound-toggle]');
    const muted1 = await page.evaluate(() => localStorage.getItem('webmail.sounds.muted'));
    expect(muted1).toBe('1');
    await page.click('[data-testid=settings-sound-toggle]');
    const muted2 = await page.evaluate(() => localStorage.getItem('webmail.sounds.muted'));
    expect(muted2).toBe('0');
    await page.screenshot({ path: `${SCREEN_DIR}/13-settings-with-pwa.png`, fullPage: true });
});

test('Login: Stay-signed-in checkbox is on by default and persists creds', async ({ page }) => {
    await page.goto('/webmail/');
    await expect(page.getByTestId('login-remember')).toBeChecked();
    await page.fill('[data-testid=login-user]', 'demo@test.local');
    await page.fill('[data-testid=login-pass]', 'hunter2');
    await page.click('[data-testid=login-submit]');
    await expect(page.getByTestId('shell')).toBeVisible();
    const vault = await page.evaluate(() => localStorage.getItem('webmail.creds.v1'));
    expect(vault).toBeTruthy();
    expect(vault).toContain('demo@test.local');
});

test('Settings: Forget device clears persisted creds', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    // login() helper signs in with no remember flag → vault should be empty.
    // Trigger remember by submitting the form again with the remember box.
    await page.evaluate(() => {
        // Manually plant a remembered creds entry to simulate prior login.
        const id = localStorage.getItem('webmail.install-id') || 'seed';
        localStorage.setItem('webmail.install-id', id);
        // Use the same XOR-base64 algorithm as keychain.ts
        const text = JSON.stringify({ user: 'demo@test.local', pass: 'hunter2', savedAt: Date.now() });
        const bytes = new TextEncoder().encode(text);
        const out = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ id.charCodeAt(i % id.length);
        let bin = '';
        for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
        localStorage.setItem('webmail.creds.v1', JSON.stringify([{ user: 'demo@test.local', payload: btoa(bin) }]));
    });
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-security]');
    const forgetBtn = page.getByTestId('settings-forget-device');
    await expect(forgetBtn).toBeVisible();
    await forgetBtn.click();
    await expect(page.getByTestId('toast')).toContainText(/Forgot credentials/);
    const vault = await page.evaluate(() => localStorage.getItem('webmail.creds.v1'));
    expect(vault).toBeFalsy();
});

test('Setup guide: opens with hostname + ports + client recipe tabs', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=account-btn]');
    await page.click('[data-testid=account-menu-setup]');
    const dlg = page.getByTestId('setup-modal');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText(/IMAP/);
    await expect(dlg).toContainText(/SMTP/);
    // Tab through clients
    await page.click('[data-testid=setup-tab-thunderbird]');
    await expect(page.getByTestId('setup-steps')).toContainText(/Account Settings/);
    await page.click('[data-testid=setup-tab-android]');
    await expect(page.getByTestId('setup-steps')).toContainText(/K-9/);
    await page.screenshot({ path: `${SCREEN_DIR}/22-setup-guide.png`, fullPage: true });
    await page.click('[data-testid=setup-done]');
    await expect(dlg).not.toBeVisible();
});

test('Compose: From combobox lists all send-from addresses', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=compose-btn]');
    await expect(page.getByTestId('compose-modal')).toBeVisible();
    // From is now an <input list="..."> combobox so the user can type
    // plus-addressed aliases as well as pick suggested ones.
    const fromInput = page.getByTestId('compose-from');
    await expect(fromInput).toBeVisible();
    const opts = await page.locator('#compose-from-options option').evaluateAll((els) =>
        els.map((el) => (el as HTMLOptionElement).value)
    );
    expect(opts).toContain('demo@test.local');
    expect(opts).toContain('demo+sales@test.local');
    expect(opts).toContain('press@test.local');
    await page.screenshot({ path: `${SCREEN_DIR}/19-compose-with-from.png`, fullPage: true });
});

test('MessageDetail: Block sender adds the sender to the blocklist', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    await page.click('[data-testid=move-btn]');
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('[data-testid=block-sender-btn]');
    await expect(page.getByTestId('toast')).toContainText(/Blocked/);
});

// v0.3.1 — recipient blocking via Sieve. The "to" header on the welcome
// message is the logged-in user, so we patch the detail to include a
// catch-all alias that should trigger the menu item.
test('MessageDetail: Block recipient surfaces only when To has a non-self alias', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await page.route('**/v1/mailboxes/INBOX/messages/1001', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                uid: 1001, seq: 1, flags: [], size: 1234,
                internalDate: '2026-04-29T10:32:00Z',
                envelope: {
                    date: '2026-04-29T10:32:00Z',
                    subject: 'Welcome via alias',
                    from: [{ name: 'Concierge', address: 'concierge@example.com' }],
                    to: [{ name: null, address: 'sales+catchall@test.local' }],
                    cc: [],
                    messageId: '<welcome-alias@imap-rest>',
                    inReplyTo: null
                },
                text: 'hi', html: null, attachments: []
            })
        });
    });
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    await page.click('[data-testid=move-btn]');
    await page.click('[data-testid=block-recipient-btn]');
    await expect(page.getByTestId('toast')).toContainText(/Blocked mail to sales\+catchall@test\.local/);
});

test('Settings: Block recipient adds an entry to the recipient blocklist', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-filters]');
    await page.fill('[data-testid=block-recipient-input]', 'leak@test.local');
    await page.click('[data-testid=block-recipient-add]');
    await expect(page.getByTestId('blocked-recipients-list')).toContainText('leak@test.local');
});

// v0.3.2 — unified mail rules. Cover the three action shapes: discard
// (no target), redirect (forward, requires target), copy (forward + keep).
test('Settings: Mail rules supports discard, redirect, and copy actions', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-mail-rules]');
    await page.locator('[data-testid=mail-rules-block]').scrollIntoViewIfNeeded();

    // Discard rule — no target field.
    await page.selectOption('[data-testid=rule-condition-type]', 'from-contains');
    await page.fill('[data-testid=rule-condition-value]', 'spam.example');
    await page.selectOption('[data-testid=rule-action-type]', 'discard');
    await expect(page.getByTestId('rule-action-to')).toHaveCount(0);
    await page.click('[data-testid=rule-add]');
    await expect(page.getByTestId('rule-list')).toContainText('spam.example');
    // Descriptive cards: discard rule shows the "Block" badge.
    await expect(page.getByTestId('rule-list')).toContainText(/Block|discard/i);

    // Redirect rule — target field appears + is required.
    await page.fill('[data-testid=rule-condition-value]', 'press');
    await page.selectOption('[data-testid=rule-action-type]', 'redirect');
    await expect(page.getByTestId('rule-action-to')).toBeVisible();
    await page.fill('[data-testid=rule-action-to]', 'team@elsewhere.example');
    await page.click('[data-testid=rule-add]');
    await expect(page.getByTestId('rule-list')).toContainText('press');
    await expect(page.getByTestId('rule-list')).toContainText(/Redirect/i);

    // Copy rule — forward + keep.
    await page.fill('[data-testid=rule-condition-value]', 'alerts');
    await page.selectOption('[data-testid=rule-action-type]', 'copy');
    await page.fill('[data-testid=rule-action-to]', 'audit@elsewhere.example');
    await page.click('[data-testid=rule-add]');
    await expect(page.getByTestId('rule-list')).toContainText('alerts');
    await expect(page.getByTestId('rule-list')).toContainText(/Copy/i);

    // Three rules now visible. Remove the first one.
    const items = page.locator('[data-testid^=rule-item-]');
    await expect(items).toHaveCount(3);
    await page.locator('[data-testid^=rule-remove-]').first().click();
    await expect(items).toHaveCount(2);
});

test('Settings: Mail rules header conditions reveal the header field', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-mail-rules]');
    await page.locator('[data-testid=mail-rules-block]').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('rule-condition-header')).toHaveCount(0);
    await page.selectOption('[data-testid=rule-condition-type]', 'header-contains');
    await expect(page.getByTestId('rule-condition-header')).toBeVisible();
});

// ChatBot bubble — talks directly to an OpenAI-compatible endpoint set in
// localStorage. The tool-call round-trip happens inside the browser; no
// imap-rest server endpoint is involved beyond the existing /v1/* tools.
test('ChatBot: bubble opens panel and shows config-needed when AI is unset', async ({ page }) => {
    // The suite fixture reports the server as AI-CONFIGURED, so the
    // config-needed state this test exists to assert is unreachable by
    // default: isChatConfigured() returns true off /v1/ai/config alone and
    // the panel renders fully wired. Unconfigured has to be set up here, by
    // answering both probes the way a server with no LLM key would.
    await page.route('**/v1/ai/config', (route) =>
        route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ status: 404, title: 'Not Found', detail: 'AI is not configured' })
        })
    );
    await page.route('**/v1/ai/capabilities', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                configured: false, kind: 'openai', preset: '', model: '',
                allowClientOverride: true,
                presets: ['mistral', 'openai', 'groq']
            })
        })
    );

    await login(page);
    await expect(page.getByTestId('chatbot-bubble')).toBeVisible();
    await page.getByTestId('chatbot-bubble').click();
    await expect(page.getByTestId('chatbot-panel')).toBeVisible();
    await expect(page.getByTestId('chatbot-panel')).toContainText('Configure provider');
    // Send button stays disabled with no input + no config.
    await expect(page.getByTestId('chatbot-input')).toBeDisabled();
});

// Calendar — REST-backed via /v1/me/calendars. fixtures.ts seeds an empty
// events list so the month grid is predictable on first load.
test('Calendar: app switcher flips to calendar surface', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('app-switch-calendar')).toBeVisible();
    await page.getByTestId('app-switch-calendar').click();
    await expect(page.getByTestId('cal-app')).toBeVisible();
    await expect(page.getByTestId('cal-month-view')).toBeVisible();
    await expect(page.getByTestId('mini-cal')).toBeVisible();
});

test('Calendar: create event flow POSTs to /v1/me/calendars and shows in month + schedule', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-calendar').click();
    await page.getByTestId('cal-create').click();
    await expect(page.getByTestId('cal-event-modal')).toBeVisible();

    await page.getByTestId('cal-evt-title').fill('Team standup');
    await page.getByTestId('cal-evt-location').fill('Conf Room B');
    await page.getByTestId('cal-evt-save').click();
    await expect(page.getByTestId('cal-event-modal')).toHaveCount(0);

    // The new event is in the month grid (use the title, not the date cell).
    await expect(page.getByTestId('cal-month-view')).toContainText('Team standup');

    // And in Schedule view.
    await page.getByTestId('cal-view-schedule').click();
    await expect(page.getByTestId('cal-schedule-view')).toContainText('Team standup');
    await expect(page.getByTestId('cal-schedule-view')).toContainText('Conf Room B');
});


test('Calendar: view-switcher key bindings (1=month, 2=schedule, t=today)', async ({ page }) => {
    await login(page);
    await page.getByTestId('app-switch-calendar').click();
    await expect(page.getByTestId('cal-month-view')).toBeVisible();

    // 2 → schedule.
    await page.keyboard.press('2');
    await expect(page.getByTestId('cal-schedule-view')).toBeVisible();

    // 1 → back to month. The old binding for this was 3, and 5 for
    // schedule, back when the switcher offered Day/Week/Year as well.
    // Those views were never implemented, so the tabs (and therefore the
    // shortcuts) were cut down to the two that render; CalendarApp.onKeydown
    // and the tab tooltips are the contract now.
    await page.keyboard.press('1');
    await expect(page.getByTestId('cal-month-view')).toBeVisible();

    // t → today. Navigate into a different month first, or resetting the
    // cursor to the same value it already holds would assert nothing.
    await page.getByTestId('cal-next').click();
    await expect(page.getByTestId('cal-period')).toContainText(
        format(addMonths(new Date(), 1), 'MMMM yyyy')
    );
    await page.keyboard.press('t');
    await expect(page.getByTestId('cal-period')).toContainText(format(new Date(), 'MMMM yyyy'));
});

test('Suggest event: AI extracts an event from an email and pops the modal pre-filled', async ({ page }) => {
    // The suggest button now opens a 5-card picker; the LLM call returns
    // an `options` array. We pick the first one and assert the modal
    // pre-fills from that card's title + location.
    //
    // Route the PROVIDER PROXY, not a provider of our own. The suite
    // fixture answers /v1/ai/config with a configured server, and every
    // resolveBaseUrl() in the app checks capabilities.aiConfig BEFORE
    // settings.llm — so a baseUrl planted in localStorage is dead, and the
    // call always goes to /v1/ai/llm. Interception has to be there.
    //
    // The proposed dates are anchored to TODAY, not hard-coded. Schedule
    // view only renders 60 days forward from the cursor, so a literal
    // 2026-05-08 stopped being visible the moment that date passed and
    // this test began failing on a date change alone, with nothing in the
    // product having moved. A model proposing a time relative to "now" is
    // also the realistic case — relative phrases are what the prompt
    // tells it to resolve.
    const at = (d: number, hhmm: string) => `${format(addDays(new Date(), d), 'yyyy-MM-dd')}T${hhmm}:00`;
    const day = format(addDays(new Date(), 2), 'yyyy-MM-dd');
    const other = format(addDays(new Date(), 3), 'yyyy-MM-dd');
    const allday = format(addDays(new Date(), 4), 'yyyy-MM-dd');
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: JSON.stringify({
                            options: [
                                {
                                    label: 'Lunch with Sam',
                                    icon: '🍽️',
                                    rationale: 'They suggested Friday lunch.',
                                    title: 'Lunch with Sam',
                                    start: at(2, '12:30'),
                                    end: at(2, '13:30'),
                                    location: 'Carlos cafe',
                                    description: "Lunch chat following Sam's reply."
                                },
                                { label: 'Block focus time', icon: '🛡️', title: 'Focus', start: at(3, '14:00'), end: at(3, '15:00') },
                                { label: 'Quick reminder',  icon: '⏰', title: 'Reminder', start: at(2, '09:00'), end: at(2, '09:15') },
                                { label: 'Read carefully',  icon: '🔎', title: 'Read', start: at(3, '16:00'), end: at(3, '16:15') },
                                { label: 'Mark as deadline', icon: '📅', title: 'Deadline', start: allday, end: allday, allDay: true }
                            ]
                        })
                    }
                }]
            })
        });
    });

    await login(page);
    // Open the welcome email (uid 1001 has a fixture with body text).
    await page.locator('[data-testid=msg-row-1001]').click();
    await expect(page.getByTestId('detail-subject')).toBeVisible();

    // Click "AI Add to calendar" — opens the 5-card picker.
    await page.getByTestId('suggest-event-btn').click();
    await expect(page.getByTestId('cal-options-pop')).toBeVisible();
    // Pick the first card → EventModal pre-fills.
    await page.getByTestId('cal-option-0').click();

    await expect(page.getByTestId('cal-event-modal')).toBeVisible();
    await expect(page.getByTestId('cal-evt-title')).toHaveValue('Lunch with Sam');
    await expect(page.getByTestId('cal-evt-location')).toHaveValue('Carlos cafe');

    // Save commits to the mock CalDAV API; the event lands in calendar surface.
    await page.getByTestId('cal-evt-save').click();
    await expect(page.getByTestId('cal-event-modal')).toHaveCount(0);
    await page.getByTestId('app-switch-calendar').click();
    await page.getByTestId('cal-view-schedule').click();
    await expect(page.getByTestId('cal-schedule-view')).toContainText('Lunch with Sam');
});

test('ChatBot: list_calendars tool roundtrip surfaces calendar names in the answer', async ({ page }) => {
    // Intercept the PROVIDER PROXY. The fixture reports a configured server
    // on /v1/ai/config, and chat's resolveBaseUrl() prefers
    // capabilities.aiConfig over settings.llm, so no baseUrl planted in
    // localStorage is ever dialled — the call lands on /v1/ai/llm.
    let llmCallCount = 0;
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        llmCallCount += 1;
        if (llmCallCount === 1) {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [{
                                id: 'call_cal_1',
                                type: 'function',
                                function: { name: 'list_calendars', arguments: '{}' }
                            }]
                        }
                    }]
                })
            });
        } else {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: 'You have two calendars: Personal and Work.' } }]
                })
            });
        }
    });
    await login(page);
    await page.getByTestId('chatbot-bubble').click();
    await page.getByTestId('chatbot-input').fill('What calendars do I have?');
    await page.getByTestId('chatbot-send').click();
    await expect(page.getByTestId('chatbot-messages')).toContainText('list_calendars');
    await expect(page.getByTestId('chatbot-messages')).toContainText('Personal and Work');
    expect(llmCallCount).toBe(2);
});

test('ChatBot: tool call loop drives /v1/me/mail-rules and renders the answer', async ({ page }) => {
    // First completion: model asks to call list_mail_rules.
    // Second completion (after we feed the tool result back): model writes the final answer.
    // Same proxy-routing constraint as the list_calendars test above.
    let llmCallCount = 0;
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        llmCallCount += 1;
        if (llmCallCount === 1) {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [{
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'list_mail_rules', arguments: '{}' }
                            }]
                        }
                    }]
                })
            });
        } else {
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: 'You have 0 mail rules — your inbox is in pristine condition.' } }]
                })
            });
        }
    });
    await login(page);
    await page.getByTestId('chatbot-bubble').click();
    await expect(page.getByTestId('chatbot-input')).toBeEnabled();
    await page.getByTestId('chatbot-input').fill('What rules do I have?');
    await page.getByTestId('chatbot-send').click();
    await expect(page.getByTestId('chatbot-messages')).toContainText('list_mail_rules');
    await expect(page.getByTestId('chatbot-messages')).toContainText('pristine condition');
    expect(llmCallCount).toBe(2);
});

test('Settings: Filters section lists blocked + allowed senders + temp aliases', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-filters]');
    await expect(page.getByTestId('settings-filters')).toBeVisible();
    await page.fill('[data-testid=block-input]', 'spam@example.com');
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('[data-testid=block-add]');
    await expect(page.getByTestId('blocked-list')).toContainText('spam@example.com');
    await page.fill('[data-testid=allow-input]', 'newsletter@example.com');
    await page.click('[data-testid=allow-add]');
    await expect(page.getByTestId('allowed-list')).toContainText('newsletter@example.com');
    // Disposable aliases are now in the Account tab.
    await page.click('[data-testid=settings-tab-account]');
    await page.click('[data-testid=temp-alias-7d]');
    await expect(page.getByTestId('temp-aliases-list')).toContainText('@test.local');
    await page.screenshot({ path: `${SCREEN_DIR}/20-settings-filters.png`, fullPage: true });
});

test('Account dropdown: add another account opens login overlay, switch works', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);

    // Add a second account via the account dropdown.
    await page.click('[data-testid=account-btn]');
    await page.click('[data-testid=account-menu-add]');
    // Login overlay shows on top of the existing inbox.
    await expect(page.getByText('Add another account')).toBeVisible();
    await page.fill('[data-testid=login-user]', 'second@test.local');
    await page.fill('[data-testid=login-pass]', 'hunter3');
    await page.click('[data-testid=login-submit]');
    // Wait for layout to re-mount with new active session.
    await expect(page.getByTestId('shell')).toBeVisible();

    // Account dropdown now shows two sessions.
    await page.click('[data-testid=account-btn]');
    await expect(page.getByTestId('account-menu')).toContainText('second@test.local');
    await expect(page.getByTestId('account-menu')).toContainText('demo@test.local');
    await page.screenshot({ path: `${SCREEN_DIR}/21-multi-account-menu.png`, fullPage: true });

    // Switch back to first account; the account-pill in the header shows it.
    await page.getByTestId('switch-demo@test.local').click();
    await expect(page.locator('[data-testid=account-btn] .user-email')).toContainText('demo@test.local');
});

// Subscriber fires with 3 items (verified with logging) but the test
test('Sidebar Shortcuts: link / popup / embed modes route correctly', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await expect(page.getByTestId('shortcut-HR Portal')).toBeVisible({ timeout: 7000 });
    await expect(page.getByTestId('shortcut-Wiki')).toBeVisible();
    await expect(page.getByTestId('shortcut-Calendar')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/23-shortcuts-sidebar.png`, fullPage: true });

    // Popup mode → opens a FloatingPanel iframe.
    await page.click('[data-testid="shortcut-Wiki"]');
    await expect(page.getByTestId('shortcut-popup-Wiki')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/24-shortcut-popup.png`, fullPage: true });
    await page.click('[data-testid="shortcut-popup-Wiki-close"]');
    await expect(page.getByTestId('shortcut-popup-Wiki')).not.toBeVisible();

    // Embed mode → swaps the message-pane for an iframe pane.
    await page.click('[data-testid="shortcut-Calendar"]');
    await expect(page.getByTestId('shortcut-embed-Calendar')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/25-shortcut-embed.png`, fullPage: true });
    await page.click('[data-testid=shortcut-embed-close]');
    await expect(page.getByTestId('shortcut-embed-Calendar')).not.toBeVisible();
    await expect(page.getByTestId('msg-list')).toBeVisible();

    // Link mode → opens a new tab. Intercept the external URL so the
    // headless test doesn't hit a chrome-error page for an unreachable domain.
    await page.context().route('https://hr.example.com/**', (route) => {
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>HR Portal</body></html>' });
    });
    const [popup] = await Promise.all([
        page.context().waitForEvent('page'),
        page.click('[data-testid="shortcut-HR Portal"]')
    ]);
    await expect(popup.locator('body')).toContainText('HR Portal');
    await popup.close();
});

test('compose modal is draggable, resizable, minimizable, maximizable', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=compose-btn]');
    await expect(page.getByTestId('compose-modal')).toBeVisible();

    // Maximize → restore.
    await page.click('[data-testid=compose-modal-maximize]');
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${SCREEN_DIR}/15-compose-maximized.png`, fullPage: true });
    await page.click('[data-testid=compose-modal-maximize]');

    // Drag the header to a new position.
    const header = page.locator('[data-testid=compose-modal-header]');
    const box = await header.boundingBox();
    if (!box) throw new Error('compose header not found');
    await page.mouse.move(box.x + 60, box.y + 18);
    await page.mouse.down();
    await page.mouse.move(box.x + 60 - 200, box.y + 18 - 80, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    await page.screenshot({ path: `${SCREEN_DIR}/15b-compose-dragged.png`, fullPage: true });

    // Minimize.
    await page.click('[data-testid=compose-modal-minimize]');
    await page.waitForTimeout(80);
    await page.screenshot({ path: `${SCREEN_DIR}/15c-compose-minimized.png`, fullPage: true });

    // Persisted geometry survives a reload.
    const stored = await page.evaluate(() => localStorage.getItem('webmail.panel.compose.new'));
    expect(stored).toBeTruthy();
    const parsed = stored ? JSON.parse(stored) : null;
    expect(parsed.minimized).toBe(true);
});

test('account dropdown menu shows email + Settings + Sign out', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=account-btn]');
    const menu = page.getByTestId('account-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('demo@test.local');
    await expect(page.getByTestId('account-menu-settings')).toBeVisible();
    await expect(page.getByTestId('logout-btn')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/16-account-menu.png`, fullPage: true });
});

test('filter chips switch between All / Unread / Starred', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await expect(page.getByTestId('filter-chips')).toBeVisible();
    await page.click('[data-testid=filter-unread]');
    // Only the unread row should remain (the Concierge "Welcome" message).
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-1000')).not.toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/17-filter-unread.png`, fullPage: true });

    await page.click('[data-testid=filter-starred]');
    // Only Sam's "Re: lunch" message has \Flagged in the fixture.
    await expect(page.getByTestId('msg-row-999')).toBeVisible();

    await page.click('[data-testid=filter-all]');
    await expect(page.getByTestId('msg-row-1001')).toBeVisible();
    await expect(page.getByTestId('msg-row-1000')).toBeVisible();
});

test('density toggle switches between compact and comfortable', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await page.click('[data-testid=settings-tab-message-list]');
    await page.click('[data-testid=settings-density-compact]');
    await page.click('[data-testid=settings-done]');
    const density = await page.getAttribute('[data-testid=shell]', 'data-density');
    expect(density).toBe('compact');
    await page.screenshot({ path: `${SCREEN_DIR}/18-density-compact.png`, fullPage: true });
});

test('Settings: skin picker swaps the whole palette, and the accent layers over it', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=settings-btn]');
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await page.click('[data-testid=settings-tab-appearance]');

    const readVar = (name: string) => page.evaluate(
        (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(),
        name
    );

    // Outlook is the default; its command bar is its accent.
    expect((await readVar('--accent')).toLowerCase()).toBe('#0078d4');
    expect(await readVar('--font-sans')).toContain('Segoe UI');

    // Pick the Gmail skin — the accent AND the type family change with it.
    await page.click('[data-testid=skin-gmail]');
    expect((await readVar('--accent')).toLowerCase()).toBe('#ea4335');
    expect(await readVar('--font-sans')).toContain('Roboto');

    // Persistence: reload, the same skin should re-apply.
    await page.reload();
    expect((await readVar('--accent')).toLowerCase()).toBe('#ea4335');

    await page.screenshot({ path: `${SCREEN_DIR}/19-skin-gmail.png`, fullPage: true });

    // The accent picker is a LAYER, not a replacement: dialling a new hue on
    // Gmail must retint the accent family without stripping the skin's
    // surfaces, type or shape. This is the regression that made the old
    // 'custom' pseudo-skin unusable.
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-appearance]');
    await page.getByTestId('skin-custom-input').fill('#7c3aed');

    // Still Gmail underneath — type and shape untouched.
    expect(await readVar('--font-sans')).toContain('Roboto');

    // The accent layer is MODE-AWARE. It used to derive one family from one
    // lightness and apply it in both palettes, which on Gmail's dark surface
    // produced accent TEXT at 1.41:1 — invisible — so every AI chip and
    // accent-coloured link vanished the moment you picked a dark theme.
    // Dark therefore re-derives two roles: --accent is the lifted BAR
    // (l clamped to 58..74%, so #7c3aed at l=57.8% reads as a surface rather
    // than a black hole) and --accent-text is the lighter ink that sits ON a
    // surface. Assert both against what the layer actually produces.
    const darkAccent = await readVar('--accent');
    expect(darkAccent).toBe('hsl(262.1 83.3% 74.0%)');
    const darkAccentText = await readVar('--accent-text');
    expect(darkAccentText).toBe('hsl(262.1 83.3% 84.0%)');

    // And the skin's own DARK surface survives the layer — the whole point of
    // a layer. This assertion used to expect #ffffff, Gmail's light surface,
    // while the test ran in dark mode where it is #292a2d.
    expect((await readVar('--bg-surface')).toLowerCase()).toBe('#292a2d');

    // Close Settings first — its overlay sits over the topbar, so the
    // theme toggle is not clickable while the modal is open.
    await page.getByTestId('settings-done').click();
    await expect(page.getByTestId('settings-modal')).toHaveCount(0);
    await page.screenshot({ path: `${SCREEN_DIR}/20-accent-layered.png`, fullPage: true });
    // The topbar appearance control is a POPOVER, not a bare cycling
    // button: it opens a panel with an Auto/Light/Dark radiogroup, and
    // clicking the trigger again would just close it. The accent layer
    // branches on the effective mode, so drive the real radio.
    await page.getByTestId('theme-toggle').click();
    await page.getByTestId('appearance-mode-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // Flipping to light must re-derive the same hue for the light palette,
    // and the accent must survive the mode change rather than reverting to
    // the skin's own red. Light keeps the raw hue (only the hover/soft/text
    // roles are re-derived), so --accent comes back as the hsl() form of the
    // picked hex, and --accent-text as a darker step of it (l 57.8% -> 39.8%,
    // the link-safe shade) rather than the dark palette's lifted 84%.
    expect(await readVar('--font-sans')).toContain('Roboto');
    expect((await readVar('--bg-surface')).toLowerCase()).toBe('#ffffff');
    expect((await readVar('--accent')).toLowerCase()).toBe('hsl(262.1 83.3% 57.8%)');
    expect((await readVar('--accent-text')).toLowerCase()).toBe('hsl(262.1 83.3% 39.8%)');
});

test('install banner appears when beforeinstallprompt fires', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    // Fire a synthetic beforeinstallprompt before app boot — our PWA listener
    // captures it and flips pwa.available to true.
    await page.addInitScript(() => {
        // Save the event so the page handler can capture it on its own time.
        const ev = new Event('beforeinstallprompt') as Event & { prompt?: () => Promise<void>; userChoice?: Promise<unknown> };
        (ev as any).prompt = async () => {};
        (ev as any).userChoice = Promise.resolve({ outcome: 'dismissed' });
        window.addEventListener('load', () => {
            // Defer slightly so the SPA has registered its listener.
            setTimeout(() => window.dispatchEvent(ev), 100);
        });
        // Make sure the dismissed flag from prior tests doesn't suppress us.
        try { localStorage.removeItem('webmail.install-banner-dismissed'); } catch {}
    });
    await login(page);
    await expect(page.getByTestId('install-banner')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: `${SCREEN_DIR}/14-install-banner.png`, fullPage: true });
    await page.click('[data-testid=install-dismiss]');
    await expect(page.getByTestId('install-banner')).not.toBeVisible();
});


test('AI panel exposes Summarize, Draft, Action items, and Translate', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await page.click('[data-testid=msg-row-1001]');
    await page.click('[data-testid=ai-btn]');
    await page.click('[data-testid=ai-summarize-btn]');
    await page.click('[data-testid=ai-actions-btn]');
    await page.click('[data-testid=ai-translate-btn]');
    await expect(page.getByTestId('ai-summary-out')).toBeVisible();
    await expect(page.getByTestId('ai-actions-out')).toBeVisible();
    await expect(page.getByTestId('ai-translate-out')).toBeVisible();
    await page.screenshot({ path: `${SCREEN_DIR}/12-ai-panel-full.png`, fullPage: true });
});

test('tracking email shows spy theme glow and icon', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await expect(page.getByTestId('msg-list')).toBeVisible();

    // The tracking email row should have the spy-tracked class and show the subject
    const trackingRow = page.getByTestId('msg-row-998');
    await expect(trackingRow).toHaveClass(/spy-tracked/);
    await expect(trackingRow).toContainText('Opened: Re: Fwd: CONTACT FROM GUINNESS');
    await page.screenshot({ path: `${SCREEN_DIR}/13-tracking-row-dark.png`, fullPage: true });

    // Open the tracking email detail — subject should also have spy styling
    await trackingRow.click();
    await expect(page.getByTestId('detail-subject')).toContainText('Opened: Re: Fwd: CONTACT FROM GUINNESS');
    const detailSubject = page.getByTestId('detail-subject');
    await expect(detailSubject).toHaveClass(/spy-tracked-subject/);
    await page.screenshot({ path: `${SCREEN_DIR}/14-tracking-detail-dark.png`, fullPage: true });
});

test('AI Sorted filter buckets humans first, then ranks by danger level with glows', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'dark'));
    await login(page);
    await expect(page.getByTestId('msg-list')).toBeVisible();

    // Click the AI Sorted filter chip
    await page.getByTestId('filter-ai-sorted').click();

    // AI sort buckets by CATEGORY FIRST, relevance level second
    // (human -> important -> info -> marketing, which is what the chip's
    // own tooltip promises), so Sam's lunch thread outranks the invoice no
    // matter how urgent the invoice is. This test used to expect the
    // invoice on top, which was the old sort-by-danger-level contract.
    //
    // No fixed sleep: the sort is a model round-trip, and the danger class
    // is applied from the ranking, so the class appearing IS the signal
    // that the sort landed.
    const rows = page.locator('.row[data-testid^="msg-row-"]');
    await expect(rows).toHaveCount(4);

    const firstRow = rows.first();
    await expect(firstRow).toHaveAttribute('data-testid', 'msg-row-999');
    await expect(firstRow).toHaveClass(/ai-cat-human/);

    // The invoice is next — the top relevance in the 'important' bucket,
    // and the only row at the top danger level, so it carries the glow.
    const invoiceRow = rows.nth(1);
    await expect(invoiceRow).toHaveAttribute('data-testid', 'msg-row-1000');
    await expect(invoiceRow).toHaveClass(/danger-4/);
    await expect(invoiceRow).toHaveClass(/ai-cat-important/);

    // Screenshot the AI-sorted inbox
    await page.screenshot({ path: `${SCREEN_DIR}/15-ai-sorted-dark.png`, fullPage: true });

    // Switch back to All to verify normal order returns
    await page.getByTestId('filter-all').click();
    const allFirstRow = page.locator('.row[data-testid^="msg-row-"]').first();
    await expect(allFirstRow).toHaveAttribute('data-testid', 'msg-row-1001');
});


test('Suggest event uses server AI config when no local key is set', async ({ page }) => {
    // Mock the server-side AI config endpoint so the client thinks
    // the admin has configured a shared provider.
    await page.route('**/v1/ai/config', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                configured: true,
                kind: 'openai',
                baseUrl: 'http://mock-llm.test/v1',
                model: 'gpt-4o-mini',
                apiKey: 'sk-server-config'
            })
        });
    });

    // Do NOT set a local API key — the client must rely on the server config.
    await page.addInitScript(() => {
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' },
            useCustomLlm: false, density: 'comfortable', listFilter: 'all'
        }));
    });

    // Intercept the outbound LLM call and verify it uses the server key.
    let capturedAuth: string | null = null;
    await page.route('**/mock-llm.test/v1/chat/completions', async (route) => {
        capturedAuth = await route.request().headerValue('authorization');
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: JSON.stringify({
                            options: [
                                {
                                    label: 'Server-config lunch',
                                    icon: '🍽️',
                                    rationale: 'Server key worked.',
                                    title: 'Server-config lunch',
                                    start: '2026-05-08T12:30:00',
                                    end: '2026-05-08T13:30:00',
                                    location: 'Server Cafe',
                                    description: 'Lunch via server config.'
                                },
                                { label: 'Focus time', icon: '🛡️', title: 'Focus', start: '2026-05-08T14:00:00', end: '2026-05-08T15:00:00' },
                                { label: 'Quick reminder', icon: '⏰', title: 'Reminder', start: '2026-05-08T09:00:00', end: '2026-05-08T09:15:00' },
                                { label: 'Read carefully', icon: '🔎', title: 'Read', start: '2026-05-08T16:00:00', end: '2026-05-08T16:15:00' },
                                { label: 'Mark deadline', icon: '📅', title: 'Deadline', start: '2026-05-08', end: '2026-05-08', allDay: true }
                            ]
                        })
                    }
                }]
            })
        });
    });

    await login(page);
    await page.locator('[data-testid=msg-row-1001]').click();
    await expect(page.getByTestId('detail-subject')).toBeVisible();

    // AI Calendar should appear first (before Other AI)
    await expect(page.getByTestId('suggest-event-btn')).toBeVisible();
    await page.getByTestId('suggest-event-btn').click();
    await expect(page.getByTestId('cal-options-pop')).toBeVisible();

    // Verify the request was sent with the server-provided key.
    expect(capturedAuth).toBe('Bearer sk-server-config');

    // Pick the option and assert the modal pre-fills.
    await page.getByTestId('cal-option-0').click();
    await expect(page.getByTestId('cal-event-modal')).toBeVisible();
    await expect(page.getByTestId('cal-evt-title')).toHaveValue('Server-config lunch');
});

test('Message detail exposes both AI buttons: wand "Other AI" menu and "AI tools" panel', async ({ page }) => {
    await login(page);
    await page.locator('[data-testid=msg-row-1001]').click();
    await expect(page.getByTestId('detail-subject')).toBeVisible();

    // The wand button opens the suggested-actions MENU. It used to share
    // ai-btn with the panel opener, which made the id ambiguous between two
    // buttons that are both live for a configured account; it is ai-tools-btn
    // now.
    const otherAiBtn = page.getByTestId('ai-tools-btn');
    await expect(otherAiBtn).toBeVisible();
    await expect(otherAiBtn).toContainText('Other AI');
    // Verify the button uses the amber/warning class (ai-btn-other)
    const classAttr = await otherAiBtn.getAttribute('class');
    expect(classAttr).toContain('ai-btn-other');

    // The other one opens the AI PANEL (Summarize / Draft / Action items /
    // Translate) and is labelled "AI tools".
    const aiPanelBtn = page.getByTestId('ai-btn');
    await expect(aiPanelBtn).toBeVisible();
    await expect(aiPanelBtn).toContainText('AI tools');
    // And it must open a panel, not the menu — they are distinct surfaces.
    await aiPanelBtn.click();
    await expect(page.getByTestId('ai-panel')).toBeVisible();
    await expect(page.getByTestId('ai-tools-pop')).toHaveCount(0);
});

test('Voice mode opens fullscreen overlay and runs conversation loop', async ({ page }) => {
    // Mock Web Speech API so Playwright can "speak" without a real mic.
    await page.addInitScript(() => {
        class MockSpeechRecognition {
            continuous = false;
            interimResults = false;
            lang = 'en-US';
            onresult: ((e: { results: { isFinal: boolean; 0: { transcript: string } }[]; resultIndex: number }) => void) | null = null;
            onend: (() => void) | null = null;
            onerror: ((e: { error: string }) => void) | null = null;
            _started = false;
            start() {
                this._started = true;
                // Simulate the user saying "Hello assistant" after 80ms.
                setTimeout(() => {
                    if (!this._started) return;
                    if (this.onresult) {
                        this.onresult({
                            results: [{ isFinal: true, 0: { transcript: 'Hello assistant' } }],
                            resultIndex: 0
                        });
                    }
                    if (this.onend) this.onend();
                }, 80);
            }
            stop() { this._started = false; }
        }
        (window as any).SpeechRecognition = MockSpeechRecognition;
        (window as any).webkitSpeechRecognition = MockSpeechRecognition;

        // Speed up Audio playback so we don't wait for real audio.
        const origPlay = Audio.prototype.play;
        Audio.prototype.play = function () {
            setTimeout(() => this.dispatchEvent(new Event('ended')), 30);
            return Promise.resolve();
        };
        // VoiceChat will not start listening until it holds a mic stream,
        // and its auto-submit detector only ever runs inside the
        // AudioContext analyser interval. Playwright denies the microphone
        // by default, so mocking Web Speech alone gives an overlay that
        // opens and then silently never hears anything — the STT mock is
        // never even constructed. Both halves have to be stubbed.
        // (Everything here lives INSIDE the init script for that reason:
        // addInitScript serialises the function, so a module-level helper
        // would compile and then throw ReferenceError in the page.)
        navigator.mediaDevices.getUserMedia = () =>
            Promise.resolve({ getTracks: () => [{ stop: () => undefined }] } as unknown as MediaStream);
        class FakeAnalyser {
            fftSize = 1024;
            smoothingTimeConstant = 0.6;
            getByteTimeDomainData(a: Uint8Array) { a.fill(128); }   // flat line = silence
            disconnect() { /* noop */ }
        }
        class FakeAudioContext {
            state = 'running';
            createAnalyser() { return new FakeAnalyser() as unknown as AnalyserNode; }
            createMediaStreamSource() { return { connect: () => undefined } as unknown as MediaStreamAudioSourceNode; }
            resume() { return Promise.resolve(); }
            close() { return Promise.resolve(); }
        }
        (window as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
        (window as unknown as Record<string, unknown>).webkitAudioContext = FakeAudioContext;
    });

    // Mock ElevenLabs TTS.
    await page.route('https://api.elevenlabs.io/v1/text-to-speech/**', (route) => {
        route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from([]) });
    });

    // Mock LLM chat completion for the voice turn. Intercept the PROVIDER
    // PROXY: the suite fixture reports a configured server, and chat's
    // resolveBaseUrl() checks capabilities.aiConfig before settings.llm, so
    // the turn goes to /v1/ai/llm rather than to any provider baseUrl. The
    // localStorage LLM config these tests used to plant is never consulted
    // while the server reports itself configured.
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                choices: [{
                    message: { role: 'assistant', content: 'Hello! How can I help you today?' }
                }]
            })
        });
    });

    await login(page);

    // Switch to AI chat surface.
    await page.click('[data-testid=app-switch-ai]');
    await expect(page.getByTestId('ai-app')).toBeVisible();

    // Open voice mode.
    const voiceModeBtn = page.getByTestId('ai-voice-mode');
    await expect(voiceModeBtn).toBeVisible();
    await voiceModeBtn.click();

    // Fullscreen overlay should appear.
    const overlay = page.getByTestId('voice-chat-overlay');
    await expect(overlay).toBeVisible();

    // Wait for the conversation to happen (STT → send → LLM → TTS → bubble).
    await expect(page.getByTestId('voice-bubble-user-0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('voice-bubble-assistant-1')).toBeVisible({ timeout: 5000 });

    // Verify transcript content.
    await expect(page.getByTestId('voice-bubble-user-0')).toContainText('Hello assistant');
    await expect(page.getByTestId('voice-bubble-assistant-1')).toContainText('How can I help you today?');

    // Close voice mode.
    await page.getByTestId('voice-close').click();
    await expect(overlay).not.toBeVisible();

    // The text chat should now contain the same messages.
    await expect(page.getByTestId('ai-messages')).toContainText('Hello assistant');
    await expect(page.getByTestId('ai-messages')).toContainText('How can I help you today?');
});

test('AI threads load from hidden IMAP folder and sync on change', async ({ page }) => {
    let appendCalled = false;
    await page.route('**/v1/mailboxes/.AI%20Conversations/messages*', (route, request) => {
        if (request.method() === 'POST') {
            appendCalled = true;
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
                            flags: ['\\\\Seen'],
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
                flags: ['\\\\Seen'],
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

    await login(page);
    await page.waitForTimeout(600);
    await page.click('[data-testid=app-switch-ai]');
    await expect(page.getByTestId('ai-app')).toBeVisible();
    await expect(page.getByTestId('ai-thread-list')).toContainText('Synced from IMAP', { timeout: 5000 });
    await page.getByTestId('ai-new').click();
    await page.waitForTimeout(4000);
    expect(appendCalled).toBe(true);
});

test('Mic auto-sends when Voice toggle is on', async ({ page }) => {
    await page.addInitScript(() => {
        class MockSpeechRecognition {
            continuous = false;
            interimResults = false;
            lang = 'en-US';
            onresult: ((e: { results: { isFinal: boolean; 0: { transcript: string } }[]; resultIndex: number }) => void) | null = null;
            onend: (() => void) | null = null;
            onerror: ((e: { error: string }) => void) | null = null;
            start() {
                setTimeout(() => {
                    if (this.onresult) {
                        this.onresult({
                            results: [{ isFinal: true, 0: { transcript: 'Auto send test' } }],
                            resultIndex: 0
                        });
                    }
                    if (this.onend) this.onend();
                }, 50);
            }
            stop() {}
        }
        (window as any).SpeechRecognition = MockSpeechRecognition;
        (window as any).webkitSpeechRecognition = MockSpeechRecognition;

        Audio.prototype.play = function () {
            setTimeout(() => this.dispatchEvent(new Event('ended')), 30);
            return Promise.resolve();
        };
    });

    await page.route('https://api.elevenlabs.io/v1/text-to-speech/**', (route) => {
        route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from([]) });
    });

    // Intercept the PROVIDER PROXY — the suite fixture reports a configured
    // server, and chat's resolveBaseUrl() checks capabilities.aiConfig
    // before settings.llm, so the turn goes to /v1/ai/llm and a
    // localStorage LLM config is never consulted.
    await page.route('**/v1/ai/llm/chat/completions', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                choices: [{
                    message: { role: 'assistant', content: 'Auto-send works!' }
                }]
            })
        });
    });

    await page.addInitScript(() => {
        // Enable voice prefs so mic auto-sends.
        localStorage.setItem('webmail.ai.voice.v1', JSON.stringify({ enabled: true, voiceId: '21m00Tcm4TlvDq8ikWAM', speakUserToo: false }));
    });

    await login(page);
    await page.click('[data-testid=app-switch-ai]');
    await expect(page.getByTestId('ai-app')).toBeVisible();

    // Click the regular mic button.
    const micBtn = page.getByTestId('ai-mic');
    await expect(micBtn).toBeVisible();
    await micBtn.click();

    // Because voice is enabled, the transcript should auto-send and produce an assistant reply.
    await expect(page.getByTestId('ai-messages')).toContainText('Auto send test', { timeout: 3000 });
    await expect(page.getByTestId('ai-messages')).toContainText('Auto-send works!', { timeout: 3000 });
});

