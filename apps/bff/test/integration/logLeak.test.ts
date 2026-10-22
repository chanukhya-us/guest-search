// Log-leak integration test (task 10.3; Req 12.13, 22.3, 22.4, 25.6; design.md "Testing
// strategy" → the log-leak capture, and the threat-model row "Card-token leakage").
//
// This is the end-to-end PRIVACY proof: a guest carrying a credit-card token AND distinctive
// contact PII (`response-with-cc-token.xml`) is driven through the WHOLE real stack — request
// mapper → transport → response parser (which drops the unknown `creditCard` element) → service
// (which masks phones/emails and mints a reveal token) → reveal (which returns the UNMASKED
// contacts to the authorized client). While that runs, EVERY application log line (captured from
// an in-memory pino sink) and EVERY audit record (a BufferAuditLogger) are collected, then
// asserted to contain none of:
//   - the synthetic card token marker, or the word `creditCard`;
//   - any `CC_TOKEN_FIXTURE_PII` value (raw phone, raw email, names, raw enterpriseId, memberId);
//   - the reveal token value, or the session cookie value;
//   - the raw criteria value submitted in the search.
// The audit trail MAY carry the Enterprise-ID HMAC (asserted to be the HMAC, not the raw id) plus
// who / requestId / resultCount — and nothing else that identifies a person.
//
// Positive controls make "absent from logs" a real guarantee rather than a tautology:
//   - the reveal RESPONSE to the authorized client DOES contain the unmasked phone and email;
//   - the search response carries the names / enterprise id verbatim (never masked), proving the
//     guest really flowed through the stack and the markers were live.
//
// Error paths are exercised too (design: a SoapError `detail` is log-only and sanitized; an
// INTERNAL_ERROR message is server-log-only): a synthetic-secret upstream detail and a thrown
// Error message are asserted ABSENT from the CLIENT body, while the reveal token / PII are never
// logged on any path.
//
// Determinism: a fixed clock and request id flow through the whole stack; MSW serves fixed fixture
// bytes with `onUnhandledFrame: 'error'`; a dedicated `rt_`-prefixed reveal token generator makes
// the token value known for the leak check; handlers reset per test and the server closes at end.
import {
  ROLES,
  type ErrorResponse,
  type GuestSearchResponse,
  type RevealResponse,
} from '@ihg-guest-search/shared';
import type { FastifyInstance } from 'fastify';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import pino, { type DestinationStream, type Logger } from 'pino';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type BuildAppDeps } from '../../src/app.js';
import type { AuthProvider, Principal } from '../../src/auth/authProvider.js';
import type { AppConfig } from '../../src/config.js';
import { BufferAuditLogger, type AuditRecord } from '../../src/observability/audit.js';
import { baseLoggerOptions } from '../../src/observability/logger.js';
import type { GuestSearchGateway, GuestSearchOutcome } from '../../src/ports/GuestSearchGateway.js';
import { MemoryRevealStore } from '../../src/security/revealStore.js';
import { SoapError } from '../../src/soap/responseParser.js';
import { CircuitBreaker } from '../../src/soap/circuitBreaker.js';
import { SoapGuestSearchGateway } from '../../src/soap/soapGuestSearchGateway.js';
import { createSoapTransport } from '../../src/soap/transport.js';
import { MSW_ENDPOINT, mswFetch, mswSoapCfg } from '../helpers/msw.js';
import { readFixture } from '../helpers/requestFixtures.js';
import { CC_TOKEN_FIXTURE_PII, CC_TOKEN_MARKER } from '../helpers/responseFixtures.js';

// --- MSW lifecycle ---------------------------------------------------------------------------

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Serve `fixture` at the SOAP endpoint with `status`. */
function serveSoap(fixture: string, status = 200, contentType = 'text/xml; charset=utf-8'): void {
  server.use(
    http.post(
      MSW_ENDPOINT,
      () =>
        new HttpResponse(readFixture(fixture), {
          status,
          headers: { 'content-type': contentType },
        }),
    ),
  );
}

