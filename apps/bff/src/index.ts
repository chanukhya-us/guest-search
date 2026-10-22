/**
 * BFF server entry point (task 8.6; design.md "app factory / buildApp").
 *
 * This is the only module with process-level side effects. It:
 *   1. loads and validates configuration (`loadConfig`), reading secrets through
 *      `EnvSecretProvider`;
 *   2. builds the ready Fastify app (`buildApp`) — all wiring lives there, none here;
 *   3. listens on the configured port; and
 *   4. installs graceful-shutdown handlers so SIGINT/SIGTERM close the server cleanly.
 *
 * A `StartupError` from config loading or provider construction (missing/invalid config,
 * dev auth in production, an unimplemented auth mode) is fatal: its message — which names
 * only configuration KEYS, never values (Req 8.5) — is printed to stderr and the process
 * exits with code 1. No stack trace is printed for a `StartupError`, since the message is
 * the actionable information; any other failure is printed in full for diagnosis.
 *
 * Telemetry (the OpenTelemetry SDK) is started by `startTelemetry(config)` BEFORE `buildApp`, so
 * the SDK's auto-instrumentations patch HTTP/undici before Fastify first uses them. With the
 * exporter `none` (the default) this is a no-op; otherwise the returned handle is stopped on
 * SIGINT/SIGTERM alongside `app.close()`.
 *
 * Importing this module for its exports has no side effects: the bootstrap runs only when the
 * file is executed directly (`node dist/index.js`), guarded by the `isMain` check, so tests can
 * import `startServer`/`buildApp` without binding a socket.
 */
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.js';
import { loadConfig, EnvSecretProvider, type AppConfig } from './config.js';
import { StartupError } from './errors.js';
import type { Telemetry } from './observability/telemetry.js';

/** No-op telemetry handle for the exporter-`none` path (and tests): shutdown resolves at once. */
const NOOP_TELEMETRY: Telemetry = { shutdown: () => Promise.resolve() };

/** Load config, build the app and listen. Resolves once the socket is bound. */
export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ close: () => Promise<void>; port: number }> {
  const config: AppConfig = loadConfig(env, new EnvSecretProvider(env));

  // Start OpenTelemetry before the app is built, so its HTTP/undici instrumentations are in place
  // before Fastify runs. With exporter `none` (the default) the whole OpenTelemetry SDK is never
  // even imported — the `telemetry` module is loaded lazily only when an exporter is configured —
  // so a default run (and every test) pays nothing and the handle is a no-op.
  const telemetry =
    config.telemetry.exporter === 'none'
      ? NOOP_TELEMETRY
      : (await import('./observability/telemetry.js')).startTelemetry(config);

  const app = await buildApp(config, { logger: true });
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await telemetry.shutdown();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  return {
    close: async () => {
      await app.close();
      await telemetry.shutdown();
    },
    port: config.port,
  };
}

/** Print a startup failure and exit 1. `StartupError` prints only its (key-safe) message. */
function failStartup(error: unknown): never {
  if (error instanceof StartupError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Failed to start: ${String(error)}\n`);
    if (error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`);
    }
  }
  process.exit(1);
}

/** True when this module is the program's entry (executed directly, not imported). */
function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  startServer().catch(failStartup);
}
