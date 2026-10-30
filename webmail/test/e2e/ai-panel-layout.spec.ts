import { test, expect } from '@playwright/test';
import { applyMocks, login } from './fixtures';

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
    await applyMocks(page);
    await page.addInitScript(() => {
        localStorage.setItem('webmail.theme', 'dark');
        localStorage.setItem('webmail.settings.v1', JSON.stringify({
            aiFeatures: true,
            density: 'comfortable',
            listFilter: 'all',
            readingPaneLayout: 'right',
            useCustomLlm: false,
            llm: { kind: 'openai', preset: '', apiKey: '', baseUrl: '', model: '' }
        }));
    });
});

test('AI panel docks beside the reading pane without overlapping it', async ({ page }) => {
    await login(page);
    await page.getByTestId('msg-row-1001').click();
    await expect(page.getByTestId('detail-subject')).toBeVisible();

    await page.getByTestId('ai-menu-btn').click();
    await page.getByTestId('ai-tools-btn').click();
    const panel = page.getByTestId('ai-panel');
    await expect(panel).toBeVisible();

    // Wait out the global fade-in so opacity is 1 before we measure layout.
    await page.waitForTimeout(250);

    const layout = await page.evaluate(() => {
        const panelEl = document.querySelector('[data-testid="ai-panel"]') as HTMLElement | null;
        const detailEl = document.querySelector('[data-testid="detail-subject"]') as HTMLElement | null;
        if (!panelEl || !detailEl) return null;
        const pr = panelEl.getBoundingClientRect();
        const dr = detailEl.getBoundingClientRect();
        const panelStyle = getComputedStyle(panelEl);
        return {
            panelLeft: pr.left,
            detailRight: dr.right,
            panelOpacity: panelStyle.opacity,
            panelBg: panelStyle.backgroundColor
        };
    });
    expect(layout).toBeTruthy();
    expect(Number(layout!.panelOpacity)).toBeGreaterThan(0.95);
    expect(layout!.panelLeft).toBeGreaterThanOrEqual(layout!.detailRight - 4);

    const toolbar = page.locator('.detail-header .actions');
    await expect(toolbar).toBeVisible();
    const clip = await toolbar.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const parent = el.closest('.detail') as HTMLElement | null;
        const pr = parent?.getBoundingClientRect();
        if (!pr) return { ok: true };
        return { ok: r.right <= pr.right + 2, right: r.right, parentRight: pr.right };
    });
    expect(clip.ok, `toolbar overflow: ${JSON.stringify(clip)}`).toBe(true);
});
