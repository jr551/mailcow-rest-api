// Outbound webhooks (Slice B): the management panel and the test-send button.
//
// These assert what a user would notice. In particular the test-send tests
// check the receiver's actual status and reply appear in the card, because
// the whole value of the button is that answer — a toast alone would be gone
// before it could be read or copied, which is the failure mode a test that
// only asserted "no error toast" would happily pass.
import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { applyMocks, login } from './fixtures';

type Webhook = {
    id: string;
    label: string;
    url: string;
    keep: boolean;
    prepend: string;
    mailbox: string;
    createdAt: number;
    lastUsedAt: number | null;
    headerNames?: string[];
};

/** 100 is the new per-user cap; the panel has to stay usable at that size,
 *  and "search finds the one I broke" is how anyone copes with it. */
const LIMIT = 100;

/** The request body is untrusted JSON, so headers arrive as `unknown` and are
 *  narrowed here rather than cast. The mock returns only the NAMES — which
 *  is all the real list endpoint returns too (values are write-only). */
function headerNames(raw: unknown): string[] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.keys(raw).sort((a, b) => a.localeCompare(b));
}

function installWebhookApi(
    page: Page,
    opts: {
        webhooks?: Webhook[];
        testReply?: (id: string) => { status: number; body: string };
        testThrows?: boolean;
    } = {}
) {
    const hooks = new Map<string, Webhook>();
    for (const w of opts.webhooks ?? []) hooks.set(w.id, { ...w });
    const testCalls: string[] = [];
    // The request bodies the UI sent, so a test can assert what a save
    // actually transmitted — "which fields reached the wire" is the whole
    // contract for the keep/replace/clear header semantics.
    const createBodies: Record<string, unknown>[] = [];
    const patchBodies: { id: string; body: Record<string, unknown> }[] = [];


    const reply = (route: Route, status: number, body?: unknown) =>
        route.fulfill({
            status,
            contentType: 'application/json',
            body: body === undefined ? '' : JSON.stringify(body)
        });

    page.route('**/v1/me/outbound-webhooks**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const raw = request.postData();
        let body: Record<string, unknown> | undefined;
        if (raw) { try { body = JSON.parse(raw); } catch { /* not json */ } }

        // /v1/me/outbound-webhooks/:id/test
        if (path.endsWith('/test')) {
            const id = path.split('/').at(-2) ?? '';
            testCalls.push(id);
            if (opts.testThrows) {
                return reply(route, 502, {
                    title: 'Bad Gateway',
                    detail: 'Test delivery failed before any reply: ECONNREFUSED'
                });
            }
            const r = opts.testReply?.(id) ?? { status: 200, body: 'accepted' };
            return reply(route, 200, {
                ok: r.status >= 200 && r.status < 300,
                status: r.status,
                elapsedMs: 42,
                reply: r.body,
                truncated: r.body.length > 300,
                sentAt: new Date().toISOString()
            });
        }

        if (request.method() === 'GET') {
            return reply(route, 200, { webhooks: [...hooks.values()], limit: LIMIT });
        }

        if (request.method() === 'POST') {
            createBodies.push(body ?? {});
            const n = hooks.size + 1;
            const created: Webhook = {
                id: `wh${n}`,
                label: String(body?.label ?? 'Untitled'),
                url: String(body?.url ?? ''),
                keep: body?.keep !== false,
                prepend: String(body?.prepend ?? ''),
                mailbox: `.wh-wh${n}`,
                createdAt: Date.now(),
                lastUsedAt: null,
                headerNames: headerNames(body?.headers)
            };
            hooks.set(created.id, created);
            return reply(route, 201, { ...created, secret: 'deadbeefsecret' });
        }

        if (request.method() === 'PATCH') {
            const id = path.split('/').pop() ?? '';
            const existing = hooks.get(id);
            if (!existing) return reply(route, 404, { title: 'Not Found' });
            patchBodies.push({ id, body: body ?? {} });
            // Absent `headers` = unchanged; anything else (incl. {}) is a
            // full replace — the same contract the real PATCH documents.
            const names = body && 'headers' in body ? headerNames(body.headers) : existing.headerNames;
            const updated: Webhook = { ...existing, ...body, headerNames: names };
            hooks.set(id, updated);
            return reply(route, 200, updated);
        }

        return reply(route, 404, { title: 'Not Found' });
    });

    return { hooks, testCalls, createBodies, patchBodies };
}

function wh(over: Partial<Webhook> & { id: string }): Webhook {
    return {
        label: 'Agent',
        url: 'https://receiver.example/hook',
        keep: true,
        prepend: '',
        mailbox: `.wh-${over.id}`,
        createdAt: Date.now(),
        lastUsedAt: null,
        ...over
    };
}

async function openPanel(page: Page) {
    await login(page);
    // Settings is a modal that must be OPENED before its rail is reachable.
    // Clicking the tab straight after login waits forever for a rail that is
    // not mounted — which is how all 8 tests in this file first failed.
    await page.getByTestId('settings-btn').click();
    await page.getByTestId('settings-tab-outbound-hooks').click();
    await expect(page.locator('[data-testid=settings-outbound-hooks]')).toBeVisible();
    // The configured-webhooks list and the create form are both collapsibles,
    // closed by default, so anything asserting on their contents has to
    // expand them first.
    await expandCollapsibles(page);
}

