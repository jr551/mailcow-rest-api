// Address book (Slice A): the editable contacts UI, the IMAP-backed store,
// and the compose recipient picker.
//
// Each test here asserts behaviour a user would notice, not wiring. In
// particular the picker test drives the real keyboard and reads the real
// rendered rows, because the claim being made is that a friendly name is
// visible AND free-form typing still works — a datalist-style change that
// broke the second half would still pass a test that only clicked a row.
import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const FOLDER = '.book-addresses';

/**
 * Stand in for the server's contact store.
 *
 * Stateful on purpose: the "survives a reload" claim is only meaningful if
 * the mock is a real store that outlives the page, which is exactly what the
 * IMAP folder is. It also records every request, so the tests can assert
 * that an edit really did reach the API rather than only updating local
 * state.
 */
type Contact = { uid: string; address: string; name: string | null; note?: string | null; lastSeen: number; count: number };

function installContactApi(page: Page, opts: { fail?: boolean } = {}) {
    const store = new Map<string, Contact>();
    const calls: { method: string; url: string; body?: unknown }[] = [];
    let seq = 0;

    const reply = (route: Route, status: number, body?: unknown) =>
        route.fulfill({
            status,
            contentType: 'application/json',
            body: body === undefined ? '' : JSON.stringify(body)
        });

    page.route('**/v1/me/contacts**', async (route) => {
        const request = route.request();
        const method = request.method();
        const url = new URL(request.url()).pathname;
        const raw = request.postData();
        let body: Record<string, unknown> | undefined;
        if (raw) { try { body = JSON.parse(raw); } catch { /* not json */ } }
        calls.push({ method, url, body });

        if (opts.fail) return reply(route, 502, { title: 'IMAP backend unavailable', detail: 'Mailbox denied' });

        // /import
        if (url.endsWith('/import')) {
            const incoming = (body?.contacts as Contact[] | undefined) || [];
            let imported = 0;
            let skipped = 0;
            for (const c of incoming) {
                const key = c.address.toLowerCase();
                if (store.has(key)) continue;
                seq += 1;
                store.set(key, { ...c, uid: `srv-${seq}` });
                imported += 1;
            }
            for (const c of incoming) if (!c.address || !c.address.includes('@')) skipped += 1;
            return reply(route, 200, { imported, skipped, folder: FOLDER });
        }

        if (method === 'GET') {
            return reply(route, 200, { contacts: [...store.values()], folder: FOLDER });
        }
        if (method === 'POST') {
            seq += 1;
            const c: Contact = {
                uid: `srv-${seq}`,
                address: String(body?.address || ''),
                name: (body?.name as string) || null,
                note: (body?.note as string) || null,
                lastSeen: Number(body?.lastSeen) || 0,
                count: Number(body?.count) || 0
            };
            store.set(c.address.toLowerCase(), c);
            return reply(route, 201, c);
        }
        if (method === 'PATCH') {
            const uid = decodeURIComponent(url.split('/').pop() || '');
            const existing = [...store.values()].find((c) => c.uid === uid);
            if (!existing) return reply(route, 404, { title: 'Not Found' });
            const next: Contact = {
                ...existing,
                address: (body?.address as string) || existing.address,
                name: body?.name === undefined ? existing.name : ((body.name as string) || null),
                note: body?.note === undefined ? existing.note : ((body.note as string) || null)
            };
            // An edit replaces the card, exactly like append+expunge.
            store.delete(existing.address.toLowerCase());
            store.set(next.address.toLowerCase(), next);
            return reply(route, 200, next);
        }
        if (method === 'DELETE') {
            const uid = decodeURIComponent(url.split('/').pop() || '');
            for (const [k, c] of store) if (c.uid === uid) store.delete(k);
            return reply(route, 204);
        }
        return reply(route, 405, { title: 'Method Not Allowed' });
    });

    return { store, calls };
}

// The list deliberately contains BOTH saved contacts and people harvested
// from the user's own mail, so these helpers scope to a single address
// rather than counting rows — counting would assert the harvest is broken,
// which is the opposite of what we want.
function contactRow(page: Page, address: string) {
    return page.locator('[data-testid=contact-row]').filter({ hasText: address });
}

async function openPeople(page: Page) {
    await page.click('[data-testid=settings-btn]');
    await page.click('[data-testid=settings-tab-people]');
    await page.waitForSelector('[data-testid=settings-people]');
}

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    installContactApi(page);
});

