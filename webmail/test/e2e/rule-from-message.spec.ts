import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyMocks, login } from './fixtures';
import { mkdirSync } from 'node:fs';

const SCREEN_DIR = 'test/screenshots';
mkdirSync(SCREEN_DIR, { recursive: true });

// Right-click a message → "Create rule from message" → edit → save.

/** Shape the dialog POSTs to /v1/me/mail-rules. Mirrors MailRuleInput on
 *  the server so an assertion failure names the actual wrong field. */
interface PostedRule {
    name?: string;
    condition: { type: string; value: string; header?: string };
    action: { type: string; to?: string; folder?: string; webhookId?: string };
}

/** Record every rule POST the page makes, so tests can assert on what was
 *  — and wasn't — created. */
function captureRulePosts(page: Page): PostedRule[] {
    const posts: PostedRule[] = [];
    page.on('request', (req) => {
        if (req.url().includes('/v1/me/mail-rules') && req.method() === 'POST') {
            posts.push(req.postDataJSON() as PostedRule);
        }
    });
    return posts;
}
//
// The point of these tests is that the dialog never one-clicks a guessed
// rule: opening it must POST nothing, and the rule that lands must be the
// one the user actually configured.

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
});

/** Open the rule dialog from the first message row via right-click. */
async function openRuleDialog(page: Page) {
    const row = page.locator('.row').first();
    await row.click({ button: 'right' });
    await expect(page.getByTestId('msg-ctx')).toBeVisible();
    await page.getByText('Create rule from message').click();
    await expect(page.getByTestId('rule-from-message-dialog')).toBeVisible();
    // The dialog fetches the outbound-webhook list asynchronously on open and
    // only renders the `webhook` action once that list is non-empty (or once
    // the fetch has failed, which hides it entirely). Without this wait a test
    // can assert on the action <select> while it is still in its empty,
    // pre-load state — which reads as "the webhook option is missing" rather
    // than "the fetch has not landed yet".
    await expect(page.getByTestId('rule-action-type').locator('option').first())
        .toBeAttached({ timeout: 10_000 });
}

/**
 * Serve an inbox containing only a no-reply verification message.
 *
 * Routed here rather than added to the shared `messages` fixture: several
 * specs assert the inbox row count (4), so quietly growing the shared list
 * breaks unrelated tests. Registered BEFORE login so it takes precedence
 * over the fixture's catch-all messages route.
 */
async function serveOnlyNoReplyMessage(page: Page) {
    const msg = {
        uid: 5000,
        seq: 1,
        flags: ['\\Seen'],
        size: 640,
        internalDate: '2026-04-25T11:05:00Z',
        envelope: {
            date: '2026-04-25T11:05:00Z',
            subject: 'Your verification code is 481920',
            from: [{ name: 'Example Accounts', address: 'no-reply@example.test' }],
            to: [{ name: null, address: 'demo@test.local' }],
            cc: [],
            messageId: '<verify-1@example>',
            inReplyTo: null
        }
    };
    await page.route(/\/v1\/mailboxes\/INBOX\/messages(\?|$)/, (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ total: 1, messages: [msg] })
        })
    );
}

test('opening the rule dialog does not create a rule', async ({ page }) => {
    const posts = captureRulePosts(page);
    await login(page);
    await openRuleDialog(page);

    // The sender from the right-clicked message (uid 1001, concierge@example.com)
    // is prefilled, and the source headers are shown.
    await expect(page.getByTestId('rule-condition-value')).toHaveValue('concierge@example.com');
    await expect(page.getByTestId('rule-condition-type')).toHaveValue('from-contains');
    await expect(page.getByTestId('rule-from-message-source')).toContainText('concierge@example.com');
    await expect(page.getByTestId('rule-from-message-source')).toContainText('Welcome to imap-rest webmail');

    // The future-only caveat is on screen before the user commits to anything.
    await expect(page.getByTestId('rule-future-only-note')).toBeVisible();
    await expect(page.getByTestId('rule-future-only-note')).toContainText(/arrives/i);

    // Nothing was created just by opening.
    expect(posts).toHaveLength(0);

    // Cancelling also creates nothing.
    await page.getByTestId('rule-from-message-cancel').click();
    await expect(page.getByTestId('rule-from-message-dialog')).toHaveCount(0);
    expect(posts).toHaveLength(0);
});

