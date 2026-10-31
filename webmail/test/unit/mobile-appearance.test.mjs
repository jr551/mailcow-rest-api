import assert from 'node:assert/strict';
import { test } from 'node:test';

async function loadModule() {
    return import('../../src/lib/mobile-appearance.ts');
}

test('MOBILE_THEME_OPTIONS lists Auto, Light, Dark', async () => {
    const { MOBILE_THEME_OPTIONS } = await loadModule();
    assert.equal(MOBILE_THEME_OPTIONS.length, 3);
    assert.deepEqual(
        MOBILE_THEME_OPTIONS.map((m) => m.value),
        ['auto', 'light', 'dark']
    );
});

test('messageIframeTheme follows effective mode (not html.dark)', async () => {
    const { messageIframeTheme } = await loadModule();
    assert.equal(messageIframeTheme('dark'), 'dark');
    assert.equal(messageIframeTheme('light'), 'light');
});
