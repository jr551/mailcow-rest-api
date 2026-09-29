// Smoke spec for the topbar appearance picker. Kept separate from
// webmail.spec.ts because the picker is a component with its own keyboard
// and contrast contract, and a failure here should name the control rather
// than land in the middle of a 1500-line general suite.
//
// The colour assertions read the LIVE computed custom property off <html>
// rather than checking a class or an aria-checked flag, because the whole
// claim of this control is that picking a swatch actually repaints the app.
// A swatch that is selected but inert would pass every other assertion here.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { applyMocks, login } from './fixtures';

const ACCENT = (page: Page) =>
    page.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim());
const ACCENT_TEXT = (page: Page) =>
    page.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--accent-text').trim());
const DATA_THEME = (page: Page) =>
    page.locator('html').getAttribute('data-theme');

/** Parse an #rgb / #rrggbb / hsl() computed value into relative luminance. */
function luminance(value: string): number {
    let r = 0, g = 0, b = 0;
    if (value.startsWith('#')) {
        const raw = value.slice(1);
        const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
        if (full.length < 6) return NaN;
        r = parseInt(full.slice(0, 2), 16) / 255;
        g = parseInt(full.slice(2, 4), 16) / 255;
        b = parseInt(full.slice(4, 6), 16) / 255;
    } else {
        const m = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(value);
        if (!m) return NaN;
        const h = +m[1], s = +m[2] / 100, l = +m[3] / 100;
        const k = (n: number) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const c = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        r = c(0); g = c(8); b = c(4);
    }
    const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const ratio = (a: string, b: string) => {
    const la = luminance(a), lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
};

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
});

test('the picker retints the live app in BOTH modes, not just the chip', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await login(page);
    await page.getByTestId('theme-toggle').click();

    for (const mode of ['light', 'dark'] as const) {
        await page.getByTestId(`appearance-mode-${mode}`).click();
        expect(await DATA_THEME(page)).toBe(mode);

        await page.getByTestId('accent-teal').click();
        const surface = await page
            .locator('html')
            .evaluate((el) => getComputedStyle(el).getPropertyValue('--bg-surface').trim());

        // The claim under test: the accent actually landed on :root, and it
        // is legible against the surface of the mode we are actually in.
        const accentText = await ACCENT_TEXT(page);
        expect(accentText).toBeTruthy();
        expect(Number.isNaN(luminance(accentText))).toBe(false);
        expect(ratio(accentText, surface)).toBeGreaterThanOrEqual(4.5);

        // …and the Outlook command bar, which paints from --accent, is a
        // visible mark against the pane in this mode.
        const accent = await ACCENT(page);
        expect(ratio(accent, surface)).toBeGreaterThanOrEqual(3);
    }
});

test('every shipped swatch is legible on the surface it lands on, in both modes', async ({ page }) => {
    await login(page);
    await page.getByTestId('theme-toggle').click();

    const ids = ['sky', 'azure', 'teal', 'emerald', 'forest', 'amber', 'gold',
        'crimson', 'gmail', 'rose', 'plum', 'violet', 'indigo', 'slate'];

    for (const mode of ['light', 'dark'] as const) {
        await page.getByTestId(`appearance-mode-${mode}`).click();
        const surface = await page
            .locator('html')
            .evaluate((el) => getComputedStyle(el).getPropertyValue('--bg-surface').trim());
        for (const id of ids) {
            await page.getByTestId(`accent-${id}`).click();
            const text = await ACCENT_TEXT(page);
            expect(
                ratio(text, surface),
                `${id} in ${mode}: accent-text ${text} on ${surface} = ${ratio(text, surface).toFixed(2)}:1`
            ).toBeGreaterThanOrEqual(4.5);
        }
    }
});

test('the control is keyboard operable and returns focus on close', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('webmail.theme', 'light'));
    await login(page);

    const toggle = page.getByTestId('theme-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('appearance-panel')).toBeVisible();

    // Trap: Tab must never walk out of the panel while it is open. Step
    // well past its focusable count and confirm focus is still inside.
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid=appearance-panel]');
        return !!panel && panel.contains(document.activeElement);
    });
    expect(inside, 'Tab escaped the open panel').toBe(true);

    // Escape closes and hands focus back to the trigger.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('appearance-panel')).toBeHidden();
    await expect(toggle).toBeFocused();
});

test('the trigger announces its state and the swatches have real names', async ({ page }) => {
    await login(page);
    const toggle = page.getByTestId('theme-toggle');

    // Announced state, not a bare "settings" label.
    const before = (await toggle.getAttribute('aria-label')) ?? '';
    expect(before).toMatch(/Appearance/);
    expect(before).toMatch(/Light|Auto|Dark/);
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');

    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');

    // A real radiogroup, so a screen reader says which of the swatches is
    // current rather than announcing 14 unrelated buttons.
    const group = page.getByRole('radiogroup', { name: /Accent colour/ });
    await expect(group).toBeVisible();
    // The group names the skin the accent is being applied over, because the
    // same hex reads differently on Outlook and Gmail.
    await expect(group).toHaveAttribute('aria-label', /over the Outlook skin/);
    await expect(group.getByRole('radio', { name: 'Outlook blue, the Outlook default' })).toBeVisible();
});

test('the picker states which skin the accent is layered over', async ({ page }) => {
    await login(page);
    await page.getByTestId('theme-toggle').click();
    await expect(page.getByTestId('appearance-panel')).toContainText('over Outlook');

    // Switching skin re-labels it, because the accent means something else.
    await page.keyboard.press('Escape');
    await page.evaluate(() => localStorage.setItem('webmail.skin.v1', JSON.stringify({ skinId: 'gmail' })));
    await page.reload();
    await page.getByTestId('theme-toggle').click();
    await expect(page.getByTestId('appearance-panel')).toContainText('over Gmail');
});
