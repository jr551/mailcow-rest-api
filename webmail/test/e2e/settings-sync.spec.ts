import { test, expect, type Page } from '@playwright/test';
import { applyMocks, login } from './fixtures';

// Cross-device settings sync (webmail/src/lib/settings-sync.ts) writes one
// JSON snapshot as an RFC822 message into the hidden IMAP folder
// `.storage_webmailsettings`. The LLM API key is device-local: it must never
// be serialised into the mailbox, a pulled snapshot must never overwrite the
// key this device holds, and snapshots written before that rule are scrubbed
// from the folder once a clean replacement is safely in place.
//
// These specs drive the real app (real settings store, real sync module) and
// only mock the HTTP surface. The settings module reads localStorage once at
// module init, so the seed has to land before any script runs — hence
// addInitScript rather than goto + localStorage.

const SETTINGS_KEY = 'webmail.settings.v1';
const SYNC_FOLDER = '.storage_webmailsettings';

// applyMocks() only handles GET /v1/mailboxes and route.continue()s every
// other method, so the folder-create POST and the whole sync-folder surface
// have to be mocked here. These routes are registered AFTER applyMocks so
// they win the (reverse-registration) match order.
const SYNC_MESSAGES_RE = /\/v1\/mailboxes\/\.storage_webmailsettings\/messages/;
const MAILBOXES_RE = /\/v1\/mailboxes$/;

interface SyncMessage {
    uid: number;
    internalDate: string;
    raw: string;
}

interface SyncTraffic {
    /** Raw bodies of every append (POST .../messages) the app made. */
    appends: string[];
    /** Pathnames of every DELETE .../messages/<uid> the app made. */
    deletes: string[];
    /** Interleaved order of the two, so a test can assert the scrub only
     *  happens after a clean snapshot was written. */
    order: Array<'append' | 'delete'>;
}

/** Build the RFC822 text the module expects: plain headers, blank line, JSON. */
function rfc822(json: unknown, ts: number): string {
    const date = new Date(ts).toUTCString();
    return [
        `Date: ${date}`,
        'From: demo@test.local',
        'To: demo@test.local',
        'Subject: webmail-settings-v1',
        'Message-ID: <webmail-settings-test@test.local>',
        'MIME-Version: 1.0',
        'Content-Type: application/json; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        JSON.stringify(json)
    ].join('\r\n');
}

/** Seed the settings blob before any app script runs. */
async function seedSettings(page: Page, blob: unknown) {
    await page.addInitScript(
        ([key, json]) => {
            localStorage.setItem(key as string, json as string);
        },
        [SETTINGS_KEY, JSON.stringify(blob)] as const
    );
}

/** Mock the sync folder. `messages` is what the folder already contains. */
async function mockSyncFolder(page: Page, opts: { messages: SyncMessage[] }): Promise<SyncTraffic> {
    const traffic: SyncTraffic = { appends: [], deletes: [], order: [] };

    // Folder create: POST /v1/mailboxes. Any 2xx/4xx counts as "exists".
    await page.route(MAILBOXES_RE, (route, request) => {
        if (request.method() !== 'POST') return route.continue();
        route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({ path: SYNC_FOLDER })
        });
    });

    await page.route(SYNC_MESSAGES_RE, (route, request) => {
        const url = new URL(request.url());
        const method = request.method();

        // GET .../messages/<uid>/raw
        if (url.pathname.endsWith('/raw')) {
            const uid = Number(url.pathname.split('/').slice(-2)[0]);
            const m = opts.messages.find((x) => x.uid === uid);
            if (!m) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
            return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: m.raw });
        }

        // POST .../messages?internalDate=...  (append)
        if (method === 'POST') {
            traffic.appends.push(request.postData() ?? '');
            traffic.order.push('append');
            return route.fulfill({
                status: 201,
                contentType: 'application/json',
                body: JSON.stringify({ path: SYNC_FOLDER, uid: 100, uidValidity: 1 })
            });
        }

        // DELETE .../messages/<uid>
        if (method === 'DELETE') {
            traffic.deletes.push(url.pathname);
            traffic.order.push('delete');
            return route.fulfill({ status: 204, body: '' });
        }

        // GET .../messages?page=0&pageSize=50  (list)
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                messages: opts.messages.map((m) => ({
                    uid: m.uid,
                    internalDate: m.internalDate,
                    envelope: { date: m.internalDate }
                }))
            })
        });
    });

    return traffic;
}

function readSettings(page: Page) {
    return page.evaluate((key) => {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    }, SETTINGS_KEY);
}

