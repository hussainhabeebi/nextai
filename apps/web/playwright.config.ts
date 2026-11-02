import { defineConfig, devices } from '@playwright/test';

/**
 * Mobile-viewport e2e: login → capture → approve → posted.
 * Boots core API + worker with MOCK_EXTERNALS (fake ERPNext/Chatwoot) and mock AI, plus the built web app.
 * Requires Postgres + Redis (CI services) and a migrated + seeded database (see .github/workflows/ci.yml).
 */
const env = {
  NODE_ENV: 'development',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://nextai_app:nextai_app@localhost:5432/nextai',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/3',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 9).toString('base64'),
  JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-jwt-secret-e2e-jwt-secret-e2e-jwt-secret',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'e2e-refresh-secret-e2e-refresh-secret-123',
  CHATWOOT_WEBHOOK_SECRET: 'e2e-chatwoot-secret-123456',
  APP_URL: 'http://localhost:3010',
  CORS_ORIGINS: 'http://localhost:3010',
  MOCK_EXTERNALS: 'true',
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    ...devices['Pixel 7'],
    baseURL: 'http://localhost:3010',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: [
    { command: 'pnpm --filter @nextai/core exec tsx src/server.ts', port: 8090, env, reuseExistingServer: !process.env.CI, timeout: 60_000 },
    { command: 'pnpm --filter @nextai/worker exec tsx src/index.ts', env, reuseExistingServer: !process.env.CI, timeout: 60_000, url: undefined, port: undefined, stdout: 'ignore' } as never,
    { command: 'pnpm start', port: 3010, env: { NEXT_PUBLIC_API_URL: 'http://localhost:8090' }, reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
});
