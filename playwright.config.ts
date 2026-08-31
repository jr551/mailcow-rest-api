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
        navigationTimeout: 15_000
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
    webServer: {
        command: 'npm run preview -- --host 127.0.0.1 --port 5180 --strictPort',
        url: 'http://127.0.0.1:5180/webmail/',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000
    }
});
