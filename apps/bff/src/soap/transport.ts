/**
 * SOAP HTTP transport (Req 10.1–10.6, 10.8; design.md "transport.ts + circuitBreaker.ts").
 *
 * HTTP client: undici's own `fetch` paired with an undici `Agent` from the same package.
 * Node's bundled fetch rejects an Agent from a different undici major (`UND_ERR_INVALID_ARG`),
 * so the pair always comes from the pinned `undici` dependency.
 *   - `deps.fetch` absent: undici `fetch` + `deps.dispatcher ?? createSoapAgent(cfg)`.
 *   - `deps.fetch` injected (tests, MSW 3 via `globalThis.fetch`): a dispatcher is passed
 *     only if `deps.dispatcher` is also given. MSW patches `globalThis.fetch` only and does
 *     not see undici's own fetch.
 *
 * One `send` = one `breaker.exec` that holds both attempts. The breaker counts logical calls,
 * so a refused connection (two attempts) is one failure, and the retry cannot be rejected
 * half-way by a breaker that the first attempt just opened.
 *
 * Error classification (`SoapError` codes):
 *   | Condition                                                 | Code                 | Retry |
 *   |-----------------------------------------------------------|----------------------|-------|
 *   | Response timeout (signal fired; headers or body phase)    | UPSTREAM_TIMEOUT     | no    |
 *   | Connection failure before headers (CONNECT_CODES)         | UPSTREAM_UNAVAILABLE | once  |
 *   | TLS / certificate failure before headers                  | UPSTREAM_UNAVAILABLE | no    |
 *   | Any other pre-response fetch failure                      | UPSTREAM_UNAVAILABLE | no    |
 *   | Body stream error after headers                           | UPSTREAM_UNAVAILABLE | no    |
 *   | Body over `maxResponseBytes` (Content-Length or streamed) | UPSTREAM_MALFORMED   | no    |
 *   | Non-2xx status                                            | none: `{status, body}` returned to the gateway (Req 10.9) |
 *
 * Decisions:
 *   - TLS failures are not retried: a bad or expired certificate is deterministic, so a retry
 *     only doubles latency. Certificate verification is never disabled.
 *   - Mid-body stream errors are UNAVAILABLE (the connection broke; the breaker should count
 *     it), and not retried because response bytes were already received (Req 10.5).
 *   - Retrying `UND_ERR_SOCKET` / `ECONNRESET` is safe: searchGuest is a read-only query.
 *   - The response timeout covers headers + body of each attempt; the retry gets a fresh one.
 *   - `redirect: 'manual'`: the endpoint comes from config only, so a 3xx is never followed
 *     (SSRF guard); it reaches the gateway as a non-2xx status.
 *   - `ctx.requestId` is for logging by the caller; it is never sent. Nothing request-specific
 *     goes into the URL or headers (Req 6.9).
 */
import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { AppConfig } from '../config.js';
import { StartupError } from '../errors.js';
import type { CircuitBreaker } from './circuitBreaker.js';
import { SoapError } from './responseParser.js';

export interface SoapHttpResult {
  status: number;
  body: string;
  durationMs: number;
}

export interface SoapTransport {
  send(envelope: string, ctx: { requestId: string }): Promise<SoapHttpResult>;
}

/** The request init the transport passes to `fetch`. */
export interface SoapFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: 'manual';
  dispatcher?: Dispatcher;
}

/** The response surface the transport uses (global `Response` and undici's `Response`). */
export interface SoapFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type SoapFetch = (url: string, init: SoapFetchInit) => Promise<SoapFetchResponse>;

export interface SoapTransportDeps {
  breaker: CircuitBreaker;
  fetch?: SoapFetch;
  dispatcher?: Dispatcher;
  /** Millisecond clock for `durationMs`; defaults to `performance.now`. */
  now?: () => number;
  /** File reader for TLS material; defaults to `fs.readFileSync`. */
  readFile?: (path: string) => Buffer;
}

export const CONTENT_TYPE = 'text/xml; charset=utf-8';
export const ACCEPT = '*/*';

/** Connection failures before headers that get the single retry (Req 10.5). */
export const CONNECT_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const TLS_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EPROTO',
]);
const TLS_PREFIX = /^(?:CERT_|ERR_TLS_|ERR_SSL_)/;

/** `SoapError.detail` values set by the transport. */
export const DETAIL = {
  tls: 'TLS',
  fetchFailed: 'FETCH_FAILED',
  bodyStream: 'BODY_STREAM',
  bodyTooLarge: 'BODY_TOO_LARGE',
} as const;

const TLS_KEYS = {
  caFile: 'SOAP_TLS_CA_FILE',
  certFile: 'SOAP_TLS_CERT_FILE',
  keyFile: 'SOAP_TLS_KEY_FILE',
} as const;

/**
 * Build the undici Agent: connect timeout plus optional CA and client certificate (mTLS,
 * Req 10.8). Files are read once, here. `rejectUnauthorized` is always true.
 * @throws StartupError naming the config key (never file content) on unreadable files or a
 *   cert without a key (or vice versa).
 */
