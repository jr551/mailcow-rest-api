import { test, expect } from '@playwright/test';
import { applyMocks, detailFor1001, login, MOCK_PASS, MOCK_USER } from './fixtures';

test('narrow desktop sidebar keeps names and reveals footer controls on focus', async ({ page }) => {
    await applyMocks(page);
    await page.setViewportSize({ width: 700, height: 800 });
    await login(page);

    await expect(page.getByTestId('compose-btn')).toHaveAttribute('aria-label', 'Compose new message');
    await expect(page.getByTestId('folder-INBOX')).toHaveAttribute('aria-label', 'Inbox');
    const newFolder = page.getByTestId('sidebar-new-folder');
    await newFolder.focus();
    await expect.poll(() => newFolder.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe('1');
});

test('inbox status accents stay static and selection remains the strongest row state', async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await login(page);

    const starred = page.locator('.row.starred').first();
    const tracked = page.locator('.row.spy-tracked').first();
    await expect(starred).toBeVisible();
    await expect(tracked).toBeVisible();
    await expect.poll(() => starred.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await expect.poll(() => tracked.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await expect.poll(() =>
        starred.locator('.icon-btn.star-on').evaluate((el) => getComputedStyle(el).animationName)
    ).toBe('none');

    const selected = page.getByTestId('msg-row-999');
    await selected.click();
    await expect(selected).toHaveClass(/selected/);
    await page.mouse.move(1279, 719);
    const expectedBackground = await page.locator('html').evaluate((html) => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = getComputedStyle(html).getPropertyValue('--bg-selected').trim();
        document.body.append(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
    });
    await expect.poll(() => selected.evaluate((el) => getComputedStyle(el).backgroundColor))
        .toBe(expectedBackground);
});

test('Outlook account identity remains legible on the command bar', async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await login(page);

    const account = page.locator('.topbar .user');
    await expect(account).toBeVisible();
    await expect.poll(() => account.evaluate((el) => getComputedStyle(el).color))
        .toBe('rgb(255, 255, 255)');
});

test('mobile inbox status accents stay static', async ({ page }) => {
    await applyMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/webmail/mobile/');
    await page.getByLabel('Email').fill(MOCK_USER);
    await page.locator('input[type="password"]').fill(MOCK_PASS);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();

    const tracked = page.locator('.msg-row.spy-tracked');
    await expect(tracked).toHaveCount(1);
    await expect.poll(() => tracked.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});

test('mobile HTML email links are allowed to open a new tab', async ({ page }) => {
    await applyMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/v1/mailboxes/INBOX/messages/1001', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ...detailFor1001,
                text: null,
                html: '<p>Hello <a href="https://example.com/article" target="_blank">article</a></p>'
            })
        });
    });

    await page.goto('/webmail/mobile/');
    await page.getByLabel('Email').fill(MOCK_USER);
    await page.locator('input[type="password"]').fill(MOCK_PASS);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.locator('.msg-row').first().click();
    const iframe = page.locator('iframe[title="Message body"]');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('sandbox', /allow-popups/);
    await expect(iframe).toHaveAttribute('sandbox', /allow-popups-to-escape-sandbox/);
});
