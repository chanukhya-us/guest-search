/**
 * Readiness probe for `GET /health/ready` (task 8.6; Req 22.9; design.md "Routes").
 *
 * Liveness (`/health/live`) answers "is the process up?" — a static `{ status: 'ok' }` that the
 * route returns directly. Readiness answers "can we actually serve a search?" and therefore
 * includes a cheap reachability check of the SOAP endpoint.
 *
 * ## Why a TCP connect, not a SOAP call (design.md, appsec review)
 * The readiness probe opens a raw TCP socket to the configured SOAP host and port and closes it
 * the moment the connection succeeds. It never sends a SOAP envelope, so:
 *   - no credentials, header values or transaction ids are used or logged (Req 8 secrets stay
 *     out of an unauthenticated endpoint), and
 *   - the upstream is not billed or load-tested by our health checks.
 * A successful connect proves the host resolves and the port accepts connections; that is the
 * strongest signal we can get without a real request, and it is enough for a load balancer to
 * decide whether to route traffic here.
 *
 * ## Timeout and cache (Req 22.9)
 * The connect is bounded by a 1 s timeout so a hung upstream cannot stall the probe. The result
 * is cached for 30 s so a burst of readiness polls (Kubernetes probes, a load balancer health
 * check) collapses to at most one TCP connect per 30 s window — the probe must not become its
 * own source of load on the upstream. The clock, the connector and the timing values are all
 * injected so the cache and timeout are deterministically testable (task 8.7 / 10.x).
 *
 * `check()` never rejects: any failure (DNS, refused, timeout, bad URL) resolves to
 * `{ soap: false }`, so the route can always answer and simply reports `status: 'degraded'`.
 */
import net from 'node:net';

/** The readiness result the route serialises under `checks`. */
export interface ReadinessChecks {
  /** Configuration loaded and valid — always true once the process is up (loadConfig ran). */
  readonly config: boolean;
  /** The SOAP endpoint accepted a TCP connection within the timeout. */
  readonly soap: boolean;
}

/** Opens a TCP connection and resolves true on `connect`, false on error/timeout. */
export type TcpConnector = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export interface ReadinessOptions {
  /** The SOAP endpoint URL; host and port are derived from it. */
  readonly endpoint: URL;
  /** Connect timeout in milliseconds (Req 22.9: 1 s). */
  readonly timeoutMs?: number;
  /** Cache window in milliseconds (Req 22.9: 30 s). */
  readonly cacheMs?: number;
  /** Millisecond clock, injected for deterministic cache tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** TCP connector, injected in tests. Defaults to a `node:net` socket probe. */
  readonly connect?: TcpConnector;
}

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_MS = 30_000;

/** Default port for a URL whose port is implicit (`https:` → 443, else 80). */
function portOf(endpoint: URL): number {
  if (endpoint.port !== '') return Number(endpoint.port);
  return endpoint.protocol === 'https:' ? 443 : 80;
}

/** A real TCP connect probe: resolves true on connect, false on any error or the timeout. */
const tcpConnect: TcpConnector = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });

/**
 * Readiness checker with a cached, timeout-bounded TCP reachability probe. Construct once in
 * `buildApp`; the route calls `check()` on every `GET /health/ready`.
 */
export class ReadinessChecker {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly connect: TcpConnector;

  private cached: { at: number; soap: boolean } | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(opts: ReadinessOptions) {
    this.host = opts.endpoint.hostname;
    this.port = portOf(opts.endpoint);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheMs = opts.cacheMs ?? DEFAULT_CACHE_MS;
    this.now = opts.now ?? Date.now;
    this.connect = opts.connect ?? tcpConnect;
  }

  /** Resolve the readiness checks, reusing a probe result cached within the window. */
  async check(): Promise<ReadinessChecks> {
    const soap = await this.probeSoap();
    return { config: true, soap };
  }

  /** Probe the SOAP endpoint, honouring the cache and collapsing concurrent probes. */
  private async probeSoap(): Promise<boolean> {
    const nowMs = this.now();
    if (this.cached !== null && nowMs - this.cached.at < this.cacheMs) {
      return this.cached.soap;
    }
    // Collapse a burst of concurrent probes (all cache-miss) onto one TCP connect.
    this.inFlight ??= this.connect(this.host, this.port, this.timeoutMs).then((soap) => {
      this.cached = { at: this.now(), soap };
      this.inFlight = null;
      return soap;
    });
    return this.inFlight;
  }
}