export function createSoapAgent(
  cfg: AppConfig['soap'],
  readFile: (path: string) => Buffer = readFileSync,
): Agent {
  const tls = cfg.tls ?? {};
  if ((tls.certFile === undefined) !== (tls.keyFile === undefined)) {
    throw new StartupError('SOAP mTLS needs both a client certificate and a key', {
      invalid: [TLS_KEYS.certFile, TLS_KEYS.keyFile],
    });
  }
  const load = (field: keyof typeof TLS_KEYS): Buffer | undefined => {
    const path = tls[field];
    if (path === undefined) return undefined;
    try {
      return readFile(path);
    } catch {
      throw new StartupError(`Cannot read ${TLS_KEYS[field]}`, { invalid: [TLS_KEYS[field]] });
    }
  };
  const ca = load('caFile');
  const cert = load('certFile');
  const key = load('keyFile');
  return new Agent({
    connect: {
      timeout: cfg.connectTimeoutMs,
      rejectUnauthorized: true,
      ...(ca && { ca }),
      ...(cert && { cert }),
      ...(key && { key }),
    },
  });
}

export function createSoapTransport(
  cfg: AppConfig['soap'],
  deps: SoapTransportDeps,
): SoapTransport {
  const fetchFn: SoapFetch = deps.fetch ?? (undiciFetch as unknown as SoapFetch);
  const dispatcher =
    deps.fetch === undefined
      ? (deps.dispatcher ?? createSoapAgent(cfg, deps.readFile))
      : deps.dispatcher;
  const now = deps.now ?? (() => performance.now());
  const url = cfg.endpoint.href;
  // As in the team's sample request (docs/Request.txt): SOAPAction exactly as configured (the
  // sample sends it unquoted), IHG-ChannelId and Accept. Config values cannot hold control
  // characters (config.ts), so no header injection is possible.
  const headers = {
    'content-type': CONTENT_TYPE,
    soapaction: cfg.soapAction,
    'ihg-channelid': cfg.channelId,
    accept: ACCEPT,
  };

  const attempt = async (envelope: string): Promise<{ status: number; body: string }> => {
    const signal = AbortSignal.timeout(cfg.responseTimeoutMs);
    let res: SoapFetchResponse;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { ...headers },
        body: envelope,
        signal,
        redirect: 'manual',
        ...(dispatcher && { dispatcher }),
      });
    } catch (e) {
      throw classifyPreResponse(e, signal);
    }
    try {
      return { status: res.status, body: await readCapped(res, cfg.maxResponseBytes) };
    } catch (e) {
      if (e instanceof SoapError) throw e;
      throw signal.aborted || isAbort(e)
        ? new SoapError('UPSTREAM_TIMEOUT')
        : new SoapError('UPSTREAM_UNAVAILABLE', DETAIL.bodyStream);
    }
  };

  return {
    async send(envelope) {
      const started = now();
      const result = await deps.breaker.exec(async () => {
        try {
          return await attempt(envelope);
        } catch (e) {
          if (!(e instanceof RetryableError)) throw e;
          try {
            return await attempt(envelope);
          } catch (e2) {
            throw e2 instanceof RetryableError ? e2.soapError : e2;
          }
        }
      });
      return { ...result, durationMs: now() - started };
    },
  };
}

/** A pre-response connection failure; carries the error to report if the retry fails too. */
class RetryableError extends Error {
  constructor(readonly soapError: SoapError) {
    super(soapError.message);
  }
}

function classifyPreResponse(e: unknown, signal: AbortSignal): Error {
  if (signal.aborted || isAbort(e)) return new SoapError('UPSTREAM_TIMEOUT');
  const codes = errorCodes(e);
  // TLS wins over a connection code in the same chain: never retry a certificate failure.
  if (codes.some((c) => TLS_CODES.has(c) || TLS_PREFIX.test(c))) {
    return new SoapError('UPSTREAM_UNAVAILABLE', DETAIL.tls);
  }
  const connect = codes.find((c) => CONNECT_CODES.has(c));
  if (connect !== undefined) {
    return new RetryableError(new SoapError('UPSTREAM_UNAVAILABLE', connect));
  }
  return new SoapError('UPSTREAM_UNAVAILABLE', DETAIL.fetchFailed);
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

/**
 * Every `code` on the error, its `cause` chain and `AggregateError.errors` (fetch wraps the
 * socket error in `TypeError('fetch failed')`; happy-eyeballs yields an AggregateError).
 */
function errorCodes(e: unknown, depth = 0): string[] {
  if (depth > 4 || typeof e !== 'object' || e === null) return [];
  const { code, cause, errors } = e as { code?: unknown; cause?: unknown; errors?: unknown };
  const own = typeof code === 'string' ? [code] : [];
  const nested = Array.isArray(errors) ? errors.flatMap((x) => errorCodes(x, depth + 1)) : [];
  return [...own, ...errorCodes(cause, depth + 1), ...nested];
}

/** Read the body as UTF-8, stopping once it passes `max` bytes (Req 10.6). */
async function readCapped(res: SoapFetchResponse, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    throw new SoapError('UPSTREAM_MALFORMED', DETAIL.bodyTooLarge);
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      throw new SoapError('UPSTREAM_MALFORMED', DETAIL.bodyTooLarge);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
