/**
 * Application factory (task 8.6; design.md "app factory / buildApp", plugin order, Routes).
 *
 * `buildApp` is the single composition root: it builds every collaborator from `AppConfig`,
 * registers the HTTP-layer plugins in the documented order, mounts the routes, and (in a built
 * deployment) serves the SPA — then returns a ready Fastify instance. It performs NO network I/O
 * and NO `listen`; `startServer` (index.ts) owns the process lifecycle. That split is what lets
 * every integration test spin up the real app with `fastify.inject`, swapping in a fake gateway
 * and deterministic clocks/stores through `BuildAppDeps`, with zero sockets opened.
 *
 * ## Instance options set at construction (design.md note)
 * `genReqId` and `bodyLimit` are Fastify INSTANCE options — Fastify reads them when the instance
 * is created, before any plugin registers — so they are passed to `Fastify({...})` here rather
 * than inside a plugin. The JSON-only content-type parser is likewise installed on the instance
 * up front: the default parsers are removed and only `application/json` is accepted, so any other
 * media type yields Fastify's built-in 415 (routed through the error handler as VALIDATION_ERROR,
 * Req 6.2/6.3).
 *
 * ## Dependency injection for tests (`BuildAppDeps`)
 * Production passes `config` (and `logger: true`); `buildApp` then constructs the real SOAP stack
 * (breaker → undici Agent → transport → gateway), the redacting pino logger, the file-backed audit
 * logger, and the in-memory stores. Tests inject:
 *   - `gateway` — a fake `GuestSearchGateway`, so no SOAP/undici is touched and search outcomes
 *     (success, empty, each UPSTREAM_* error, INTERNAL_ERROR) are scripted;
 *   - `authProvider` — a stub returning a chosen principal (or null for the 401 path);
 *   - `sessionStore` / `revealStore` — with injected clocks and id/token generators for
 *     deterministic session- and reveal-expiry tests;
 *   - `now` — the gateway/header clock;
 *   - `readinessConnect` — a fake TCP connector for `/health/ready`;
 *   - `appLogger` — a pino logger on an in-memory destination, to capture and assert log lines
 *     (and prove redaction) end to end; it is wired into Fastify, the service and the gateway;
 *   - `audit` — a `BufferAuditLogger` to assert the `guest.search` / `guest.reveal` trail;
 *   - `serveStaticDir` — an explicit SPA directory (otherwise discovery is skipped under test).
 * Anything not injected falls back to the production construction, so a test overrides only what
 * it needs.
 *
 * ## SPA serving decision (design.md plugin 10, Req 21.5)
 * In development the SPA is served by Vite on its own dev server, which proxies `/api` and
 * `/health` to the BFF — so the BFF does NOT serve static files in dev. In a built deployment the
 * BFF serves `apps/web/dist` with a SPA fallback (deep links return `index.html`). `buildApp`
 * registers `@fastify/static` ONLY when a built `dist` with an `index.html` is present (or an
 * explicit `serveStaticDir` is injected), so a dev run or a test never accidentally serves stale
 * assets. The fallback is scoped so it can never shadow the API: `setNotFoundHandler` already
 * returns JSON for unknown `/api/*` and `/health/*` paths, and the SPA fallback only rewrites
 * other GET/HEAD requests to `index.html`. API and health paths therefore keep their JSON 404.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import {
  ERROR_CATALOG,
  createCriteriaSchema,
  defaultSchemaConfig,
  type SchemaConfig,
} from '@ihg-guest-search/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

import { createAuthProvider, type AuthProvider } from './auth/authProvider.js';
import { MemorySessionStore, type SessionStore } from './auth/sessionStore.js';
import type { AppConfig } from './config.js';
import { ReadinessChecker, type TcpConnector } from './health.js';
import { FileAuditLogger, NoopAuditLogger } from './observability/audit.js';
import { createLogger, fastifyLoggerOptions } from './observability/logger.js';
import { createMetrics, type HttpOutcome, type Metrics } from './observability/metrics.js';
import { genReqId } from './plugins/requestId.js';
import { registerHttpPlugins } from './plugins/index.js';
import type { GuestSearchGateway } from './ports/GuestSearchGateway.js';
import { MemoryRevealStore, type RevealStore } from './security/revealStore.js';
import type { AuditLogger } from './services/guestSearchService.js';
import { CircuitBreaker } from './soap/circuitBreaker.js';
import { SoapGuestSearchGateway } from './soap/soapGuestSearchGateway.js';
import { createSoapTransport } from './soap/transport.js';
import { GuestSearchService } from './services/guestSearchService.js';
import { registerRoutes } from './routes/index.js';

/** Overrides for `buildApp`, all optional; production supplies none (see module doc). */
export interface BuildAppDeps {
  /** Replace the SOAP gateway (tests inject a fake; production builds the SOAP stack). */
  readonly gateway?: GuestSearchGateway;
  /** Replace the auth provider (tests stub it; production calls `createAuthProvider`). */
  readonly authProvider?: AuthProvider;
  /** Replace the session store (tests inject clocks/id generators). */
  readonly sessionStore?: SessionStore;
  /** Replace the reveal store (tests inject clocks/token generators). */
  readonly revealStore?: RevealStore;
  /** Clock for the gateway/header and reveal-store/service timestamps. Defaults to real time. */
  readonly now?: () => number;
  /** TCP connector for the readiness probe (tests avoid real sockets). */
  readonly readinessConnect?: TcpConnector;
  /** Explicit SPA directory to serve; when omitted production auto-discovers `apps/web/dist`. */
  readonly serveStaticDir?: string;
  /**
   * The application logger to use (task 9.1). When provided it is wired into Fastify (with the
   * path-only serializers and the `reqId` label) AND injected into the service and SOAP gateway,
   * so every log line — request, SOAP and search-completion — flows through one redacting pino
   * instance. When omitted, `buildApp` builds one from `config` (the production path); pass a
   * logger bound to an in-memory destination to capture lines in a test.
   */
  readonly appLogger?: Logger;
  /**
   * Disable Fastify's built-in logger (tests). Ignored when `appLogger` is supplied. Defaults to
   * `false` so a test without a logger stays quiet; production supplies `appLogger`.
   */
  readonly logger?: boolean;
  /**
   * The audit sink (task 9.1). When omitted, `buildApp` builds a {@link FileAuditLogger} from
   * `config.log.auditLogPath` (production) — except under `test`, where it defaults to a no-op so
   * tests never write a file unless they inject a {@link BufferAuditLogger}. Injected in tests to
   * assert the `guest.search` / `guest.reveal` trail.
   */
  readonly audit?: AuditLogger;
  /**
   * The metrics surface (task 9.2). When omitted, `buildApp` builds one with {@link createMetrics}
   * (an OTel-API meter — a no-op until an SDK is registered, so it is safe and free when telemetry
   * is off). It is injected into the SOAP gateway, the service and the circuit breaker, and drives
   * the inbound-request duration/error instruments via an `onResponse` hook. Tests inject a metrics
   * object backed by an in-memory `MeterProvider` to assert recorded instruments.
   */
  readonly metrics?: Metrics;
}

