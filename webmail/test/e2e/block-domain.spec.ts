import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyMocks, login } from './fixtures';

// Context menu → Block sender / Block domain / Block root domain.
//
// The three items are the same code path (one confirm → blockSender → toast
// flow in Layout) differing only in WHICH rspamd blacklist_from pattern they
// hand it. So every test here asserts the pattern that reached the API and
// the pattern the user was shown, not merely that "something got blocked" —
// `*@example.co.uk` and `deals@mail.promo.example.co.uk` both produce a
// "Blocked" toast, and only one of them is the feature.
//
// The default sender is deliberately awkward: a host three labels below its
// registrable domain, under a multi-label public suffix. That is exactly
// where a naive "last two labels" reduction silently blocks the wrong tenant
// (it would return `promo.example.co.uk`, a domain nobody registered).

const HOST = 'mail.promo.example.co.uk';
const SENDER = `deals@${HOST}`;


/**
 * Serve an inbox containing exactly one message from `from`.
 *
 * Registered per test rather than added to the shared `messages` fixture:
 * the fixture uids are load-bearing for the other specs (envelopeFor binds by
 * uid), so adding cases there would re-point theirs. Registered AFTER
 * applyMocks, so this route wins for the list URL.
 */
async function mockSingleMessage(page: Page, uid: number, from: { name: string | null; address: string | null }[]) {
    await page.route(/\/v1\/mailboxes\/[^/]+\/messages(\?|$)/, (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                path: 'INBOX', page: 0, pageSize: 25, total: 1,
                messages: [{
                    uid, seq: 1, flags: [], size: 512,
                    internalDate: '2026-04-29T10:32:00Z',
                    envelope: {
                        date: '2026-04-29T10:32:00Z',
                        subject: 'Test',
                        from,
                        to: [{ name: null, address: 'demo@test.local' }],
                        cc: [],
                        messageId: `<m${uid}@test>`,
                        inReplyTo: null
                    }
                }]
            })
        });
    });

    // Registered AFTER the list route above, because Playwright evaluates the
    // most-recently-registered matching handler first — so this must be
    // added last to win the DELETE. The block flow dry-runs
    // `DELETE /v1/mailboxes/{path}/messages` with { sender, dryRun:true } to
    // count what it would remove BEFORE it blocks; the list route's
    // `(\?|$)` tail also matches that query-less URL, so without this it
    // answers a LIST body, `matched` comes back undefined, and the confirm
    // dialog never appears.
    await page.route(/\/v1\/mailboxes\/[^/]+\/messages$/, (route, request) => {
        if (request.method() !== 'DELETE') return route.fallback();
        let dryRun = false;
        let sender = '';
        try {
            const b = request.postDataJSON() as { sender?: string; dryRun?: boolean };
            dryRun = !!b?.dryRun;
            sender = b?.sender ?? '';
        } catch { /* treated as a real delete */ }
        const matched = sender === (from[0]?.address ?? '') ? 1 : 0;
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ path: 'INBOX', matched, deleted: dryRun ? 0 : matched })
        });
        return undefined;
    });
}

/** Every pattern POSTed to the blocklist, in order. */
function captureBlocks(page: Page): string[] {
    const blocked: string[] = [];
    page.on('request', (req) => {
        if (req.url().includes('/v1/me/blocked-senders') && req.method() === 'POST') {
            const body = req.postDataJSON() as { sender?: string };
            if (typeof body.sender === 'string') blocked.push(body.sender);
        }
    });
    return blocked;
}

/**
 * Accept every confirm() the block flow raises, and record the last one.
 *
 * This MUST be installed for every test, not just the ones that assert on
 * the dialog text: Playwright auto-DISMISSES dialogs that have no handler,
 * so an unhandled confirm() reads as "the user declined", the block never
 * happens, and a spec asserting the POST list sees an empty array — which
 * looks like a broken feature rather than a broken test.
 */
function acceptConfirms(page: Page): { text: () => string | null } {
    let seen: string | null = null;
    page.on('dialog', (d) => {
        if (d.type() === 'confirm') seen = d.message();
        void d.accept();
    });
    return { text: () => seen };
}

/** Log in and open the context menu on the first row. */
async function openCtx(page: Page) {
    await page.locator('.row').first().click({ button: 'right' });
    await expect(page.getByTestId('msg-ctx')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
});