test('creating a rule POSTs the configured condition and action', async ({ page }) => {
    const posts = captureRulePosts(page);
    await login(page);
    await openRuleDialog(page);

    // Narrow the condition to a subject match — a different rule than the
    // default prefill, proving the prefill is editable and not baked in.
    await page.selectOption('[data-testid=rule-condition-type]', 'subject-contains');
    await page.fill('[data-testid=rule-condition-value]', 'invoice');

    // Pick an action that requires an extra field and supply it.
    await page.selectOption('[data-testid=rule-action-type]', 'fileinto');
    await page.fill('[data-testid=rule-action-folder]', 'Archive');

    await page.getByTestId('rule-add').click();

    await expect(page.getByTestId('rule-from-message-dialog')).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].condition).toEqual({ type: 'subject-contains', value: 'invoice' });
    expect(posts[0].action).toEqual({ type: 'fileinto', folder: 'Archive' });

    // The toast must say it only affects future mail — the #1 "it didn't
    // work" confusion, since Sieve never re-filters existing mail.
    await expect(page.getByTestId('toast')).toContainText(/from now on/i);
});

test('quick-fill chips switch the condition to the other real headers', async ({ page }) => {
    await login(page);
    await openRuleDialog(page);

    await page.getByTestId('rule-prefill-to').click();
    await expect(page.getByTestId('rule-condition-type')).toHaveValue('to-contains');
    await expect(page.getByTestId('rule-condition-value')).toHaveValue(/@/);

    await page.getByTestId('rule-prefill-subject').click();
    await expect(page.getByTestId('rule-condition-type')).toHaveValue('subject-contains');
    await expect(page.getByTestId('rule-condition-value')).toHaveValue('Welcome to imap-rest webmail');

    await page.getByTestId('rule-prefill-from').click();
    await expect(page.getByTestId('rule-condition-type')).toHaveValue('from-contains');
    await expect(page.getByTestId('rule-condition-value')).toHaveValue('concierge@example.com');
});

test('header conditions expose a header field, and it is required', async ({ page }) => {
    const posts = captureRulePosts(page);
    await login(page);
    await openRuleDialog(page);

    // header-contains / header-is need a header name; the field only exists
    // for those two condition types.
    await expect(page.getByTestId('rule-condition-header')).toHaveCount(0);
    await page.selectOption('[data-testid=rule-condition-type]', 'header-contains');
    await expect(page.getByTestId('rule-condition-header')).toBeVisible();

    // Missing header → blocked, nothing posted.
    await page.fill('[data-testid=rule-condition-value]', 'newsletter');
    await page.getByTestId('rule-add').click();
    expect(posts).toHaveLength(0);
    await expect(page.getByTestId('rule-from-message-dialog')).toBeVisible();

    // With it, the rule posts and carries the header.
    await page.fill('[data-testid=rule-condition-header]', 'X-List-ID');
    await page.getByTestId('rule-add').click();
    await expect(page.getByTestId('rule-from-message-dialog')).toHaveCount(0);
    expect(posts[0].condition).toEqual({ type: 'header-contains', value: 'newsletter', header: 'X-List-ID' });
});

test('redirect requires a forward address', async ({ page }) => {
    const posts = captureRulePosts(page);
    await login(page);
    await openRuleDialog(page);

    await page.selectOption('[data-testid=rule-action-type]', 'redirect');
    await expect(page.getByTestId('rule-action-to')).toBeVisible();

    await page.getByTestId('rule-add').click();
    expect(posts).toHaveLength(0); // no address → no POST

    await page.fill('[data-testid=rule-action-to]', 'archive@elsewhere.example');
    await page.getByTestId('rule-add').click();
    await expect(page.getByTestId('rule-from-message-dialog')).toHaveCount(0);
    expect(posts[0].action).toEqual({ type: 'redirect', to: 'archive@elsewhere.example' });
});

test('webhook action is hidden when the server has no outbound-webhook endpoint', async ({ page }) => {
    // 501 = the server predates the feature. Offering a webhook action that
    // can never save would be a broken option, so it must not be offered.
    await page.route('**/v1/me/outbound-webhooks', (route) =>
        route.fulfill({
            status: 501,
            contentType: 'application/problem+json',
            body: JSON.stringify({ status: 501, title: 'Not implemented', detail: 'no webhooks' })
        })
    );
    await login(page);
    await openRuleDialog(page);

    const actionOptions = await page.getByTestId('rule-action-type').locator('option').allTextContents();
    expect(actionOptions.join('|')).not.toMatch(/webhook/i);
    // The other four actions remain fully available.
    expect(actionOptions).toHaveLength(4);
});