/** Build a ready Fastify app from config. Does not listen. */
export async function buildApp(
  config: AppConfig,
  deps: BuildAppDeps = {},
): Promise<FastifyInstance> {
  // Logger (task 9.1): an injected instance wins. Otherwise a real logger is built only when one
  // is asked for — production passes `logger: true`; a plain test passes nothing and stays quiet,
  // preserving the prior default so existing tests are not flooded with request lines.
  const appLogger = deps.appLogger ?? (deps.logger === true ? createLogger(config) : undefined);
  const fastify = Fastify({
    genReqId,
    bodyLimit: 8192,
    trustProxy: config.trustProxy,
    ...(appLogger !== undefined ? fastifyLoggerOptions(appLogger) : { logger: false }),
  });

  installJsonOnlyParser(fastify);

  // Fastify request tracing (task 9.2). `@fastify/otel` hooks the Fastify lifecycle, so it must be
  // a Fastify plugin — it cannot be a NodeSDK auto-instrumentation. Register it ONLY when an
  // exporter is configured (telemetry on); with the exporter `none` (the default and every test)
  // the telemetry module — and the whole OpenTelemetry SDK it imports — is never even loaded, so
  // the plugin is skipped and adds no overhead. The dynamic import keeps that heavy dependency
  // graph off the hot path when telemetry is off. Registered before routes so it wraps them.
  if (config.telemetry.exporter !== 'none') {
    const { createFastifyOtelPlugin } = await import('./observability/telemetry.js');
    await fastify.register(createFastifyOtelPlugin().plugin());
  }

  // --- collaborators (injected or built from config) ---------------------------------------
  const nowMs = deps.now ?? Date.now;
  // Metrics (task 9.2): an injected surface wins; otherwise an OTel-API-backed one, which is a
  // no-op until `startTelemetry` registers an SDK — so this is free and safe with telemetry off.
  const metrics = deps.metrics ?? createMetrics();
  const audit = deps.audit ?? buildAuditLogger(config);
  const authProvider = deps.authProvider ?? createAuthProvider(config);
  const sessionStore =
    deps.sessionStore ??
    new MemorySessionStore({
      ttlMs: config.session.ttlMinutes * 60_000,
      absoluteMs: config.session.absoluteHours * 3_600_000,
    });
  const revealStore =
    deps.revealStore ??
    new MemoryRevealStore({ ttlMs: config.reveal.ttlMinutes * 60_000, now: nowMs });
  const gateway = deps.gateway ?? buildSoapGateway(config, nowMs, metrics, appLogger);
  const schema = createCriteriaSchema(schemaConfig(config));
  const service = new GuestSearchService({
    gateway,
    schema,
    revealStore,
    sessionSecret: config.session.secret,
    now: nowMs,
    audit,
    metrics,
    // The service logs field NAMES/counts only; the app logger's redaction is the backstop.
    ...(appLogger !== undefined && { logger: appLogger }),
  });
  const readiness = new ReadinessChecker({
    endpoint: config.soap.endpoint,
    ...(deps.readinessConnect !== undefined && { connect: deps.readinessConnect }),
    now: nowMs,
  });

  // Inbound-request duration metric (task 9.2, Req 22.7): record `gs.http.server.duration` with a
  // non-PII status-class outcome bucket on every response. `reply.elapsedTime` is Fastify's own
  // server-measured duration in ms. The `gs.errors{code}` counter is fed separately by the error
  // handler, where the catalog code is known (see `onError` below). Non-PII only — the status
  // bucket, never the path, query or body.
  fastify.addHook('onResponse', (_request, reply, done) => {
    metrics.httpServer(reply.elapsedTime, { outcome: httpOutcome(reply.statusCode) });
    done();
  });

  // Resolve the SPA directory up front: when present, the SPA fallback owns the single root
  // not-found handler, so the plugin layer must NOT install the default one (Fastify forbids two).
  const spaDir = deps.serveStaticDir ?? discoverSpaDir(config.nodeEnv);

  // --- HTTP layer (plugins in design order) -------------------------------------------------
  await registerHttpPlugins(fastify, {
    production: config.nodeEnv === 'production',
    sessionSecret: config.session.secret,
    sessionCookieName: config.session.cookieName,
    sessionStore,
    authProvider,
    installNotFoundHandler: spaDir === undefined,
    // Feed the `gs.errors{code}` counter from the one place the catalog code is resolved.
    onError: (code) => metrics.error({ code }),
  });

  // --- routes -------------------------------------------------------------------------------
  registerRoutes(fastify, {
    uiConfigSource: config,
    features: config.soap.features,
    authProvider,
    service,
    revealStore,
    rateLimit: config.rateLimit,
    readiness,
  });

  // --- SPA (built deployments only) ---------------------------------------------------------
  await registerSpa(fastify, spaDir);

  await fastify.ready();
  return fastify;
}

