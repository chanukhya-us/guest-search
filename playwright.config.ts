// Playwright E2E + accessibility configuration (task 13.3, design.md "Testing Strategy"
// → "E2E + a11y" row, Req 24, 25.9).
//
// What this config wires:
//   - testDir `e2e/` (design.md: the E2E layer lives in `e2e/`).
//   - TWO full local stacks via `webServer`, both booted with NO Docker through
//     scripts/e2e-stack.mjs (Node mock SOAP + Fastify BFF + Vite web dev server):
//       1. the DEFAULT stack on :5173 with the reveal-capable dev persona (jane.doe), used
//          by the whole suite; and
//       2. a READ-ONLY stack on :5273 with the read.only persona, used by exactly one spec
//          to prove the reveal affordance is hidden without the role (design.md: "reveal
//          role on, and role off in a second dev-user config").
//     Each stack sets AUTH_MODE=dev, DEV_AUTH_PERSONA, SOAP_MAX_RESULTS=60 (so the 60-guest
//     mock exercises Req 17 pagination) and a dev-only SESSION_SECRET. Playwright waits on each
//     web port's `/health/live` (proxied to the BFF) so a stack is only "up" once the BFF is
//     reachable end to end, not merely once Vite is listening.
//   - A chromium project (CI installs chromium) with trace + screenshot on failure, a sane
//     timeout, and a baseURL per project so each spec hits the right stack.
//
// Local vs CI: `reuseExistingServer` is true locally (so a dev stack you already have running
// is reused and not double-booted) and false in CI (always a fresh, isolated stack).
// `forbidOnly` and `retries` are tightened in CI.
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

/** Default (reveal-capable) stack: jane.doe on :5173, BFF :3000, mock :8080. */
const WEB_PORT = 5173;
/** Read-only stack: read.only on :5273, BFF :3100, mock :8180 (no port clash with the default). */
const READONLY_WEB_PORT = 5273;

const BASE_URL = `http://localhost:${WEB_PORT}`;
const READONLY_BASE_URL = `http://localhost:${READONLY_WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // One worker: the two shared stacks carry per-session reveal state and per-session rate
  // limits, so serial execution keeps the suite deterministic (no cross-test interference).
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // Generous per-test budget: a cold stack build + first navigation can be slow in CI.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // A readable line reporter plus an HTML report (never auto-opened) retained as a CI artifact.
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], baseURL: BASE_URL },
      // Everything except the read-only reveal spec runs against the default stack.
      testIgnore: /readonly\.spec\.ts/,
    },
    {
      name: 'chromium-readonly',
      use: { ...devices['Desktop Chrome'], baseURL: READONLY_BASE_URL },
      // Only the read-only reveal spec, pointed at the read.only stack.
      testMatch: /readonly\.spec\.ts/,
    },
  ],
  webServer: [
    {
      // Default reveal-capable stack (jane.doe).
      command: 'node scripts/e2e-stack.mjs',
      url: `${BASE_URL}/health/live`,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        E2E_WEB_PORT: String(WEB_PORT),
        E2E_BFF_PORT: '3000',
        E2E_MOCK_PORT: '8080',
        DEV_AUTH_PERSONA: 'jane.doe',
      },
    },
    {
      // Read-only stack (read.only) for the reveal-off assertion.
      command: 'node scripts/e2e-stack.mjs',
      url: `${READONLY_BASE_URL}/health/live`,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        E2E_WEB_PORT: String(READONLY_WEB_PORT),
        E2E_BFF_PORT: '3100',
        E2E_MOCK_PORT: '8180',
        DEV_AUTH_PERSONA: 'read.only',
      },
    },
  ],
});
