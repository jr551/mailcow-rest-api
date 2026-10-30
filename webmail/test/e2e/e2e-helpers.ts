import type { Page } from '@playwright/test';
import { fixtureMessages } from './fixture-messages';
import { inboxBucketForMessage, type InboxBucket } from '../../src/lib/focused-inbox';

export const SETTINGS_STORAGE_KEY = 'webmail.settings.v1';

/** Merge keys into the persisted settings blob before the app boots. */
export async function seedWebmailSettings(page: Page, partial: Record<string, unknown>) {
    await page.addInitScript(
        ({ key, partial }) => {
            let base: Record<string, unknown> = {};
            try {
                base = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>;
            } catch {
                base = {};
            }
            localStorage.setItem(key, JSON.stringify({ ...base, ...partial }));
        },
        { key: SETTINGS_STORAGE_KEY, partial }
    );
}

export async function enableAiFeatures(page: Page) {
    await seedWebmailSettings(page, { aiFeatures: true });
}

export async function clickInboxTab(page: Page, tab: InboxBucket) {
    const testId = tab === 'focused' ? 'inbox-tab-focused' : 'inbox-tab-other';
    const tabBtn = page.getByTestId(testId);
    if (await tabBtn.isVisible()) {
        await tabBtn.click();
    }
}

function bucketForUid(uid: number): InboxBucket {
    const msg = fixtureMessages.find((m) => m.uid === uid);
    if (!msg) return 'focused';
    return inboxBucketForMessage(msg as Parameters<typeof inboxBucketForMessage>[0]);
}

/** Open a list row that may live on the Focused or Other INBOX tab. */
export async function openMessageByUid(page: Page, uid: number) {
    const tab = bucketForUid(uid);
    await clickInboxTab(page, tab);
    await page.getByTestId(`msg-row-${uid}`).click();
}

/** Right-click the first visible row, switching to Other when Focused is empty. */
export async function openContextMenuOnFirstRow(page: Page) {
    let rows = page.locator('.row');
    if ((await rows.count()) === 0) {
        await clickInboxTab(page, 'other');
        rows = page.locator('.row');
    }
    await rows.first().click({ button: 'right' });
}