test('contacts survive a reload and are editable by name and address', async ({ page }) => {
    await login(page);
    await openPeople(page);

    await page.fill('[data-testid=contact-name-input]', 'Ada Lovelace');
    await page.fill('[data-testid=contact-address-input]', 'ada@example.com');
    await page.click('[data-testid=contact-save]');
    await expect(contactRow(page, 'ada@example.com')).toHaveCount(1);
    await expect(contactRow(page, 'ada@example.com')).toContainText('Ada Lovelace');

    // RELOAD. This is the acceptance criterion: the book lives on the
    // server, not in this browser, so it comes back after a fresh profile.
    await page.reload();
    await page.waitForSelector('[data-testid=shell]');
    await openPeople(page);
    await expect(contactRow(page, 'ada@example.com')).toHaveCount(1);
    await expect(contactRow(page, 'ada@example.com')).toContainText('Ada Lovelace');

    // Edit: correct the address. The row must NOT be duplicated — identity
    // is the server uid, so this edits one person rather than replacing
    // them, which is the whole reason uid and not address is the key.
    await contactRow(page, 'ada@example.com').locator('[data-testid=contact-edit]').click();
    await expect(page.locator('[data-testid=contact-address-input]')).toHaveValue('ada@example.com');
    await page.fill('[data-testid=contact-address-input]', 'ada.lovelace@example.org');
    await page.fill('[data-testid=contact-name-input]', 'Ada L.');
    await page.click('[data-testid=contact-save]');

    await expect(contactRow(page, 'ada.lovelace@example.org')).toHaveCount(1);
    await expect(contactRow(page, 'ada.lovelace@example.org')).toContainText('Ada L.');
    // The old address is gone, and no second row appeared for the new one.
    await expect(contactRow(page, 'ada@example.com')).toHaveCount(0);

    // And the edit is really on the server: it survives another reload.
    await page.reload();
    await page.waitForSelector('[data-testid=shell]');
    await openPeople(page);
    await expect(contactRow(page, 'ada.lovelace@example.org')).toHaveCount(1);
});

test('deleting a contact removes it for good, not just from this view', async ({ page }) => {
    await login(page);
    await openPeople(page);
    await page.fill('[data-testid=contact-address-input]', 'grace@example.com');
    await page.click('[data-testid=contact-save]');
    await expect(contactRow(page, 'grace@example.com')).toHaveCount(1);

    await contactRow(page, 'grace@example.com').locator('[data-testid=contact-delete]').click();
    await expect(contactRow(page, 'grace@example.com')).toHaveCount(0);

    await page.reload();
    await page.waitForSelector('[data-testid=shell]');
    await openPeople(page);
    await expect(contactRow(page, 'grace@example.com')).toHaveCount(0);
});

test('a duplicate address is refused rather than silently creating a second row', async ({ page }) => {
    await login(page);
    await openPeople(page);
    await page.fill('[data-testid=contact-address-input]', 'dup@example.com');
    await page.click('[data-testid=contact-save]');
    await expect(contactRow(page, 'dup@example.com')).toHaveCount(1);

    // Case-insensitively the same person.
    await page.fill('[data-testid=contact-address-input]', 'DUP@example.com');
    await page.click('[data-testid=contact-save]');
    await expect(page.locator('[data-testid=contact-error]')).toBeVisible();
    await expect(contactRow(page, 'dup@example.com')).toHaveCount(1);
});

test('an unusable address is refused with a message', async ({ page }) => {
    await login(page);
    await openPeople(page);
    await page.fill('[data-testid=contact-address-input]', 'not-an-email');
    await page.click('[data-testid=contact-save]');
    await expect(page.locator('[data-testid=contact-error]')).toBeVisible();
    await expect(page.locator('[data-testid=contact-row]').filter({ hasText: 'not-an-email' })).toHaveCount(0);
});

test('when the IMAP store is unavailable the fallback is stated, not silent', async ({ page }) => {
    // A book already captured locally, with the server refusing every
    // contacts call — the degraded state a user on a flaky connection or
    // behind an older server sees.
    await page.addInitScript(() => {
        localStorage.setItem('webmail.address-book.v2', JSON.stringify({
            contacts: [{
                uid: 'local-1', address: 'offline@example.com', name: 'Offline Person',
                lastSeen: Date.now(), count: 3
            }],
            fromLegacy: false
        }));
    });
    installContactApi(page, { fail: true });
    await login(page);
    await openPeople(page);

    // The banner must be visible: a silent fallback would leave the user
    // believing their contacts are synced when they are not.
    await expect(page.locator('[data-testid=contacts-store-warning]')).toBeVisible();
    await expect(page.locator('[data-testid=contacts-store-warning]')).toContainText('Not syncing');
    // …and the locally captured contact is still there. Nothing is lost.
    await expect(contactRow(page, 'offline@example.com')).toHaveCount(1);
    await expect(contactRow(page, 'offline@example.com')).toContainText('Offline Person');

    // A contact added while degraded must also work, and must not be lost.
    await page.fill('[data-testid=contact-address-input]', 'added-while-down@example.com');
    await page.click('[data-testid=contact-save]');
    await expect(contactRow(page, 'added-while-down@example.com')).toHaveCount(1);
    await expect(page.locator('[data-testid=contacts-store-warning]')).toBeVisible();
});

