// Root Vitest config: one run, three projects, one coverage report (Req 25.1, 25.10).
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve @ihg-guest-search/shared to its TypeScript source (mirrors
// customConditions in tsconfig.base.json), so tests never need a build.
const SOURCE_CONDITION = '@ihg-guest-search/source';

export default defineConfig({
  resolve: {
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, ...defaultServerConditions],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'bff',
          root: './apps/bff',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'jsdom',
          include: ['test/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          // Repo tooling, e.g. the CI dependency gate (Req 26.4).
          name: 'scripts',
          root: './scripts',
          environment: 'node',
          include: ['**/*.test.mjs'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Measure production source only; tests, configs and build output are excluded.
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 85,
        branches: 80,
        // The SOAP adapter is the riskiest code path: stricter, per file.
        'apps/bff/src/soap/**': {
          perFile: true,
          lines: 95,
          branches: 90,
        },
      },
    },
  },
});
