import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', use: { baseURL: 'http://localhost:5173' }, webServer: { command: 'pnpm dev', url: 'http://localhost:5173/api/me', reuseExistingServer: !process.env.CI, timeout: 60_000 }, timeout: 60_000 });