test.describe('Settings sync — device-local LLM API key', () => {
    test('push strips the device-local LLM API key', async ({ page }) => {
        await seedSettings(page, {
            llm: { kind: 'openai', preset: '', apiKey: 'sk-live-secret', baseUrl: '', model: 'gpt-4o-mini' },
            useCustomLlm: true,
            density: 'compact',
            pageSize: 25
        });

        await applyMocks(page);
        // Empty folder → first sync pushes immediately (no debounce).
        const traffic = await mockSyncFolder(page, { messages: [] });

        const appendReq = page.waitForRequest(
            (r) => r.method() === 'POST' && r.url().includes(`/v1/mailboxes/${SYNC_FOLDER}/messages`)
        );
        await login(page);
        const req = await appendReq;
        const body = req.postData() ?? '';

        // Non-vacuity: the append must actually have happened with a body.
        // If the mock never fired, waitForRequest would time out and the test
        // would fail rather than pass on an empty string.
        expect(body.length).toBeGreaterThan(0);
        await expect.poll(() => traffic.appends.length).toBeGreaterThan(0);

        // The secret must not travel...
        expect(body).not.toContain('apiKey');
        expect(body).not.toContain('sk-live-secret');
        // ...but the rest of the snapshot must. `"llm"` proves the llm object
        // is serialised at all — so an unstripped apiKey would necessarily
        // appear in this same body.
        expect(body).toContain('"llm"');
        expect(body).toContain('gpt-4o-mini');
        expect(body).toContain('compact');
    });

    test('a pulled snapshot never overwrites the key this device holds', async ({ page }) => {
        await seedSettings(page, {
            llm: { kind: 'openai', preset: '', apiKey: 'sk-local', baseUrl: '', model: 'local-model' },
            useCustomLlm: true,
            density: 'comfortable'
        });

        const ts = Date.now() + 1000;
        const remote = {
            v: 1,
            ts,
            settings: {
                llm: { kind: 'openai', preset: '', apiKey: 'sk-remote', baseUrl: '', model: 'remote-model' },
                density: 'compact'
            }
        };

        await applyMocks(page);
        await mockSyncFolder(page, {
            messages: [{ uid: 7, internalDate: new Date(ts).toISOString(), raw: rfc822(remote, ts) }]
        });

        await login(page);

        // applySnapshot mirrors the merge to localStorage; wait for it.
        await expect.poll(async () => (await readSettings(page))?.density).toBe('compact');

        const stored = await readSettings(page);
        expect(stored).not.toBeNull();
        // The local key survives — the remote's key is never adopted.
        expect(stored.llm.apiKey).toBe('sk-local');
        // Non-secret remote fields win.
        expect(stored.llm.model).toBe('remote-model');
        expect(stored.density).toBe('compact');
    });

    test('legacy snapshots that carry a key are scrubbed from the folder', async ({ page }) => {
        await seedSettings(page, {
            llm: { kind: 'openai', preset: '', apiKey: 'sk-local', baseUrl: '', model: 'local-model' },
            useCustomLlm: true,
            density: 'comfortable'
        });

        const ts = Date.now() + 1000;
        const remote = {
            v: 1,
            ts,
            settings: {
                llm: { kind: 'openai', preset: '', apiKey: 'sk-remote', baseUrl: '', model: 'remote-model' },
                density: 'compact'
            }
        };

        await applyMocks(page);
        const traffic = await mockSyncFolder(page, {
            messages: [{ uid: 7, internalDate: new Date(ts).toISOString(), raw: rfc822(remote, ts) }]
        });

        const appendReq = page.waitForRequest(
            (r) => r.method() === 'POST' && r.url().includes(`/v1/mailboxes/${SYNC_FOLDER}/messages`)
        );
        const deleteReq = page.waitForRequest(
            (r) => r.method() === 'DELETE' && r.url().includes(`/v1/mailboxes/${SYNC_FOLDER}/messages/7`)
        );

        await login(page);
        const append = await appendReq;
        await deleteReq;

        const body = append.postData() ?? '';
        // Non-vacuity: both requests must have been observed.
        expect(body.length).toBeGreaterThan(0);
        await expect.poll(() => traffic.appends.length).toBeGreaterThan(0);
        await expect.poll(() => traffic.deletes.length).toBeGreaterThan(0);

        // (a) the replacement snapshot carries no key...
        expect(body).not.toContain('apiKey');
        expect(body).not.toContain('sk-remote');
        expect(body).toContain('"llm"');
        // (b) ...and the legacy snapshot was deleted.
        expect(traffic.deletes.some((p) => p.endsWith('/messages/7'))).toBe(true);

        // Ordering: the scrub only runs after a clean snapshot is safely
        // written, so the append must precede the delete.
        const appendAt = traffic.order.indexOf('append');
        const deleteAt = traffic.order.indexOf('delete');
        expect(appendAt).toBeGreaterThanOrEqual(0);
        expect(deleteAt).toBeGreaterThan(appendAt);
    });
});
