import { defineConfig } from 'vitest/config';

// Playwright specs in e2e/ run via `pnpm e2e`, not Vitest.
export default defineConfig({ test: { exclude: ['e2e/**', 'node_modules/**', '.next/**'], passWithNoTests: true } });