test('webhook action is offered and requires picking a webhook', async ({ page }) => {
    await page.route('**/v1/me/outbound-webhooks', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                webhooks: [{ id: 'wh_1', label: 'Agent', url: 'https://example.test/hook', keep: false, prepend: '' }],
                limit: 5
            })
        })
    );
    const posts = captureRulePosts(page);
    await login(page);
    await openRuleDialog(page);

    await page.selectOption('[data-testid=rule-action-type]', 'webhook');
    await expect(page.getByTestId('rule-action-webhook')).toBeVisible();

    // No webhook pre-selected — saving without a choice must not forward
    // mail somewhere the user never picked.
    await page.getByTestId('rule-add').click();
    expect(posts).toHaveLength(0);

    await page.selectOption('[data-testid=rule-action-webhook]', 'wh_1');
    await page.getByTestId('rule-add').click();
    await expect(page.getByTestId('rule-from-message-dialog')).toHaveCount(0);
    expect(posts[0].action).toEqual({ type: 'webhook', webhookId: 'wh_1' });
});

test('a no-reply sender seeds the webhook action', async ({ page }) => {
    // A verification sender is worth handing to a webhook rather than
    // deleting, so the dialog seeds that action. With webhooks available the
    // select shows it — and still demands a deliberate webhook pick.
    await serveOnlyNoReplyMessage(page);
    await page.route('**/v1/me/outbound-webhooks', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                webhooks: [{ id: 'wh_1', label: 'Agent', url: 'https://example.test/hook', keep: false, prepend: '' }],
                limit: 5
            })
        })
    );
    const posts = captureRulePosts(page);
    await login(page);
    await openRuleDialog(page);

    await expect(page.getByTestId('rule-condition-value')).toHaveValue('no-reply@example.test');
    await expect(page.getByTestId('rule-action-type')).toHaveValue('webhook');
    // Even seeded, nothing is picked — the user must choose the endpoint.
    await page.getByTestId('rule-add').click();
    expect(posts).toHaveLength(0);
});

test('a seeded webhook action falls back to discard when unavailable', async ({ page }) => {
    // Same no-reply seed, but the server has no outbound-webhook endpoint so
    // the option isn't rendered. The seeded action must fall back to discard
    // rather than POST a webhook the user never saw selected.
    await serveOnlyNoReplyMessage(page);
    await page.route('**/v1/me/outbound-webhooks', (route) =>
        route.fulfill({ status: 501, contentType: 'application/json', body: '{}' })
    );
    const posts = captureRulePosts(page);
    await login(page);
    await openRuleDialog(page);

    await expect(page.getByTestId('rule-action-type')).toHaveValue('discard');
    await page.getByTestId('rule-add').click();
    await expect(page.getByTestId('rule-from-message-dialog')).toHaveCount(0);
    expect(posts[0].action).toEqual({ type: 'discard' });
});

test('rule created from the context menu is listed in Settings', async ({ page }) => {
    await login(page);
    await openRuleDialog(page);
    await page.fill('[data-testid=rule-condition-value]', 'concierge@example.com');
    await page.getByTestId('rule-add').click();
    await expect(page.getByTestId('rule-from-message-dialog')).toHaveCount(0);

    // Same rules list Settings reads — the dialog doesn't create a
    // parallel kind of rule that Settings can't show or delete.
    await page.click('[data-testid=settings-btn]');
    await expect(page.getByTestId('settings-modal')).toBeVisible();
    await page.click('[data-testid=settings-tab-mail-rules]');
    await expect(page.getByTestId('rule-list')).toContainText('concierge@example.com');
    await page.screenshot({ path: `${SCREEN_DIR}/20-rule-from-message.png`, fullPage: true });
});

test('Escape closes the rule dialog without tearing down the reading pane', async ({ page }) => {
    await login(page);
    // Open a message FIRST. The dialog's Escape handler is capture-phase
    // precisely because Layout's document-level handler used to run first and
    // close the reading pane as well as the dialog. With nothing selected
    // there is nothing for that race to destroy, so the test would pass even
    // if the handler regressed to the bubble phase.
    await page.click('[data-testid=msg-row-1001]');
    await expect(page.getByTestId('detail-subject')).toBeVisible();

    await openRuleDialog(page);
    await expect(page.getByTestId('rule-future-only-note')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rule-from-message-dialog')).toHaveCount(0);
    // One Escape, one dismissal: the message behind the dialog survives.
    await expect(page.getByTestId('detail-subject')).toBeVisible();
});
