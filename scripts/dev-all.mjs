/**
 * One-command local dev stack (task 13.1): the Node mock SOAP server, the Fastify BFF and the
 * Vite web dev server, started concurrently with no Docker and no extra dependencies.
 *
 *   npm run dev:all
 *
 * A tiny zero-dependency spawner was chosen over `concurrently` to keep the local MVP free of
 * new npm deps (the task allowed either; this is the lighter option and nothing is pinned).
 *
 * What it does:
 *   1. Loads dev environment from .env.local (git-ignored) if present, layering over process.env.
 *      Missing-file is fine; the baked-in DEV_FALLBACKS below keep the stack runnable out of the
 *      box (dev persona, a >=32-char dev session secret, the mock SOAP endpoint, maxResults 60).
 *   2. Builds packages/shared and apps/bff once (tsc), so `node dist/index.js` has fresh output.
 *      (The BFF compiles to dist; running the built output is the reliable cross-platform path.)
 *   3. Spawns: mock SOAP (node --experimental-strip-types), the BFF (node dist/index.js) and the
 *      web Vite dev server. Output is line-prefixed per process.
 *   4. Ctrl-C (SIGINT/SIGTERM) tears all three down; if any exits non-zero the whole stack stops.
 *
 * Secrets: only a DEV-ONLY session secret is defaulted here and documented as local-only. Real
 * secrets belong in .env.local (git-ignored) or a vault — never committed.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dev-only fallbacks so the stack runs end to end out of the box. Overridden by .env.local
// and the real process environment. The session secret is clearly local-only (>= 32 chars).
const DEV_FALLBACKS = {
  NODE_ENV: 'development',
  PORT: '3000',
  AUTH_MODE: 'dev',
  DEV_AUTH_PERSONA: 'jane.doe',
  SESSION_SECRET: 'dev-only-local-session-secret-change-me-0123456789',
  SOAP_ENDPOINT: 'http://localhost:8080/InitiateService',
  SOAP_MAX_RESULTS: '60',
  SOAP_HEADER_LANGUAGE_CODE: 'en',
  SOAP_HEADER_COUNTRY_CODE: 'US',
  SOAP_HEADER_CHANNEL: 'MSCUI',
  SOAP_HEADER_SUB_CHANNEL: 'ATLR3,profile',
  SOAP_HEADER_ENVIRONMENT: 'local',
  SOAP_HEADER_SERVICE_USER: 'LOCAL\\dev-user',
  UI_MEMBER_TYPES: '[{"code":"PLACEHOLDER","label":"Placeholder member type"}]',
  MOCK_SOAP_PORT: '8080',
  MOCK_SOAP_PATH: '/InitiateService',
};

/** Minimal .env parser: KEY=VALUE lines, ignores blanks and # comments, strips wrapping quotes. */
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Layering (last wins): fallbacks < .env.local < actual process.env.
const dotenv = parseEnvFile(join(ROOT, '.env.local'));
const env = { ...process.env, ...DEV_FALLBACKS, ...dotenv, ...process.env };

/**
 * Cross-platform npm invocation. Node refuses to spawn `.cmd`/`.bat` files without a shell on
 * Windows (spawn EINVAL, CVE-2024-27980 hardening), so we run npm's JS entry point with the current
 * Node binary when npm started this script (`npm_execpath`), and only fall back to a shell-backed
 * `npm` otherwise. Arguments are fixed literals, so the shell fallback carries no injection risk.
 */
const npmExecPath = process.env.npm_execpath;
function npm(args) {
  return npmExecPath !== undefined && npmExecPath.endsWith('.js')
    ? { command: process.execPath, args: [npmExecPath, ...args], shell: false }
    : { command: 'npm', args, shell: process.platform === 'win32' };
}

const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m']; // cyan, yellow, magenta
const RESET = '\x1b[0m';

const children = [];
let shuttingDown = false;

function prefixWrite(name, color, stream, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    stream.write(`${color}[${name}]${RESET} ${line}\n`);
  }
}

function run(name, color, command, args, extraEnv, shell = false) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
  });
  child.stdout.on('data', (c) => prefixWrite(name, color, process.stdout, c));
  child.stderr.on('data', (c) => prefixWrite(name, color, process.stderr, c));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${color}[${name}]${RESET} exited (code=${code}, signal=${signal})\n`);
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

// 1. Build shared + bff once, then start all three.
process.stdout.write('[dev:all] building packages/shared and apps/bff ...\n');
const buildCmd = npm(['run', 'build:backend']);
const build = spawn(buildCmd.command, buildCmd.args, {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: buildCmd.shell,
});
build.on('exit', (code) => {
  if (code !== 0) {
    process.stderr.write('[dev:all] build failed; not starting the stack\n');
    process.exit(code ?? 1);
  }
  run('mock', COLORS[0], process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    join(ROOT, 'tools', 'mock-soap', 'server.ts'),
  ]);
  run('bff', COLORS[1], process.execPath, [join(ROOT, 'apps', 'bff', 'dist', 'index.js')]);
  const webCmd = npm(['run', 'dev', '--workspace=@ihg-guest-search/web']);
  run('web', COLORS[2], webCmd.command, webCmd.args, undefined, webCmd.shell);
  process.stdout.write('[dev:all] stack starting — web on http://localhost:5173\n');
});