test('compose suggests a friendly name and still accepts free-form typing', async ({ page }) => {
    await login(page);
    await openPeople(page);
    await page.fill('[data-testid=contact-name-input]', 'Ada Lovelace');
    await page.fill('[data-testid=contact-address-input]', 'ada@example.com');
    await page.click('[data-testid=contact-save]');
    await expect(contactRow(page, 'ada@example.com')).toHaveCount(1);
    await page.click('[data-testid=settings-done]');

    await page.click('[data-testid=compose-btn]');
    await page.waitForSelector('[data-testid=compose-to]');
    // Type the contact's own address prefix. The picker also lists people
    // harvested from the fixture mail, so the assertion has to isolate the
    // saved contact rather than assume it is the only match.
    await page.fill('[data-testid=compose-to]', 'ada@');

    await expect(page.locator('[data-testid=compose-suggest-list]')).toBeVisible();
    // The friendly name is the PRIMARY line — the whole point of replacing
    // the datalist, which could not show it reliably.
    const row = page.locator('[data-testid=compose-suggest]').filter({ hasText: 'ada@example.com' }).first();
    await expect(row.locator('.rs-name')).toHaveText('Ada Lovelace');
    await expect(row.locator('.rs-meta')).toHaveText('ada@example.com');

    // Clicking a suggestion turns it into a pill carrying the friendly name.
    await row.click();
    const chip = page.locator('[data-testid=compose-to-chip]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText('ada@example.com');
    await expect(chip).toContainText('Ada Lovelace');

    // FREE-FORM TYPING STILL WORKS. An address nobody has ever sent to is
    // accepted and committed, with no suggestion forced on the user.
    await page.fill('[data-testid=compose-to]', 'brand-new-person@nowhere.test');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid=compose-to-chip]')).toHaveCount(2);
    await expect(page.locator('[data-testid=compose-to-chip]').nth(1))
        .toContainText('brand-new-person@nowhere.test');
});

test('compose suggests people seen in past mail, not only saved contacts', async ({ page }) => {
    await login(page);
    // Harvest is passive: it happens as envelopes render. The list renders
    // on login, so whatever the picker offers came from real mail.
    await page.waitForTimeout(1500);

    await page.click('[data-testid=compose-btn]');
    await page.waitForSelector('[data-testid=compose-to]');
    // A prefix matching no saved name, so any hit came from the harvest.
    await page.fill('[data-testid=compose-to]', 'e');
    await expect(page.locator('[data-testid=compose-suggest-list]')).toBeVisible();
    const count = await page.locator('[data-testid=compose-suggest]').count();
    expect(count).toBeGreaterThan(0);
    // Every row carries a visible secondary line.
    await expect(page.locator('[data-testid=compose-suggest] .rs-meta').first()).not.toBeEmpty();
});

test('arrow keys move the highlight and Enter picks the highlighted contact', async ({ page }) => {
    await login(page);
    await openPeople(page);
    // A shared prefix no fixture-mail address can match, so these two are
    // the only candidates and ArrowDown has a well-defined target.
    for (const [name, addr] of [['Alpha One', 'alpha@zzpick.test'], ['Beta Two', 'beta@zzpick.test']]) {
        await page.fill('[data-testid=contact-name-input]', name);
        await page.fill('[data-testid=contact-address-input]', addr);
        await page.click('[data-testid=contact-save]');
    }
    await expect(contactRow(page, 'alpha@zzpick.test')).toHaveCount(1);
    await expect(contactRow(page, 'beta@zzpick.test')).toHaveCount(1);
    await page.click('[data-testid=settings-done]');

    await page.click('[data-testid=compose-btn]');
    await page.waitForSelector('[data-testid=compose-to]');
    await page.fill('[data-testid=compose-to]', 'zzpick');
    await expect(page.locator('[data-testid=compose-suggest-list]')).toBeVisible();

    const rows = page.locator('[data-testid=compose-suggest]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    const highlighted = (await rows.nth(1).locator('.rs-meta').textContent()) || '';

    await page.keyboard.press('Enter');
    const chip = page.locator('[data-testid=compose-to-chip]');
    await expect(chip).toHaveCount(1);
    // The chip holds the address of the row that was highlighted, which is
    // the second one — proving Enter followed the highlight rather than
    // simply taking whatever happened to be first.
    await expect(chip).toContainText(highlighted.trim());
});