// --- app wiring ------------------------------------------------------------------------------

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const FIXED_MS = Date.parse('2026-10-21T12:00:00.000Z');
/** A known, fixed reveal-token value so the leak check can assert it is absent from the logs. */
const REVEAL_TOKEN = 'rt_LEAKCHECK_FIXED_TOKEN_VALUE';

const SPA = {
  'x-requested-with': 'guest-search',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
} as const;

const JANE: Principal = {
  id: 'dev-jane.doe',
  displayName: 'Jane Doe (Customer Care)',
  roles: [ROLES.READ, ROLES.REVEAL],
};

function provider(principal: Principal | null): AuthProvider {
  return { mode: 'dev', authenticate: (): Promise<Principal | null> => Promise.resolve(principal) };
}

/** A pino logger on an in-memory sink, so every emitted line can be captured as raw text. */
function captureLogger(): { logger: Logger; lines(): string[]; text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(chunk.toString());
      cb();
    },
  });
  // `trace` so NOTHING the app ever logs is filtered out before the leak check sees it.
  const logger = pino(
    baseLoggerOptions({ nodeEnv: 'test', log: { level: 'trace', auditLogPath: 'x' } }),
    stream as unknown as DestinationStream,
  );
  return {
    logger,
    text: (): string => chunks.join(''),
    lines: (): string[] =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== ''),
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    trustProxy: false,
    auth: { mode: 'dev' },
    session: { cookieName: 'gs_session', ttlMinutes: 30, absoluteHours: 8, secret: SESSION_SECRET },
    soap: mswSoapCfg(),
    rateLimit: { searchPerMinute: 30, revealPerMinute: 10 },
    reveal: { ttlMinutes: 10 },
    ui: {
      scoreBands: { high: 90, medium: 70 },
      memberTypes: [{ code: 'PLACEHOLDER', label: 'Placeholder member type' }],
    },
    log: { level: 'trace', auditLogPath: 'logs/audit.jsonl' },
    telemetry: { exporter: 'none' },
    ...overrides,
  };
}

/** The real SOAP gateway wired to `mswFetch`, so the whole stack runs over MSW. */
function realSoapGateway(config: AppConfig, logger: Logger): GuestSearchGateway {
  const breaker = new CircuitBreaker(config.soap.breaker, { now: () => FIXED_MS });
  const transport = createSoapTransport(config.soap, { breaker, fetch: mswFetch });
  return new SoapGuestSearchGateway({
    cfg: config.soap,
    transport,
    now: () => new Date(FIXED_MS),
    logger,
  });
}

interface Options {
  principal?: Principal | null;
  gateway?: GuestSearchGateway;
  config?: AppConfig;
  deps?: Partial<BuildAppDeps>;
}

