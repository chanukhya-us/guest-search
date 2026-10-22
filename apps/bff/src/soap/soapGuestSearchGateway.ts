/**
 * SOAP adapter for the `GuestSearchGateway` port (Req 6.8, 10.9; design.md
 * "SoapGuestSearchGateway").
 *
 * Flow: header context (injected clock, transaction id = requestId) → request mapper →
 * transport → response parser → `{ results, limit }`.
 *
 * HTTP status rule (Req 10.9):
 *   | Status   | Parser outcome                 | Result                              |
 *   |----------|--------------------------------|-------------------------------------|
 *   | 2xx      | results / any SoapError        | results / that error (2xx Fault → FAULT) |
 *   | non-2xx  | UPSTREAM_FAULT                 | UPSTREAM_FAULT                      |
 *   | non-2xx  | results or any other SoapError | UPSTREAM_HTTP_ERROR, detail = status |
 * 3xx counts as non-2xx: the transport never follows redirects (SSRF guard). Transport errors
 * (TIMEOUT, UNAVAILABLE, MALFORMED) and the mapper's INTERNAL_ERROR propagate unchanged.
 *
 * Decisions:
 *   - The `guestSearch.soap` span covers the whole adapter call (mapping, transport and
 *     parsing), not just `transport.send`. The span then carries the final outcome: the
 *     result count, and `error.type` for parse and HTTP-status errors that only exist after
 *     parsing. Mapping is microseconds, so the span duration stays a SOAP-call measure;
 *     `soap.duration_ms` is the transport's own wall time.
 *   - Span attributes are non-PII only (Req 22.6): status code, duration, result count,
 *     error code, request id (a random correlation id). No criteria, no payload, no header
 *     values. Exceptions are not recorded with `recordException`; the span status message is
 *     the error code only.
 *   - Logs carry requestId, status, durationMs, resultCount, errorCode and detail (a
 *     sanitized fault/status code), never payloads (Req 22.3). Logger and metrics are
 *     optional until task 9 wires pino and the OTel meter; defaults are no-ops.
 */
import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type {
  GuestSearchContext,
  GuestSearchGateway,
  GuestSearchOutcome,
} from '../ports/GuestSearchGateway.js';
import { createHeaderContext } from './headerBuilder.js';
import { buildSearchGuestRequest } from './requestMapper.js';
import { SoapError, parseSearchGuestResponse } from './responseParser.js';
import type { SoapHttpResult, SoapTransport } from './transport.js';

export const TRACER_NAME = 'ihg-guest-search';
export const SPAN_NAME = 'guestSearch.soap';
/** OTel semconv fallback `error.type` for an error without a catalog code. */
export const OTHER_ERROR = '_OTHER';

/** Structural subset of pino's `Logger` used here (task 9 passes the real logger). */
export interface GatewayLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

/** Instruments the gateway feeds (task 9 maps these onto `gs.soap.*` meters, Req 22.7). */
export interface GatewayMetrics {
  /** One completed HTTP exchange (any status). */
  soapCall(durationMs: number, attrs: { status: number }): void;
}

export interface SoapGatewayDeps {
  cfg: AppConfig['soap'];
  transport: SoapTransport;
  now: () => Date;
  logger?: GatewayLogger;
  metrics?: GatewayMetrics;
  /** Defaults to `trace.getTracer(TRACER_NAME)` (a no-op until an SDK is registered). */
  tracer?: Tracer;
}

const NOOP_LOGGER: GatewayLogger = { info: () => undefined, warn: () => undefined };
const NOOP_METRICS: GatewayMetrics = { soapCall: () => undefined };

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** The catalog code of a typed error, else `_OTHER`. Never the message. */
function errorType(e: unknown): string {
  return e instanceof SoapError || e instanceof AppError ? e.code : OTHER_ERROR;
}

export class SoapGuestSearchGateway implements GuestSearchGateway {
  private readonly cfg: AppConfig['soap'];
  private readonly transport: SoapTransport;
  private readonly now: () => Date;
  private readonly logger: GatewayLogger;
  private readonly metrics: GatewayMetrics;
  private readonly tracer: Tracer;

  constructor(deps: SoapGatewayDeps) {
    this.cfg = deps.cfg;
    this.transport = deps.transport;
    this.now = deps.now;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  search(query: GuestSearchQuery, ctx: GuestSearchContext): Promise<GuestSearchOutcome> {
    return this.tracer.startActiveSpan(SPAN_NAME, async (span) => {
      span.setAttribute('request.id', ctx.requestId);
      let res: SoapHttpResult | undefined;
      try {
        const header = createHeaderContext(this.cfg.header, {
          now: this.now,
          requestId: ctx.requestId,
        });
        const envelope = buildSearchGuestRequest(query, header, {
          maxResults: this.cfg.maxResults,
          features: this.cfg.features,
        });
        res = await this.transport.send(envelope, { requestId: ctx.requestId });
        span.setAttribute('http.response.status_code', res.status);
        span.setAttribute('soap.duration_ms', res.durationMs);
        this.metrics.soapCall(res.durationMs, { status: res.status });

        const results = interpret(res);
        span.setAttribute('soap.result_count', results.length);
        this.logger.info(
          {
            requestId: ctx.requestId,
            status: res.status,
            durationMs: res.durationMs,
            resultCount: results.length,
          },
          'SOAP searchGuest completed',
        );
        return { results, limit: this.cfg.maxResults };
      } catch (e) {
        failSpan(span, e);
        this.logger.warn(
          {
            requestId: ctx.requestId,
            ...(res && { status: res.status, durationMs: res.durationMs }),
            errorCode: errorType(e),
            ...(e instanceof SoapError && e.detail !== undefined && { detail: e.detail }),
          },
          'SOAP searchGuest failed',
        );
        throw e;
      } finally {
        span.end();
      }
    });
  }
}

/** Apply the Req 10.9 status rule to one HTTP exchange. */
function interpret(res: SoapHttpResult) {
  const httpError = () => new SoapError('UPSTREAM_HTTP_ERROR', String(res.status));
  let results;
  try {
    results = parseSearchGuestResponse(res.body);
  } catch (e) {
    if (!isSuccess(res.status) && !(e instanceof SoapError && e.code === 'UPSTREAM_FAULT')) {
      throw httpError();
    }
    throw e;
  }
  if (!isSuccess(res.status)) throw httpError();
  return results;
}

function failSpan(span: Span, e: unknown): void {
  const type = errorType(e);
  span.setAttribute('error.type', type);
  span.setStatus({ code: SpanStatusCode.ERROR, message: type });
}