/**
 * JSON-only body parsing (Req 6.2, 6.3). Drop Fastify's default parsers (which also accept
 * `text/plain`) and keep only `application/json`, so every other media type is rejected with the
 * built-in 415. An empty body parses to `undefined`, which the search route treats as "no
 * criteria" → NO_CRITERIA, rather than a parse error.
 */
function installJsonOnlyParser(fastify: FastifyInstance): void {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body === '' ? undefined : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
}

/** Bucket an HTTP status into a non-PII outcome label for `gs.http.server.duration`. */
function httpOutcome(status: number): HttpOutcome {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'success';
}

/** Build the production SOAP gateway: breaker → undici transport → SOAP adapter. */
function buildSoapGateway(
  config: AppConfig,
  nowMs: () => number,
  metrics: Metrics,
  logger?: Logger,
): GuestSearchGateway {
  // The breaker reports every transition to the metrics surface, which feeds the observable
  // `gs.breaker.state` gauge (task 9.2). `onStateChange` must not throw; `onBreakerState` only
  // updates an in-memory value.
  const breaker = new CircuitBreaker(config.soap.breaker, {
    now: nowMs,
    onStateChange: (to) => metrics.onBreakerState(to),
  });
  const transport = createSoapTransport(config.soap, { breaker });
  return new SoapGuestSearchGateway({
    cfg: config.soap,
    transport,
    now: () => new Date(nowMs()),
    metrics,
    // The gateway logs status/duration/code/detail only; redaction backs it up (task 9.1).
    ...(logger !== undefined && { logger }),
  });
}

