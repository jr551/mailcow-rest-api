import { test, expect, type Page } from '@playwright/test';
import { applyMocks, login } from './fixtures';

// The settings and skin modules load() once at module init, so the seeded
// blobs have to land before any script runs — hence addInitScript rather
// than goto + localStorage, which would already be too late.
const SETTINGS_KEY = 'webmail.settings.v1';
const SKIN_KEY = 'webmail.skin.v1';

// The chip polls Open-Meteo and reverse-geocodes on mount. These specs
// assert on the chip's chrome and its menu, never on forecast data, so
// stub both endpoints and keep the run off the network.
async function stubWeather(page: Page) {
    await page.route('**/api.open-meteo.com/v1/forecast*', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                current: {
                    temperature_2m: 11.4,
                    apparent_temperature: 10.1,
                    wind_speed_10m: 14.2,
                    weather_code: 3,
                    is_day: 1
                },
                daily: {
                    time: ['2026-09-27', '2026-09-28', '2026-09-29'],
                    weather_code: [3, 61, 2],
                    temperature_2m_max: [17, 15, 18],
                    temperature_2m_min: [9, 8, 10]
                }
            })
        });
    });
    await page.route('**/geocoding-api.open-meteo.com/v1/search*', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ results: [{ name: 'Lisbon' }] })
        });
    });
}

async function seed(
    page: Page,
    { skinId, weatherChip, weatherChipOutlook = false }:
        { skinId: string; weatherChip: boolean; weatherChipOutlook?: boolean }
) {
    await page.addInitScript(
        ([settingsKey, skinKey, settings, skin]) => {
            localStorage.setItem(settingsKey as string, settings as string);
            localStorage.setItem(skinKey as string, skin as string);
        },
        [
            SETTINGS_KEY,
            SKIN_KEY,
            JSON.stringify({ weatherChip, weatherChipOutlook }),
            JSON.stringify({ skinId, customAccent: '#0078d4', accentOverride: null, semantics: {}, semanticsEdited: false, customCss: '' })
        ] as const
    );
}

interface Rect { x: number; y: number; width: number; height: number }

// Read every rect in one round trip. Measuring inside the page (rather than
// with Playwright's boundingBox) keeps the menu and the chip in the same
// frame and the same instant — a between-call reflow or a scroll shift would
// otherwise make the comparison meaningless.
async function measure(page: Page) {
    return page.evaluate(() => {
        const rect = (sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        };
        return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            menu: rect('.weather-menu'),
            chip: rect('.weather-chip'),
            caret: rect('.weather-caret')
        };
    });
}

