import { defineConfig, devices } from '@playwright/test';

// Single chromium instance, single worker — this host is RAM-constrained.
export default defineConfig({
    testDir: './test/e2e',
    timeout: 30_000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: process.env.WEBMAIL_BASE_URL || 'http://127.0.0.1:5180/webmail/',
        screenshot: 'only-on-failure',
        trace: 'off',
        video: 'off',
        actionTimeout: 10_000,
        navigationTimeout: 15_000,
        // The app's service worker intercepts /v1/* fetches and re-issues
        // them itself; SW-initiated requests bypass page.route() mocks and
        // hit the real (nonexistent) backend. Block SW registration so the
        // fixtures see every request.
        serviceWorkers: 'block'
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1280, height: 800 }
            }
        }
    ],
    // Always build, always serve a fresh bundle.
    //
    // Two things made this suite lie during the v0.18-0.20 work, and both
    // produced a green-looking run against code that was not under test:
    //
    //   1. `reuseExistingServer: !process.env.CI` reattached to whatever
    //      `vite preview` was already on 5180. A preview server left behind
    //      by an earlier session kept serving a STALE dist for hours, so a
    //      full suite run reported failures that did not exist in the
    //      current source, and a run could pass without exercising the code
    //      that was just written.
    //   2. Nothing verified the dist actually matched the source. A build
    //      that failed, or was never re-run after an edit, was served as if
    //      it were current.
    //
    // So: build first, always, and fail loudly if the build fails; never
    // reuse a server. Costs a few seconds per run and removes a whole class
    // of false green.
    webServer: {
        command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 5180 --strictPort',
        url: 'http://127.0.0.1:5180/webmail/',
        reuseExistingServer: false,
        timeout: 180_000
    }
});