/**
 * Build the audit sink from config (task 9.1). Production/development write JSON lines to
 * `config.log.auditLogPath` (a {@link FileAuditLogger}); under `test` the default is a no-op so a
 * test never writes a file unless it injects a {@link BufferAuditLogger} through `deps.audit`.
 */
function buildAuditLogger(config: AppConfig): AuditLogger {
  if (config.nodeEnv === 'test') return new NoopAuditLogger();
  return new FileAuditLogger({ path: config.log.auditLogPath });
}

/**
 * Compile the shared criteria `SchemaConfig` from `AppConfig`. The configured member-type code
 * set (also served to the UI) is the allow-list; limits and the member-id pattern keep their
 * shared defaults until the XSD supplies real values (TODO B1/B4 in the shared package), so the
 * server validates against the same member-type codes the UI shows.
 */
function schemaConfig(config: AppConfig): SchemaConfig {
  return { ...defaultSchemaConfig, memberTypes: config.ui.memberTypes };
}

/**
 * Auto-discover the built SPA directory for a production run. Returns the `dist` path only when
 * it exists with an `index.html`; otherwise `undefined` (dev/test, or an unbuilt deployment), so
 * static serving is simply skipped. The path is `apps/web/dist` resolved relative to this file's
 * compiled location (`apps/bff/dist/app.js` → repo `apps/web/dist`).
 */
function discoverSpaDir(nodeEnv: AppConfig['nodeEnv']): string | undefined {
  if (nodeEnv !== 'production') return undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled: apps/bff/dist/app.js. Up to apps/bff, then apps/web/dist.
  const candidate = resolve(here, '..', '..', 'web', 'dist');
  return existsSync(join(candidate, 'index.html')) ? candidate : undefined;
}

/**
 * Register `@fastify/static` with a SPA fallback, guarded so it can never shadow the API. Skips
 * entirely when there is no directory to serve (the common dev/test case). The not-found handler
 * (installed by `registerHttpPlugins`) already returns JSON for unknown `/api/*` and `/health/*`
 * paths; the SPA fallback only rewrites OTHER GET/HEAD misses to `index.html`, so a deep link
 * like `/results` loads the app while `/api/v1/unknown` keeps its JSON 404.
 */
async function registerSpa(fastify: FastifyInstance, dir: string | undefined): Promise<void> {
  if (dir === undefined) return;

  await fastify.register(fastifyStatic, { root: dir, wildcard: false });

  fastify.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?', 1)[0] ?? request.url;
    const isAsset = request.method === 'GET' || request.method === 'HEAD';
    const isApi = path === '/api' || path.startsWith('/api/') || path.startsWith('/health');
    if (isAsset && !isApi) {
      return reply.type('text/html').sendFile('index.html');
    }
    // API/health misses and non-GET: fall back to the catalog JSON 404 (same shape as the
    // default not-found handler, keeping every error body identical).
    return reply.code(404).send({
      requestId: request.id,
      success: false,
      error: { code: 'VALIDATION_ERROR', message: ERROR_CATALOG.VALIDATION_ERROR.message },
    });
  });
}
