import { test, expect, type Page } from '@playwright/test';
import { applyMocks, login } from './fixtures';

// skins.svelte.ts reads localStorage at module init, so the seeded blob has to
// land before any script runs — hence addInitScript rather than goto +
// localStorage, which would already be too late.
const SKIN_KEY = 'webmail.skin.v1';
const SETTINGS_KEY = 'webmail.settings.v1';

async function seedSkin(page: Page, skinId: string) {
    await page.addInitScript(
        ([skinKey, settingsKey, skin]) => {
            localStorage.setItem(skinKey as string, skin as string);
            localStorage.setItem(settingsKey as string, JSON.stringify({}));
        },
        [
            SKIN_KEY,
            SETTINGS_KEY,
            JSON.stringify({ skinId, customAccent: '#5b8def', semantics: {}, customCss: '' })
        ] as const
    );
}

// Luminance of an rgb() string, per WCAG. Anything a dark skin should own is
// well under 0.2; the topbar is the deliberate exception.
function luminance(rgb: string): number {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
    const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function bg(page: Page, selector: string): Promise<string> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`no element matched ${sel}`);
        return getComputedStyle(el).backgroundColor;
    }, selector);
}

test.describe('Outlook Dark skin', () => {
    test('applies the skin-outlook-dark class and paints dark surfaces', async ({ page }) => {
        await applyMocks(page);
        await seedSkin(page, 'outlook-dark');
        await login(page);

        await expect(page.locator('html')).toHaveClass(/skin-outlook-dark/);

        // The custom properties the skin declares must have reached <html>.
        const vars = await page.evaluate(() => {
            const s = getComputedStyle(document.documentElement);
            return {
                base: s.getPropertyValue('--bg-base').trim(),
                primary: s.getPropertyValue('--text-primary').trim()
            };
        });
        expect(vars.base).toBe('#1f1f1f');
        expect(vars.primary).toBe('#f3f2f1');

        const topbar = await bg(page, '.topbar');
        expect(luminance(topbar)).toBeLessThan(0.5);
        expect(luminance(topbar)).toBeGreaterThan(0.05);
        // Blue dominant: the blue channel beats red, so it isn't a washed grey.
        const [tr, , tb] = topbar.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
        expect(tb).toBeGreaterThan(tr);

        // Body text on the dark list is near-white, i.e. high contrast.
        const text = await page.evaluate(() => {
            const el = document.querySelector('.list .row') ?? document.querySelector('.list');
            return getComputedStyle(el!).color;
        });
        expect(luminance(text)).toBeGreaterThan(0.6);
    });

    test('is offered by the skin picker alongside the light Outlook skin', async ({ page }) => {
        await applyMocks(page);
        await seedSkin(page, 'outlook-dark');
        await login(page);

        await page.click('[data-testid=settings-btn]');
        await page.click('[data-testid=settings-tab-appearance]');
        await expect(page.getByTestId('skin-outlook-dark')).toBeVisible();
        await expect(page.getByTestId('skin-outlook')).toBeVisible();
        // Dark navy swatch, not a re-used light blue.
        const swatch = await page
            .getByTestId('skin-outlook-dark')
            .locator('.swatch')
            .evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(swatch).toBe('rgb(31, 43, 61)');
    });
});