/** Open every `.collapse-header` button inside the settings panel. */
async function expandCollapsibles(page: Page) {
    const headers = page.locator('[data-testid=settings-outbound-hooks] .collapse-header');
    for (let i = 0; i < (await headers.count()); i++) {
        const h = headers.nth(i);
        if ((await h.getAttribute('aria-expanded')) === 'false') await h.click();
    }
    await page.waitForTimeout(150);
}

test('the list shows each webhook with its URL, headers and last-used', async ({ page }) => {
    await applyMocks(page);
    installWebhookApi(page, {
        webhooks: [
            wh({ id: 'a1', label: 'Never used', url: 'https://one.example/h' }),
            wh({
                id: 'b2',
                label: 'Used once',
                url: 'https://two.example/h',
                lastUsedAt: Date.now() - 60_000,
                headerNames: ['Authorization']
            })
        ]
    });
    await openPanel(page);

    // A webhook that has never fired must say so in words, not show a raw
    // epoch or an empty line — "has any rule ever pointed at this?" is the
    // first question this panel answers.
    await expect(page.locator('[data-testid=ow-lastused-a1]')).toHaveText(/never delivered to/i);
    await expect(page.locator('[data-testid=ow-lastused-b2]')).toContainText('last used');

    // Header names are the only thing the API returns for them (values are
    // write-only), and the absence of headers is stated rather than blank.
    await expect(page.locator('[data-testid=ow-headers-b2]')).toContainText('Authorization');
    await expect(page.locator('[data-testid=ow-item-a1]')).toContainText(/headers:\s*none/i);

    await expect(page.locator('[data-testid=ow-item-a1]')).toContainText('https://one.example/h');
    await expect(page.locator('[data-testid=ow-item-b2]')).toContainText('https://two.example/h');
});

test('a hundred webhooks stay navigable via the filter', async ({ page }) => {
    await applyMocks(page);
    installWebhookApi(page, {
        webhooks: Array.from({ length: 100 }, (_, i) =>
            wh({ id: `w${i}`, label: `Target ${i}`, url: `https://target${i}.example/hook` })
        )
    });
    await openPanel(page);

    // The count is in the header even before scrolling, so the size of the
    // configuration is never a mystery.
    await expect(page.locator('[data-testid=ow-list-toggle] .count')).toContainText('100');

    // The filter only appears once the list is long enough to need it.
    const filter = page.locator('[data-testid=ow-search]');
    await expect(filter).toBeVisible();
    await filter.fill('Target 42');
    await expect(page.locator('[data-testid=ow-list] > li')).toHaveCount(1);
    await expect(page.locator('[data-testid=ow-list] > li')).toContainText('Target 42');

    // A miss is stated rather than showing an empty box.
    await filter.fill('no such target');
    await expect(page.locator('[data-testid=ow-list-empty]')).toBeVisible();
    await expect(page.locator('[data-testid=ow-list] > li')).toHaveCount(0);
});

test('Send test reports the receiver status and reply body in the card', async ({ page }) => {
    await applyMocks(page);
    const api = installWebhookApi(page, {
        webhooks: [wh({ id: 'a1', label: 'Agent' })],
        testReply: () => ({ status: 202, body: '{"queued":"evt-9"}' })
    });
    await openPanel(page);

    await page.click('[data-testid=ow-test-a1]');

    // The reply has to survive in the card, not flash past in a toast: it is
    // the thing being debugged and people copy it out of it.
    const result = page.locator('[data-testid=ow-test-result-a1]');
    await expect(result).toBeVisible();
    await expect(result).toContainText('202');
    await expect(page.locator('[data-testid=ow-test-reply-a1]')).toHaveText('{"queued":"evt-9"}');
    expect(api.testCalls).toEqual(['a1']);
});

test('a rejecting receiver is shown as a result, not swallowed as success', async ({ page }) => {
    await applyMocks(page);
    installWebhookApi(page, {
        webhooks: [wh({ id: 'a1' })],
        testReply: () => ({ status: 401, body: 'bad or missing bearer token' })
    });
    await openPanel(page);

    await page.click('[data-testid=ow-test-a1]');
    const result = page.locator('[data-testid=ow-test-result-a1]');
    await expect(result).toBeVisible();
    await expect(result).toContainText('401');
    // The body is the diagnosis — an auth failure with no message is a
    // support ticket waiting to happen.
    await expect(page.locator('[data-testid=ow-test-reply-a1]')).toContainText('bad or missing bearer token');
});

test('a long reply is labelled as truncated rather than shown in full', async ({ page }) => {
    await applyMocks(page);
    installWebhookApi(page, {
        webhooks: [wh({ id: 'a1' })],
        testReply: () => ({ status: 200, body: 'y'.repeat(1200) })
    });
    await openPanel(page);

    await page.click('[data-testid=ow-test-a1]');
    await expect(page.locator('[data-testid=ow-test-result-a1]')).toContainText(/first 300 chars/i);
});