test('Block sender blocks the exact From address', async ({ page }) => {
    await mockSingleMessage(page, 7001, [{ name: 'Promo', address: SENDER }]);
    const blocked = captureBlocks(page);
    const asked = acceptConfirms(page);

    await login(page);
    await openCtx(page);
    await page.getByRole('menuitem', { name: 'Block sender' }).click();

    // Not synchronous any more: the flow dry-runs a DELETE to count the
    // existing matches, shows a confirm naming that count, and only then
    // POSTs the pattern. Waiting on the observable effect instead of asserting
    // immediately is what makes this a test of the behaviour rather than of
    // the microtask queue.
    await expect.poll(() => blocked.length).toBeGreaterThan(0);
    expect(blocked).toEqual([SENDER]);
    // The dialog names the concrete pattern, so the user is never guessing
    // whether they are about to nuke a whole domain.
    expect(asked.text()).toContain(SENDER);
    await expect(page.getByTestId('toast')).toContainText(SENDER);
});

test('Block domain blocks *@ the full host, not the root', async ({ page }) => {
    await mockSingleMessage(page, 7001, [{ name: 'Promo', address: SENDER }]);
    const blocked = captureBlocks(page);
    acceptConfirms(page);

    await login(page);
    await openCtx(page);
    await page.getByRole('menuitem', { name: 'Block domain' }).click();

    // The full host INCLUDING the sub-labels. Reducing to the root here
    // would take out every other tenant under example.co.uk.
    await expect.poll(() => blocked.length).toBeGreaterThan(0);
    expect(blocked).toEqual([`*@${HOST}`]);
    await expect(page.getByTestId('toast')).toContainText(`*@${HOST}`);
});

test('Block root domain reduces past the multi-label public suffix', async ({ page }) => {
    await mockSingleMessage(page, 7001, [{ name: 'Promo', address: SENDER }]);
    const blocked = captureBlocks(page);
    acceptConfirms(page);

    await login(page);
    await openCtx(page);
    await page.getByRole('menuitem', { name: 'Block root domain' }).click();

    // example.co.uk — not mail.promo.example.co.uk, and emphatically not
    // co.uk, which is the whole point of the multi-label suffix table.
    await expect.poll(() => blocked.length).toBeGreaterThan(0);
    expect(blocked).toEqual(['*@example.co.uk']);
    await expect(page.getByTestId('toast')).toContainText('*@example.co.uk');
});

test('the menu offers all three block scopes at once', async ({ page }) => {
    await mockSingleMessage(page, 7001, [{ name: 'Promo', address: SENDER }]);

    await login(page);
    await openCtx(page);

    const menu = page.getByTestId('msg-ctx');
    await expect(menu.getByRole('menuitem', { name: 'Block sender' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Block domain' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Block root domain' })).toBeVisible();
});

test('a plain example.com sender hides the redundant root-domain option', async ({ page }) => {
    // Nothing is wider than example.com, so "Block root domain" would be a
    // second entry producing the identical pattern. It must be ABSENT rather
    // than present-and-identical.
    await mockSingleMessage(page, 7002, [{ name: 'Someone', address: 'someone@example.com' }]);

    await login(page);
    await openCtx(page);

    const menu = page.getByTestId('msg-ctx');
    await expect(menu.getByRole('menuitem', { name: 'Block sender' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Block domain' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Block root domain' })).toHaveCount(0);
});

test('a message with no From address offers no domain scopes', async ({ page }) => {
    // A bounce or a malformed header can leave From empty. There is no domain
    // to derive, so the items are hidden; plain "Block sender" stays and
    // reports the missing address itself.
    await mockSingleMessage(page, 7003, []);

    await login(page);
    await openCtx(page);

    const menu = page.getByTestId('msg-ctx');
    await expect(menu.getByRole('menuitem', { name: 'Block sender' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Block domain' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Block root domain' })).toHaveCount(0);
});

test('an IP-literal sender offers no domain scopes', async ({ page }) => {
    // A v4 literal has no registrable domain, and "*@[192.0.2.10]" is a legal
    // pattern the server would store but that can never match. Only the exact
    // address is meaningful.
    await mockSingleMessage(page, 7004, [{ name: 'Relay', address: 'notify@[192.0.2.10]' }]);

    await login(page);
    await openCtx(page);

    const menu = page.getByTestId('msg-ctx');
    await expect(menu.getByRole('menuitem', { name: 'Block sender' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Block domain' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Block root domain' })).toHaveCount(0);
});
