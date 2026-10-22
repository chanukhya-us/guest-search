/**
 * Parameterised local stack for Playwright E2E (task 13.3).
 *
 *   node scripts/e2e-stack.mjs
 *
 * This is a thin, env-parameterised sibling of `scripts/dev-all.mjs`. It boots the WHOLE
 * stack with NO Docker — the zero-dependency Node mock SOAP server, the Fastify BFF and the
 * Vite web dev server (which proxies /api + /health to the BFF, reproducing the single-origin
 * contract the browser sees in production). Playwright's `webServer` runs this and waits on the
 * web port before the suite starts.
 *
 * Why a dedicated script rather than reusing `dev:all` directly:
 *   - The suite needs TWO stacks on DIFFERENT ports at once: one with the reveal-capable dev
 *     persona (jane.doe) for the reveal-on flow, and one with a read-only persona (read.only)
 *     for the reveal-off assertion (design.md: "reveal role on, and role off in a second
 *     dev-user config"). `dev:all` hard-codes a single persona and the default ports.
 *   - E2E must be deterministic: fixed ports, the 60-guest mock seed (SOAP_MAX_RESULTS=60 so
 *     Req 17 pagination is exercised), and a dev-only session secret — all pinned here.
 *
 * Everything it starts is DEV MODE (AUTH_MODE=dev): the BFF stays on plain-HTTP localhost with a
 * dev auth persona and the non-Secure `gs_session` cookie, exactly as `dev:all` does, so no TLS
 * or production cookie prefix is required for the browser to hold a session.
 *
 * Environment knobs (all optional; defaults make a single stack identical to dev:all's wiring):
 *   E2E_WEB_PORT   Vite dev-server port the browser hits      (default 5173)
 *   E2E_BFF_PORT   Fastify BFF port the web server proxies to (default 3000)
 *   E2E_MOCK_PORT  Node mock SOAP port the BFF calls          (default 8080)
 *   DEV_AUTH_PERSONA  dev persona: jane.doe | read.only | no.access (default jane.doe)
 *
 * Secrets: only a clearly-labelled DEV-ONLY session secret is defaulted. Never commit real
 * secrets; this value is local-only and >= 32 chars (the BFF minimum).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const BFF_PORT = process.env.E2E_BFF_PORT ?? '3000';
const MOCK_PORT = process.env.E2E_MOCK_PORT ?? '8080';
const MOCK_PATH = process.env.MOCK_SOAP_PATH ?? '/InitiateService';
const PERSONA = process.env.DEV_AUTH_PERSONA ?? 'jane.doe';

// Dev-only configuration so the stack runs end to end with no external setup. These mirror the
// DEV_FALLBACKS in dev-all.mjs; the ports and persona are the only things that vary per stack.
const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: BFF_PORT,
  AUTH_MODE: 'dev',
  DEV_AUTH_PERSONA: PERSONA,
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'dev-only-e2e-session-secret-change-me-0123456789',
  SOAP_ENDPOINT: `http://localhost:${MOCK_PORT}${MOCK_PATH}`,
  SOAP_MAX_RESULTS: process.env.SOAP_MAX_RESULTS ?? '60',
  SOAP_HEADER_LANGUAGE_CODE: process.env.SOAP_HEADER_LANGUAGE_CODE ?? 'en',
  SOAP_HEADER_COUNTRY_CODE: process.env.SOAP_HEADER_COUNTRY_CODE ?? 'US',
  SOAP_HEADER_CHANNEL: process.env.SOAP_HEADER_CHANNEL ?? 'MSCUI',
  SOAP_HEADER_SUB_CHANNEL: process.env.SOAP_HEADER_SUB_CHANNEL ?? 'ATLR3,profile',
  SOAP_HEADER_ENVIRONMENT: process.env.SOAP_HEADER_ENVIRONMENT ?? 'local',
  SOAP_HEADER_SERVICE_USER: process.env.SOAP_HEADER_SERVICE_USER ?? 'LOCAL\\dev-user',
  UI_MEMBER_TYPES:
    process.env.UI_MEMBER_TYPES ?? '[{"code":"PLACEHOLDER","label":"Placeholder member type"}]',
  MOCK_SOAP_PORT: MOCK_PORT,
  MOCK_SOAP_PATH: MOCK_PATH,
  // The Vite dev server proxies /api and /health to this BFF (vite.config.ts reads it).
  BFF_PROXY_TARGET: `http://localhost:${BFF_PORT}`,
};

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m']; // cyan, yellow, magenta
const RESET = '\x1b[0m';

const children = [];
let shuttingDown = false;

function prefixWrite(name, color, stream, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    stream.write(`${color}[${name}:${PERSONA}]${RESET} ${line}\n`);
  }
}

function run(name, color, command, args, extraEnv) {
  // Windows + Node >= 20 refuses to spawn a `.cmd` (e.g. npm.cmd) without a shell (EINVAL),
  // so shell out only for the npm launcher; node binaries spawn directly.
  const useShell = command === npmCmd;
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell,
  });
  child.stdout.on('data', (c) => prefixWrite(name, color, process.stdout, c));
  child.stderr.on('data', (c) => prefixWrite(name, color, process.stderr, c));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(
      `${color}[${name}:${PERSONA}]${RESET} exited (code=${code}, signal=${signal})\n`,
    );
    shutdown(code === null ? 1 : code);
  });
  children.push(child);
  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Build shared + bff once (the BFF runs its compiled dist), then start all three processes.
process.stdout.write(`[e2e-stack:${PERSONA}] building packages/shared and apps/bff ...\n`);
const build = spawn(npmCmd, ['run', 'build:backend'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  // Windows requires a shell to launch npm.cmd (EINVAL otherwise); harmless on POSIX.
  shell: true,
});
build.on('exit', (code) => {
  if (code !== 0) {
    process.stderr.write(`[e2e-stack:${PERSONA}] build failed; not starting the stack\n`);
    process.exit(code ?? 1);
  }
  run('mock', COLORS[0], process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    join(ROOT, 'tools', 'mock-soap', 'server.ts'),
  ]);
  run('bff', COLORS[1], process.execPath, [join(ROOT, 'apps', 'bff', 'dist', 'index.js')]);
  // Vite reads the port from --port and the proxy target from BFF_PROXY_TARGET (above).
  run('web', COLORS[2], npmCmd, [
    'run',
    'dev',
    '--workspace=@ihg-guest-search/web',
    '--',
    '--port',
    WEB_PORT,
    '--strictPort',
  ]);
  process.stdout.write(
    `[e2e-stack:${PERSONA}] web http://localhost:${WEB_PORT} -> bff :${BFF_PORT} -> mock :${MOCK_PORT}\n`,
  );
});