test('a failed test send surfaces the server error and no stale result', async ({ page }) => {
    await applyMocks(page);
    installWebhookApi(page, { webhooks: [wh({ id: 'a1' })], testThrows: true });
    await openPanel(page);

    await page.click('[data-testid=ow-test-a1]');
    await expect(page.locator('[data-testid=ow-test-result-a1]')).toHaveCount(0);
    await expect(page.locator('[role=alert], [role=status]')).toContainText(/ECONNREFUSED|before any reply/i);
});

test('the test result can be dismissed', async ({ page }) => {
    await applyMocks(page);
    installWebhookApi(page, { webhooks: [wh({ id: 'a1' })] });
    await openPanel(page);

    await page.click('[data-testid=ow-test-a1]');
    await expect(page.locator('[data-testid=ow-test-result-a1]')).toBeVisible();
    await page.click('[data-testid=ow-test-dismiss-a1]');
    await expect(page.locator('[data-testid=ow-test-result-a1]')).toHaveCount(0);
});

test('details reveal the rule action and the hidden mailbox', async ({ page }) => {
    await applyMocks(page);
    installWebhookApi(page, { webhooks: [wh({ id: 'a1', prepend: 'triage inbox' })] });
    await openPanel(page);

    await page.click('[data-testid=ow-details-a1]');
    const details = page.locator('[data-testid=ow-details-body-a1]');
    await expect(details).toBeVisible();
    // A hand-built rule needs the id; hunting it elsewhere is miserable.
    await expect(details).toContainText('{"type":"webhook","webhookId":"a1"}');
    await expect(details).toContainText('.wh-a1');
});


test('creating a webhook sends its header rows and refuses a bad one', async ({ page }) => {
    await applyMocks(page);
    const api = installWebhookApi(page);
    await openPanel(page);

    await page.fill('[data-testid=ow-url]', 'https://agent.example/hook');
    await page.fill('[data-testid=ow-label]', 'Agent');
    await page.click('[data-testid=ow-header-add]');
    await page.fill('[data-testid=ow-header-name-0]', 'Authorization');
    await page.fill('[data-testid=ow-header-value-0]', 'Bearer crsr_secret');
    // A second row with a name that can never go on the wire: the save
    // must stop here, not reach the server with a partial map.
    await page.click('[data-testid=ow-header-add]');
    await page.fill('[data-testid=ow-header-name-1]', 'Host');
    await page.fill('[data-testid=ow-header-value-1]', 'evil.example');
    await page.click('[data-testid=ow-create]');

    await expect(page.locator('[data-testid=ow-header-errors]')).toContainText('reserved');
    expect(api.createBodies).toHaveLength(0);

    // Removing the bad row and saving again sends exactly the good map —
    // the row the user fixed is gone and nothing else is silently dropped.
    await page.click('[data-testid=ow-header-remove-1]');
    await page.click('[data-testid=ow-create]');
    expect(api.createBodies).toHaveLength(1);
    expect(api.createBodies[0]?.headers).toEqual({ Authorization: 'Bearer crsr_secret' });
});

test('editing headers replaces the map, and untouched rows keep it', async ({ page }) => {
    await applyMocks(page);
    const api = installWebhookApi(page, {
        webhooks: [wh({ id: 'a1', headerNames: ['Authorization', 'X-Tenant'] })]
    });
    await openPanel(page);

    // Open and save without touching a row: the PATCH must not carry a
    // `headers` field at all, or an open-and-save would replace two stored
    // credentials with blanks.
    await page.click('[data-testid=ow-headers-edit-a1]');
    await expect(page.locator('[data-testid=ow-a1-header-name-0]')).toHaveValue('Authorization');
    await page.click('[data-testid=ow-headers-save-a1]');
    expect(api.patchBodies).toHaveLength(0);

    // A real edit sends the WHOLE map: the seeded names with retyped
    // values, nothing left over from what the server had.
    await page.click('[data-testid=ow-headers-edit-a1]');
    await page.fill('[data-testid=ow-a1-header-value-0]', 'Bearer fresh');
    await page.fill('[data-testid=ow-a1-header-value-1]', 'acme');
    await page.click('[data-testid=ow-headers-save-a1]');
    expect(api.patchBodies).toHaveLength(1);
    expect(api.patchBodies[0]?.body.headers).toEqual({ Authorization: 'Bearer fresh', 'X-Tenant': 'acme' });

    // Deleting every row is the honest "clear them all": `{}`, not an
    // absent field, because absent would mean "unchanged".
    await page.click('[data-testid=ow-headers-edit-a1]');
    await page.click('[data-testid=ow-a1-header-remove-0]');
    await page.click('[data-testid=ow-a1-header-remove-0]');
    await page.click('[data-testid=ow-headers-save-a1]');
    expect(api.patchBodies).toHaveLength(2);
    expect(api.patchBodies[1]?.body.headers).toEqual({});
});