/** Build the real app with in-memory logger + audit; a known reveal-token generator. */
async function build(
  capture: ReturnType<typeof captureLogger>,
  audit: BufferAuditLogger,
  opts: Options = {},
): Promise<FastifyInstance> {
  const config = opts.config ?? makeConfig();
  const principal = opts.principal === undefined ? JANE : opts.principal;
  const revealStore = new MemoryRevealStore({
    ttlMs: config.reveal.ttlMinutes * 60_000,
    now: () => FIXED_MS,
    idGenerator: () => REVEAL_TOKEN,
  });
  return buildApp(config, {
    gateway: opts.gateway ?? realSoapGateway(config, capture.logger),
    authProvider: provider(principal),
    now: () => FIXED_MS,
    readinessConnect: () => Promise.resolve(true),
    appLogger: capture.logger,
    audit,
    revealStore,
    ...opts.deps,
  });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function searchInject(instance: FastifyInstance, payload: unknown, cookie?: string) {
  return instance.inject({
    method: 'POST',
    url: '/api/v1/guests/search',
    headers: { ...SPA, ...(cookie !== undefined && { cookie }) },
    payload: JSON.stringify(payload),
  });
}

function revealInject(instance: FastifyInstance, payload: unknown, cookie?: string) {
  return instance.inject({
    method: 'POST',
    url: '/api/v1/guests/reveal',
    headers: { ...SPA, ...(cookie !== undefined && { cookie }) },
    payload: JSON.stringify(payload),
  });
}

/** The session cookie `name=value` from a response's Set-Cookie (first cookie), or ''. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  const first = Array.isArray(setCookie)
    ? (setCookie[0] as string | undefined)
    : (setCookie as string | undefined);
  return (first ?? '').split(';', 1)[0] ?? '';
}

/** The bare cookie VALUE (after `name=`) from a `name=value` pair. */
function cookieValue(cookie: string): string {
  return cookie.split('=').slice(1).join('=');
}

/** Every token that must never appear in a log line or an audit record. */
const FORBIDDEN_IN_LOGS: readonly string[] = [
  CC_TOKEN_MARKER,
  'creditCard',
  CC_TOKEN_FIXTURE_PII.firstName,
  CC_TOKEN_FIXTURE_PII.lastName,
  CC_TOKEN_FIXTURE_PII.line1,
  CC_TOKEN_FIXTURE_PII.phone,
  CC_TOKEN_FIXTURE_PII.email,
  CC_TOKEN_FIXTURE_PII.enterpriseId,
  CC_TOKEN_FIXTURE_PII.memberId,
];

/** Assert no captured log line and no audit record contains any of `needles`. */
function expectLogsFreeOf(
  logText: string,
  audit: readonly AuditRecord[],
  needles: readonly string[],
): void {
  const auditText = JSON.stringify(audit);
  for (const needle of needles) {
    expect(logText, `app log leaked: ${needle}`).not.toContain(needle);
    expect(auditText, `audit log leaked: ${needle}`).not.toContain(needle);
  }
}

// =============================================================================================
// 1. The full search + reveal flow leaks nothing to the logs (Req 12.13, 22.3, 22.4, 25.6)
// =============================================================================================

describe('log-leak: full stack with a card token and distinctive PII (Req 25.6)', () => {
  it('drives search+reveal; no token, PII, creditCard, session cookie or criteria reaches any log', async () => {
    const capture = captureLogger();
    const audit = new BufferAuditLogger();
    serveSoap('response-with-cc-token.xml');
    // A distinctive synthetic criteria value we can hunt for in the logs afterwards.
    const CRITERIA_VALUE = 'Markerguest';
    app = await build(capture, audit, { principal: JANE });

    // --- search: the parser drops creditCard; the service masks contacts -----------------
    const search = await searchInject(app, { lastName: CRITERIA_VALUE });
    expect(search.statusCode).toBe(200);
    const body = search.json<GuestSearchResponse>();
    expect(body.totalResults).toBe(1);

    const summary = body.results[0]!;
    // Positive control: the names / enterprise id flowed through verbatim (never masked),
    // proving the real guest with live markers crossed the whole stack.
    expect(summary.guest.firstName).toBe(CC_TOKEN_FIXTURE_PII.firstName);
    expect(summary.guest.lastName).toBe(CC_TOKEN_FIXTURE_PII.lastName);
    expect(summary.guest.enterpriseId).toBe(CC_TOKEN_FIXTURE_PII.enterpriseId);
    // The card token and the whole creditCard element were dropped by the allowlist parser:
    // neither appears anywhere in the serialized RESPONSE (Req 12.10, 12.11, 12.13).
    const searchBodyText = search.body;
    expect(searchBodyText).not.toContain(CC_TOKEN_MARKER);
    expect(searchBodyText).not.toContain('creditCard');
    // Contacts are masked in the response.
    expect(summary.guest.phones[0]!.number).not.toContain(CC_TOKEN_FIXTURE_PII.phone);
    expect(summary.guest.emails[0]!.address).not.toContain(CC_TOKEN_FIXTURE_PII.email);
    // A reveal token was minted (the known fixed value).
    expect(summary.revealToken).toBe(REVEAL_TOKEN);

    // --- reveal: the AUTHORIZED client gets the UNMASKED contacts back --------------------
    const cookie = sessionCookie(search);
    const reveal = await revealInject(app, { revealToken: summary.revealToken }, cookie);
    expect(reveal.statusCode).toBe(200);
    const revealed = reveal.json<RevealResponse>();
    // Positive control: the real unmasked PII is in the reveal response (to the client only).
    expect(revealed.phones[0]!.number).toBe(CC_TOKEN_FIXTURE_PII.phone);
    expect(revealed.emails[0]!.address).toBe(CC_TOKEN_FIXTURE_PII.email);

    // --- the NEGATIVE guarantee: none of it reached any log line or audit record ----------
    const logText = capture.text();
    expect(logText.length).toBeGreaterThan(0); // the stack really did log (request lines, etc.)
    expectLogsFreeOf(logText, audit.records, [
      ...FORBIDDEN_IN_LOGS,
      REVEAL_TOKEN, // the reveal token value is never logged
      CRITERIA_VALUE, // the raw criteria value is never logged
      cookieValue(cookie), // the signed session cookie value is never logged
    ]);

    // The audit trail carries only PII-free fields: the Enterprise-ID HMAC (NOT the raw id),
    // who / requestId / resultCount. One search event + one reveal event.
    expect(audit.records).toHaveLength(2);
    const searchEvent = audit.records.find((r) => r.action === 'guest.search')!;
    const revealEvent = audit.records.find((r) => r.action === 'guest.reveal')!;
    expect(searchEvent).toMatchObject({ who: JANE.id, resultCount: 1 });
    expect(searchEvent.requestId).toBe(search.headers['x-request-id']);
    expect(revealEvent.who).toBe(JANE.id);
    // The reveal event hashes the enterprise id: present, a hash, never the raw value.
    expect(typeof revealEvent.enterpriseIdHash).toBe('string');
    expect(revealEvent.enterpriseIdHash).not.toBe(CC_TOKEN_FIXTURE_PII.enterpriseId);
    expect(revealEvent).not.toHaveProperty('resultCount');
  });
});

// =============================================================================================
// 2. Error paths: a secret detail / message never reaches the CLIENT body (design.md)
// =============================================================================================

describe('log-leak: error paths keep secrets out of the client body (Req 19.3, 22.3)', () => {
  it('a SoapError with a synthetic-secret detail: detail absent from the client body; no PII logged', async () => {
    const capture = captureLogger();
    const audit = new BufferAuditLogger();
    // The detail is a short, "safe-looking" code-like token the parser would retain in its
    // sanitized `detail` (log-only); it must still never appear in the CLIENT body.
    const SECRET_DETAIL = 'SECRET-UPSTREAM-DETAIL-9Z';
    const gateway: GuestSearchGateway = {
      search: (): Promise<GuestSearchOutcome> =>
        Promise.reject(new SoapError('UPSTREAM_FAULT', SECRET_DETAIL)),
    };
    app = await build(capture, audit, { gateway });

    const res = await searchInject(app, { lastName: 'Markerguest' });
    const errBody = res.json<ErrorResponse>();
    expect(errBody.success).toBe(false);
    expect(errBody.error.code).toBe('UPSTREAM_FAULT');
    // The client body carries only the generic catalog message — never the upstream detail.
    expect(res.body).not.toContain(SECRET_DETAIL);
    // And no PII / token ever reaches a log on the error path either.
    expectLogsFreeOf(capture.text(), audit.records, FORBIDDEN_IN_LOGS);
  });

  it('an INTERNAL_ERROR from a thrown Error whose message is a secret: secret absent from the client body', async () => {
    const capture = captureLogger();
    const audit = new BufferAuditLogger();
    const SECRET_MESSAGE = 'internal-stack-secret-should-never-surface';
    const gateway: GuestSearchGateway = {
      search: (): Promise<GuestSearchOutcome> => Promise.reject(new Error(SECRET_MESSAGE)),
    };
    app = await build(capture, audit, { gateway });

    const res = await searchInject(app, { lastName: 'Markerguest' });
    const errBody = res.json<ErrorResponse>();
    expect(errBody.error.code).toBe('INTERNAL_ERROR');
    // The raw error message never reaches the client (it MAY be in the server error log,
    // which design.md permits — but a token / PII never is).
    expect(res.body).not.toContain(SECRET_MESSAGE);
    // The reveal token value and all guest PII are never logged on this path.
    expectLogsFreeOf(capture.text(), audit.records, [...FORBIDDEN_IN_LOGS, REVEAL_TOKEN]);
  });
});
