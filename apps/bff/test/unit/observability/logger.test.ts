// Application logger factory and redaction (task 9.1; design.md "apps/bff — observability" →
// logger.ts; Req 22.1, 22.3, 22.4).
//
// These tests exercise the REAL pino logger built by `createLogger`, writing to an in-memory sink
// so each emitted NDJSON line can be parsed and asserted. The redaction test is the privacy
// backstop Req 22.4 asks for: it logs an object stuffed with fake PII, a secret, a cookie and a
// token, then proves every configured path is GONE from the serialized line (not merely marked)
// and that the raw values never appear anywhere in the output.
import { Writable } from 'node:stream';

import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../../src/config.js';
import {
  REDACT_PATHS,
  SERVICE_NAME,
  baseLoggerOptions,
  createLogger,
  fastifyLoggerOptions,
  serializeRequest,
  serializeResponse,
} from '../../../src/observability/logger.js';

/** A pino destination that keeps every written chunk, so a test can parse the emitted lines. */
function sink(): DestinationStream & { lines(): Record<string, unknown>[]; text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return Object.assign(stream as unknown as DestinationStream, {
    text: (): string => chunks.join(''),
    lines: (): Record<string, unknown>[] =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  });
}

function cfg(overrides: Partial<AppConfig> = {}): Pick<AppConfig, 'log' | 'nodeEnv'> {
  return {
    nodeEnv: 'test',
    log: { level: 'info', auditLogPath: 'logs/audit.jsonl' },
    ...overrides,
  };
}

describe('createLogger — base fields, level and time (Req 22.1)', () => {
  it('builds a logger at the configured level with service and env base fields', () => {
    const dest = sink();
    const log = createLogger(cfg({ log: { level: 'debug', auditLogPath: 'x' } }), {
      destination: dest,
    });
    log.debug({ event: 'probe' }, 'hello');

    const [line] = dest.lines();
    expect(line).toBeDefined();
    expect(line?.service).toBe(SERVICE_NAME);
    expect(line?.env).toBe('test');
    expect(line?.level).toBe(20); // pino numeric level for debug
    expect(line?.event).toBe('probe');
  });

  it('honours the level: a line below the configured level is not emitted', () => {
    const dest = sink();
    const log = createLogger(cfg({ log: { level: 'warn', auditLogPath: 'x' } }), {
      destination: dest,
    });
    log.info({ event: 'ignored' }, 'below threshold');
    log.warn({ event: 'kept' }, 'at threshold');

    const events = dest.lines().map((l) => l.event);
    expect(events).toEqual(['kept']);
  });

  it('writes an ISO 8601 UTC timestamp under `time`', () => {
    const dest = sink();
    const log = createLogger(cfg(), { destination: dest });
    log.info({ event: 'ts' }, 'timestamped');

    const [line] = dest.lines();
    const time = line?.time;
    expect(typeof time).toBe('string');
    // ISO 8601 UTC with milliseconds and a trailing Z.
    expect(time as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(time as string).toISOString()).toBe(time);
  });

  it('baseLoggerOptions configures removal-based redaction with the full path list', () => {
    const opts = baseLoggerOptions(cfg());
    expect(opts.redact).toEqual({ paths: [...REDACT_PATHS], remove: true });
    expect(opts.base).toEqual({ service: SERVICE_NAME, env: 'test' });
  });
});

// A record that touches every redaction path, with recognisable marker values so the test can
// assert each one is ABSENT from the serialized output. Nested under `guest`/`req`/`res` to prove
// the `*.field` wildcards scrub at depth and the exact header paths scrub headers.
const PII_MARKERS = {
  firstName: 'MARKER_FIRST',
  lastName: 'MARKER_LAST',
  email: 'marker-direct@example.test',
  phone: 'MARKER_PHONE_5550001',
  loyaltyMemberId: 'MARKER_LOYALTY_900',
  memberId: 'MARKER_MEMBERID_901',
  enterpriseId: 'MARKER_ENTERPRISE_902',
  revealToken: 'rt_MARKER_TOKEN',
  token: 'MARKER_BARE_TOKEN',
  creditCard: 'MARKER_PAN_4111',
  addressLine1: 'MARKER_STREET',
  addressLine2: 'MARKER_APT',
  postalCode: 'MARKER_ZIP',
} as const;

const COOKIE_MARKER = 'gs_session=MARKER_COOKIE_VALUE';
const AUTH_MARKER = 'Bearer MARKER_AUTH_TOKEN';
const SET_COOKIE_MARKER = '__Host-Http-gs_session=MARKER_SET_COOKIE';
const CRITERIA_MARKER = { lastName: 'MARKER_CRITERIA_LAST', email: 'MARKER_CRITERIA_EMAIL' };
const EMAILS_MARKER = [{ address: 'marker-collection@example.test' }];
const ADDRESSES_MARKER = [{ city: 'MarkerCity', postalCode: 'MARKER_ZIP2' }];

