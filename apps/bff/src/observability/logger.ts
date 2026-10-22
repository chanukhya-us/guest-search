/**
 * Application logger factory (task 9.1; design.md "apps/bff — observability" → logger.ts;
 * Req 22.1, 22.3, 22.4).
 *
 * This is the one place that constructs the application-wide pino logger and the Fastify logger
 * options that drive it. Everything here serves a single privacy invariant: **a guest's PII or a
 * secret can never reach a log line, even if a developer accidentally hands it to the logger.**
 * The service and gateway already log only field NAMES, counts, statuses and codes (never values),
 * so redaction is the *secondary* safeguard Req 22.4 asks for — a backstop for mistakes, not the
 * primary control.
 *
 * ## What the logger guarantees
 *   - **Structured JSON** with a UTC ISO 8601 `time` (`pino.stdTimeFunctions.isoTime`), the `level`,
 *     and the base fields `{ service, env }` on every line (Req 22.1). The per-request child the
 *     Fastify integration creates carries `reqId` (Fastify's `requestIdLogLabel`), so every request
 *     line is correlatable to the `X-Request-ID` the request-id plugin emits (Req 22.1, 22.10).
 *   - **Redaction with removal** (`redact.remove: true`): any configured path is deleted from the
 *     serialized record rather than replaced with a visible marker, so a redacted value leaves no
 *     residue at all. The path list below covers cookies, the authorization header, `set-cookie`,
 *     every guest contact/identity field, reveal tokens, credit-card data and the raw `criteria`
 *     object (Req 22.3, 22.4). `*.`-prefixed paths match the field at any nesting depth, so an
 *     object logged under any key is still scrubbed.
 *   - **A path-only request serializer** (Req 22.3): the request is logged as `{ method, url, id }`
 *     with the query string stripped from `url`, so a criteria value that ever leaked into a query
 *     string (it never should — Req 6.9) still cannot reach the log. The response serializer logs
 *     only the status code.
 *
 * ## Dev vs prod transport
 * Production (and tests) log newline-delimited JSON to the default destination (stdout), which is
 * what log shippers expect and what the log-leak test (task 10.3) captures. A pretty, colourised
 * transport is *optional* in development and is enabled only when `pino-pretty` is actually
 * installed; it is not a dependency, so `createLogger` probes for it and silently falls back to
 * JSON when it is absent. This keeps `build`/`typecheck`/CI green without pulling a dev-only module
 * into the dependency graph, while still giving a nicer local experience when a developer adds it.
 *
 * ## Why the Fastify options live here too
 * `buildApp` passes a single logger instance to `Fastify({ logger })`; Fastify then builds the
 * per-request child itself. But the request/response *serializers* and the `reqId` label are
 * Fastify-level concerns that must agree with this module's redaction, so `fastifyLoggerOptions`
 * returns them alongside the instance. Keeping both in one file means the redaction paths and the
 * serializers can never drift apart.
 */
import type { FastifyBaseLogger } from 'fastify';
import pino, { type Logger, type LoggerOptions } from 'pino';

import type { AppConfig } from '../config.js';

/** The logger service name, emitted as a base field on every line (design.md base fields). */
export const SERVICE_NAME = 'guest-search-bff';

/**
 * Redaction paths (design.md "Redaction paths", Req 22.3, 22.4). Every path is removed
 * (`redact.remove: true`) from the serialized record. Two shapes are used:
 *   - exact header paths (`req.headers.cookie`, …) — scrub the sensitive request/response headers;
 *   - `*.field` wildcards — scrub a field wherever it appears in the logged object graph, so a
 *     guest, a criteria object or a reveal entry logged under ANY key is still cleaned.
 *
 * The list is intentionally a superset of what the app ever logs on purpose: it is the backstop
 * for an accidental `log.info({ guest })`, so it must name every PII / secret / token field the
 * domain and the HTTP layer know about.
 */
export const REDACT_PATHS: readonly string[] = [
  // --- request / response headers (secrets + session material) ---
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  // --- guest identity / contact PII (any nesting depth) ---
  '*.firstName',
  '*.lastName',
  '*.email',
  '*.emails',
  '*.phone',
  '*.phones',
  '*.address',
  '*.addresses',
  '*.addressLine1',
  '*.addressLine2',
  '*.postalCode',
  '*.loyaltyMemberId',
  '*.memberId',
  '*.enterpriseId',
  // --- reveal tokens and secrets ---
  '*.revealToken',
  '*.token',
  '*.creditCard',
  // --- the raw search criteria object (values; field NAMES are logged separately) ---
  '*.criteria',
];

