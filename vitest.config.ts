// Root Vitest config: one run, three projects, one coverage report (Req 25.1, 25.10).
import { fileURLToPath } from 'node:url';

import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve @ihg-guest-search/shared to its TypeScript source (mirrors
// customConditions in tsconfig.base.json), so tests never need a build.
const SOURCE_CONDITION = '@ihg-guest-search/source';

export default defineConfig({
  resolve: {
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
    alias: [
      // `@opentelemetry/semantic-conventions` 1.43.0 ships an ESM build whose index uses
      // extensionless directory re-exports (`export * from './trace'`) and declares no `import`
      // condition, so resolving its `module` build fails under Vitest with an unsupported
      // directory import. Pin every import of it to its complete, Node-compatible CommonJS build.
      // Combined with inlining the OpenTelemetry packages (below) this also rewrites their internal
      // imports of it. Production (`node dist`) already resolves to this CJS build via the package
      // `default` condition, so the change only harmonises test resolution.
      {
        find: /^@opentelemetry\/semantic-conventions$/,
        replacement: fileURLToPath(
          new URL(
            './node_modules/@opentelemetry/semantic-conventions/build/src/index.js',
            import.meta.url,
          ),
        ),
      },
    ],
  },
  ssr: {
    resolve: {
      conditions: [SOURCE_CONDITION, ...defaultServerConditions],
    },
  },
  test: {
    server: {
      deps: {
        // Inline the OpenTelemetry packages so Vite (not Node's external loader) resolves their
        // internal imports, routing `@opentelemetry/semantic-conventions` through the CJS alias
        // above and sidestepping that package's broken ESM directory re-exports.
        inline: [/@opentelemetry[/\\]/],
      },
    },
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
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          // Repo tooling, e.g. the CI dependency gate (Req 26.4).
          name: 'scripts',
          root: './scripts',
          environment: 'node',
          include: ['**/*.test.{mjs,ts}'],
        },
      },
      {
        extends: true,
        test: {
          // Dev tooling: the local Node mock SOAP server (task 13.1). Not shipped; excluded
          // from the coverage include globs (apps/*/src, packages/*/src) by location.
          name: 'tools',
          root: './tools',
          environment: 'node',
          include: ['**/*.test.ts'],
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