describe('redaction removes every sensitive path (Req 22.3, 22.4)', () => {
  function emitPiiLine(): { text: string; line: Record<string, unknown> } {
    const dest = sink();
    const log = createLogger(cfg(), { destination: dest });
    log.info(
      {
        event: 'guest.search.leak-attempt',
        // Nested guest object with direct PII fields (wildcard paths at depth).
        guest: {
          ...PII_MARKERS,
          emails: EMAILS_MARKER,
          addresses: ADDRESSES_MARKER,
        },
        // The raw criteria object, logged under a key (as it ever would be): the `*.criteria`
        // wildcard scrubs it. Field NAMES are logged separately by the service.
        body: { criteria: CRITERIA_MARKER },
        // HTTP header carriers for the exact-path redactions.
        req: { headers: { cookie: COOKIE_MARKER, authorization: AUTH_MARKER } },
        res: { headers: { 'set-cookie': SET_COOKIE_MARKER } },
      },
      'attempted to log PII',
    );
    const [line] = dest.lines();
    return { text: dest.text(), line: line as Record<string, unknown> };
  }

  it('leaves no marker value anywhere in the serialized output', () => {
    const { text } = emitPiiLine();
    const markers = [
      ...Object.values(PII_MARKERS),
      COOKIE_MARKER,
      AUTH_MARKER,
      SET_COOKIE_MARKER,
      CRITERIA_MARKER.lastName,
      CRITERIA_MARKER.email,
      EMAILS_MARKER[0]?.address,
      ADDRESSES_MARKER[0]?.postalCode,
    ].filter((v): v is string => typeof v === 'string');

    for (const marker of markers) {
      expect(text, `expected marker ${marker} to be redacted`).not.toContain(marker);
    }
  });

  it('removes the fields entirely rather than replacing them with a visible censor', () => {
    const { line } = emitPiiLine();
    const guest = line.guest as Record<string, unknown>;
    // Every PII field under guest is gone (remove: true), leaving only non-PII keys.
    for (const key of Object.keys(PII_MARKERS)) {
      expect(guest).not.toHaveProperty(key);
    }
    expect(guest).not.toHaveProperty('emails');
    expect(guest).not.toHaveProperty('addresses');
    // The whole criteria object (logged under `body`) is removed by the `*.criteria` wildcard.
    const body = line.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('criteria');
    // Headers scrubbed by exact path.
    const req = line.req as { headers?: Record<string, unknown> };
    const res = line.res as { headers?: Record<string, unknown> };
    expect(req.headers).not.toHaveProperty('cookie');
    expect(req.headers).not.toHaveProperty('authorization');
    expect(res.headers).not.toHaveProperty('set-cookie');
    // The non-sensitive event name survives, proving the line itself was still written.
    expect(line.event).toBe('guest.search.leak-attempt');
  });

  it('each documented path appears in REDACT_PATHS', () => {
    for (const key of Object.keys(PII_MARKERS)) {
      expect(REDACT_PATHS).toContain(`*.${key}`);
    }
    expect(REDACT_PATHS).toContain('req.headers.cookie');
    expect(REDACT_PATHS).toContain('req.headers.authorization');
    expect(REDACT_PATHS).toContain('res.headers["set-cookie"]');
    expect(REDACT_PATHS).toContain('*.criteria');
    expect(REDACT_PATHS).toContain('*.emails');
    expect(REDACT_PATHS).toContain('*.addresses');
  });
});

describe('transport selection branches', () => {
  it('defaults to pretty intent in development but falls back to JSON when pino-pretty is absent', () => {
    // nodeEnv=development with `pretty` unset exercises the default `=== development` branch.
    // pino-pretty is not a dependency, so `prettyAvailable()` is false and the logger must still
    // build (JSON), proving the fallback keeps dev runs working without the optional module.
    const dest = sink();
    const log = createLogger(cfg({ nodeEnv: 'development' }), { destination: dest });
    log.info({ event: 'dev' }, 'dev mode');
    expect(dest.lines()[0]?.event).toBe('dev');
  });

  it('honours an explicit pretty:true but falls back to JSON when pino-pretty is absent', () => {
    const dest = sink();
    const log = createLogger(cfg(), { pretty: true, destination: dest });
    log.info({ event: 'forced-pretty' }, 'forced');
    expect(dest.lines()[0]?.event).toBe('forced-pretty');
  });

  it('builds a logger with no destination (production default stream)', () => {
    // No destination and no pretty → `pino(base)` to stdout. We only assert it constructs and is
    // usable; it writes to the process stream, which we do not capture here.
    const log = createLogger(cfg({ nodeEnv: 'production' }), { pretty: false });
    expect(typeof log.info).toBe('function');
    expect(log.level).toBe('info');
  });
});

describe('request/response serializers (Req 22.3)', () => {
  it('logs the method, the path only (query stripped) and the id', () => {
    expect(
      serializeRequest({
        method: 'POST',
        url: '/api/v1/guests/search?lastName=Secret&email=leak@example.test',
        id: 'req-123',
      }),
    ).toEqual({ method: 'POST', url: '/api/v1/guests/search', id: 'req-123' });
  });

  it('passes through a URL with no query unchanged', () => {
    expect(serializeRequest({ method: 'GET', url: '/health/live', id: 'r' })).toEqual({
      method: 'GET',
      url: '/health/live',
      id: 'r',
    });
  });

  it('logs only the status code from the response', () => {
    expect(serializeResponse({ statusCode: 200 })).toEqual({ statusCode: 200 });
  });

  it('fastifyLoggerOptions wires the reqId label and the path-only serializers', () => {
    const dest = sink();
    const log = createLogger(cfg(), { destination: dest });
    const opts = fastifyLoggerOptions(log);
    expect(opts.serializers.req).toBe(serializeRequest);
    expect(opts.serializers.res).toBe(serializeResponse);
    expect(opts.loggerInstance).toBe(log);
  });
});