/**
 * A minimal structural view of the fields we read off a logged HTTP request for the serializer.
 * Pino/Fastify pass the real `FastifyRequest`; we only touch these properties, so typing to the
 * subset keeps the serializer independent of the Fastify type and trivially unit-testable.
 */
interface SerializableRequest {
  readonly method?: string;
  readonly url?: string;
  readonly id?: string;
}

interface SerializableResponse {
  readonly statusCode?: number;
}

/**
 * Request serializer: log the method, the PATH ONLY (query string stripped) and the request id
 * (Req 22.3, 22.4). Never the headers (redaction would catch cookie/authorization, but we also
 * never need the rest) and never the query string, which could in theory carry a value.
 */
export function serializeRequest(req: SerializableRequest): {
  method: string | undefined;
  url: string | undefined;
  id: string | undefined;
} {
  const rawUrl = req.url;
  const url = typeof rawUrl === 'string' ? (rawUrl.split('?', 1)[0] ?? rawUrl) : rawUrl;
  return { method: req.method, url, id: req.id };
}

/** Response serializer: the status code only, never headers or body. */
export function serializeResponse(res: SerializableResponse): { statusCode: number | undefined } {
  return { statusCode: res.statusCode };
}

/** Shared pino options (base fields, ISO UTC time, redaction). Used for the instance and tests. */
export function baseLoggerOptions(config: Pick<AppConfig, 'log' | 'nodeEnv'>): LoggerOptions {
  return {
    level: config.log.level,
    base: { service: SERVICE_NAME, env: config.nodeEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], remove: true },
  };
}

/** Options for creating the application logger. The destination is injectable for tests. */
export interface CreateLoggerOptions {
  /**
   * A pino destination/stream. Tests pass an in-memory sink (`pino` writable) to capture lines;
   * production omits it so pino writes NDJSON to stdout. When a pretty transport is selected in
   * development, this is ignored (the transport owns the destination).
   */
  readonly destination?: pino.DestinationStream;
  /**
   * Force the pretty dev transport on/off. Defaults to "auto": pretty in development when
   * `pino-pretty` is resolvable, JSON otherwise. Tests leave this at its JSON default.
   */
  readonly pretty?: boolean;
}

/** True when `pino-pretty` can be resolved, so the dev transport is safe to request. */
function prettyAvailable(): boolean {
  try {
    // `import.meta.resolve` is sync and throws when the module is absent; no dependency is added.
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the application logger from configuration.
 *
 * In development, when `pino-pretty` is installed (or `pretty: true` is forced with it present),
 * the logger uses a colourised single-line transport; otherwise it emits NDJSON. A redaction and
 * base-field configuration identical to {@link baseLoggerOptions} applies in every mode.
 */
export function createLogger(
  config: Pick<AppConfig, 'log' | 'nodeEnv'>,
  options: CreateLoggerOptions = {},
): Logger {
  const base = baseLoggerOptions(config);
  const wantPretty = options.pretty ?? config.nodeEnv === 'development';

  if (wantPretty && prettyAvailable()) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
    });
  }

  return options.destination === undefined ? pino(base) : pino(base, options.destination);
}

/**
 * Fastify logger wiring: the shared instance plus the request/response serializers, so Fastify's
 * per-request child logs a path-only request and carries the request id under `reqId` (which
 * equals the `X-Request-ID` the request-id plugin emits). `buildApp` spreads this into
 * `Fastify({...})`.
 *
 * Fastify 5 takes a custom pino instance under `loggerInstance` (the `logger` option accepts only a
 * boolean or a config object); passing an instance to `logger` throws. The serializers are
 * top-level instance options Fastify applies to the per-request child. Fastify's default
 * `requestIdLogLabel` is already `reqId`, so the per-request child logs the request id under
 * `reqId` without any extra option (the explicit top-level option is deprecated in Fastify 5).
 */
export function fastifyLoggerOptions(logger: Logger): {
  loggerInstance: FastifyBaseLogger;
  serializers: {
    req: typeof serializeRequest;
    res: typeof serializeResponse;
  };
} {
  // Typed as `FastifyBaseLogger` (not pino's `Logger`) so Fastify's generics keep the instance at
  // its default logger type; a pino `Logger` satisfies `FastifyBaseLogger` structurally. Without
  // this, `Fastify({ loggerInstance })` would narrow `FastifyInstance` to pino's `Logger` and
  // clash with every plugin/route typed against the default `FastifyBaseLogger`.
  return {
    loggerInstance: logger,
    serializers: { req: serializeRequest, res: serializeResponse },
  };
}