test.describe('Weather chip', () => {
    test('hidden on the Outlook skin unless the user opts in', async ({ page }) => {
        await applyMocks(page);
        await stubWeather(page);
        // weatherChip is on; only the per-skin opt-in is missing.
        await seed(page, { skinId: 'outlook', weatherChip: true });
        await login(page);
        await expect(page.locator('html')).toHaveClass(/skin-outlook/);
        await expect(page.getByTestId('weather-chip')).toHaveCount(0);
        await expect(page.locator('.weather-menu')).toHaveCount(0);
    });

    test('shows on the Outlook skin once opted in', async ({ page }) => {
        await applyMocks(page);
        await stubWeather(page);
        await seed(page, { skinId: 'outlook', weatherChip: true, weatherChipOutlook: true });
        await login(page);
        // The skin's extras CSS hides .weather-wrap !important; the opt-in
        // re-asserts it, so the chip must actually be visible.
        await expect(page.getByTestId('weather-chip')).toBeVisible();
    });

    test('shows on the Gmail skin with no opt-in — it does not hide the chips', async ({ page }) => {
        await applyMocks(page);
        await stubWeather(page);
        // Gmail's header is white and has room for the chip, so the setting
        // alone is enough. If a future skin re-hides these, this test is the
        // one that says the feature went missing.
        await seed(page, { skinId: 'gmail', weatherChip: true });
        await login(page);
        await expect(page.locator('html')).toHaveClass(/skin-gmail/);
        await expect(page.getByTestId('weather-chip')).toBeVisible();
    });

    test('never renders when the master switch is off, on any skin', async ({ page }) => {
        await applyMocks(page);
        await stubWeather(page);
        // Gmail is the skin that shows the chip with no per-skin opt-in, so it
        // is the one where "off" has to win outright. The per-skin opt-in is
        // deliberately also set: it is subordinate to the master switch, and a
        // future refactor that let it override would show up here.
        await seed(page, { skinId: 'gmail', weatherChip: false, weatherChipOutlook: true });
        await login(page);
        await expect(page.locator('html')).toHaveClass(/skin-gmail/);
        await expect(page.getByTestId('weather-chip')).toHaveCount(0);
        await expect(page.locator('.weather-menu')).toHaveCount(0);
    });

    // Default state for the placement tests below. Gmail renders the chip
    // with no per-skin opt-in, so this is the plain, un-overridden path.
    const chipMounts = { skinId: 'gmail', weatherChip: true } as const;

    test('options menu stays inside the viewport near the right/bottom edge', async ({ page }) => {
        await applyMocks(page);
        await stubWeather(page);
        await seed(page, chipMounts);
        await login(page);
        await expect(page.getByTestId('weather-chip')).toBeVisible();
        // The caret path anchors the menu to the chip's own left edge. The
        // chip never gets close enough to the right edge for that naive
        // placement to overflow horizontally — when the window narrows, the
        // topbar wraps and the chip lands back near the left edge — so this
        // test proves the vertical clamp only. The right-click test below
        // covers horizontal clamping from the cursor-anchored path.
        // 200px-tall window: the ~236px menu cannot fit below the chip.
        await page.setViewportSize({ width: 950, height: 200 });
        await page.locator('.weather-caret').click();
        await expect(page.locator('.weather-menu')).toBeVisible();
        const m = await measure(page);
        expect(m.menu).not.toBeNull();
        expect(m.chip).not.toBeNull();

        // The unclamped spot the component asked for really was off-screen —
        // otherwise this proves nothing. Derived from the real measurement
        // rather than assumed, because whether the naive placement overflows
        // depends on the menu's rendered height.
        const naiveBottom = m.chip!.y + m.chip!.height + 6 + m.menu!.height;
        expect(naiveBottom).toBeGreaterThan(m.innerHeight);

        // And the rendered menu is fully inside the viewport.
        expect(m.menu!.x).toBeGreaterThanOrEqual(0);
        expect(m.menu!.y).toBeGreaterThanOrEqual(0);
        expect(m.menu!.x + m.menu!.width).toBeLessThanOrEqual(m.innerWidth);
        expect(m.menu!.y + m.menu!.height).toBeLessThanOrEqual(m.innerHeight);

        // The menu actually moved up off the requested position.
        expect(m.menu!.y).toBeLessThan(m.chip!.y + m.chip!.height + 6);
    });

    test('options menu is left where it wants to be when it already fits', async ({ page }) => {
        await applyMocks(page);
        await stubWeather(page);
        await seed(page, chipMounts);
        await login(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await expect(page.getByTestId('weather-chip')).toBeVisible();

        await page.locator('.weather-caret').click();
        await expect(page.locator('.weather-menu')).toBeVisible();

        const m = await measure(page);
        // Comfortable margins all round: the placement must stay the
        // untouched trigger-relative one, not a clamped one.
        expect(Math.round(m.menu!.x)).toBe(Math.round(m.chip!.x));
        expect(Math.round(m.menu!.y)).toBe(Math.round(m.chip!.y + m.chip!.height + 6));
    });

    test('options menu clamps from a right-click near the corner', async ({ page }) => {
        await applyMocks(page);
        await stubWeather(page);
        await seed(page, chipMounts);
        await login(page);
        await expect(page.getByTestId('weather-chip')).toBeVisible();

        // Right-click is the other entry point: it anchors the menu to the
        // cursor, so clicking the chip's far edge drives the same overflow
        // through a different code path.
        await page.setViewportSize({ width: 950, height: 260 });
        await page.locator('.weather-chip').click({ button: 'right', position: { x: 190, y: 20 } });
        await expect(page.locator('.weather-menu')).toBeVisible();

        const m = await measure(page);
        expect(m.menu!.x).toBeGreaterThanOrEqual(0);
        expect(m.menu!.y).toBeGreaterThanOrEqual(0);
        expect(m.menu!.x + m.menu!.width).toBeLessThanOrEqual(m.innerWidth);
        expect(m.menu!.y + m.menu!.height).toBeLessThanOrEqual(m.innerHeight);
    });

    test('clicking the chip cycles panes, Escape and click-outside close the menu', async ({ page }) => {
        await applyMocks(page);
        await stubWeather(page);
        await seed(page, chipMounts);
        await login(page);
        const chip = page.getByTestId('weather-chip');
        await expect(chip).toBeVisible();

        // Click-to-cycle: the pane text advances. The stubbed forecast gives
        // several panes, so the click must change what is on screen.
        const pane = chip.locator('.pane');
        const before = (await pane.textContent())?.trim();
        await chip.click();
        await expect
            .poll(async () => (await pane.textContent())?.trim())
            .not.toBe(before);

        const menu = page.locator('.weather-menu');
        await page.locator('.weather-caret').click();
        await expect(menu).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);

        await page.locator('.weather-caret').click();
        await expect(menu).toBeVisible();
        await page.locator('[data-testid=shell]').click({ position: { x: 300, y: 300 } });
        await expect(menu).toHaveCount(0);
    });
});
