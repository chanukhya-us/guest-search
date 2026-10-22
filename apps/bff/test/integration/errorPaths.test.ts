// Error-path endpoint integration (task 10.1; Req 4, 6, 19, 25.8; design.md "Testing strategy").
// Complements `endToEnd.test.ts`: here the error-handler mapping is proven for EVERY catalog code
// a search can raise, the validation paths are checked end to end, and the circuit breaker is
// exercised over HTTP. Two drivers are used:
//   - an injected gateway that throws a chosen `SoapError` / generic error — the deterministic way
//     to assert that each code maps to its catalog status and a leak-free body (no MSW needed);
//   - the real SOAP transport over MSW for the breaker, where fail-fast must be observable as a
//     missing upstream hit.
// CSP/helmet/CSRF/415/413/429/CORS (10.2) and the log-leak property (10.3) are left to those tasks.
import {
  ERROR_CATALOG,
  ROLES,
  type ErrorCode,
  type ErrorResponse,
  type GuestSearchQuery,
} from '@ihg-guest-search/shared';
import type { FastifyInstance } from 'fastify';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type BuildAppDeps } from '../../src/app.js';
import type { AuthProvider, Principal } from '../../src/auth/authProvider.js';
import type { AppConfig } from '../../src/config.js';
import type { GuestSearchGateway, GuestSearchOutcome } from '../../src/ports/GuestSearchGateway.js';
import { CircuitBreaker } from '../../src/soap/circuitBreaker.js';
import { SoapError, type UpstreamCode } from '../../src/soap/responseParser.js';
import { SoapGuestSearchGateway } from '../../src/soap/soapGuestSearchGateway.js';
import { createSoapTransport } from '../../src/soap/transport.js';
import { MSW_ENDPOINT, mswFetch, mswSoapCfg } from '../helpers/msw.js';

// --- fixtures --------------------------------------------------------------------------------

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

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

/** A gateway that always throws the supplied error (one per test). */
class ThrowingGateway implements GuestSearchGateway {
  calls = 0;
  constructor(private readonly make: () => Error) {}
  search(): Promise<GuestSearchOutcome> {
    this.calls += 1;
    return Promise.reject(this.make());
  }
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
    log: { level: 'silent', auditLogPath: 'logs/audit.jsonl' },
    telemetry: { exporter: 'none' },
    ...overrides,
  };
}

interface Options {
  principal?: Principal | null;
  gateway?: GuestSearchGateway;
  config?: AppConfig;
  deps?: Partial<BuildAppDeps>;
}

async function build(opts: Options = {}): Promise<FastifyInstance> {
  const principal = opts.principal === undefined ? JANE : opts.principal;
  return buildApp(opts.config ?? makeConfig(), {
    ...(opts.gateway !== undefined && { gateway: opts.gateway }),
    authProvider: provider(principal),
    now: () => 1_700_000_000_000,
    readinessConnect: () => Promise.resolve(true),
    ...opts.deps,
  });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function searchInject(instance: FastifyInstance, payload: unknown) {
  return instance.inject({
    method: 'POST',
    url: '/api/v1/guests/search',
    headers: SPA,
    payload: JSON.stringify(payload),
  });
}

// =============================================================================================
// 1. Every upstream + internal error mapped to its catalog entry (Req 19.1)
// =============================================================================================

describe('error-handler mapping for each catalog code (Req 19.1, 19.2, 19.3)', () => {
  // Every `UPSTREAM_*` code a SoapError can carry, as thrown by the gateway.
  const upstreamCodes: UpstreamCode[] = [
    'UPSTREAM_TIMEOUT',
    'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_HTTP_ERROR',
    'UPSTREAM_FAULT',
    'UPSTREAM_TXN_FAILED',
    'UPSTREAM_CONTRACT',
    'UPSTREAM_MALFORMED',
  ];

  for (const code of upstreamCodes) {
    it(`${code} -> ${ERROR_CATALOG[code].http} with the catalog message and a requestId, no leaked detail`, async () => {
      // A revealing detail ("secret-fault-xyz") must never escape to the client body.
      const gateway = new ThrowingGateway(() => new SoapError(code, 'secret-fault-xyz'));
      app = await build({ gateway });
      const res = await searchInject(app, { lastName: 'Testguest' });

      expect(res.statusCode).toBe(ERROR_CATALOG[code].http);
      const body = res.json<ErrorResponse>();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(ERROR_CATALOG[code].message);
      expect(body.error.fields).toBeUndefined();
      expect(body.requestId).toBe(res.headers['x-request-id']);
      // The internal detail is never surfaced.
      expect(res.body).not.toContain('secret-fault-xyz');
    });
  }

  it('an unexpected (non-typed) gateway error -> INTERNAL_ERROR (500) with no detail', async () => {
    const gateway = new ThrowingGateway(() => new Error('boom: internal stack with secrets'));
    app = await build({ gateway });
    const res = await searchInject(app, { lastName: 'Testguest' });
    expect(res.statusCode).toBe(ERROR_CATALOG.INTERNAL_ERROR.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe(ERROR_CATALOG.INTERNAL_ERROR.message);
    // The raw error message never reaches the client.
    expect(res.body).not.toContain('boom');
    expect(res.body).not.toContain('secrets');
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });

  it('UPSTREAM_TIMEOUT is the only non-502 upstream mapping (504)', () => {
    // Guards the catalog contract these tests rely on: every other UPSTREAM_* is a 502.
    const bad = upstreamCodes.filter(
      (c) => c !== 'UPSTREAM_TIMEOUT' && ERROR_CATALOG[c].http !== 502,
    );
    expect(bad).toEqual([]);
    expect(ERROR_CATALOG.UPSTREAM_TIMEOUT.http).toBe(504);
  });
});

// =============================================================================================
// 2. Validation paths end to end (Req 4.5, 4.13, 4.14, 6.2, 9.5)
// =============================================================================================

describe('validation paths end to end (no values ever echoed)', () => {
  it('NO_CRITERIA (400) when the body carries no criterion', async () => {
    app = await build();
    const res = await searchInject(app, {});
    expect(res.statusCode).toBe(ERROR_CATALOG.NO_CRITERIA.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.code).toBe('NO_CRITERIA');
    expect(body.error.message).toBe(ERROR_CATALOG.NO_CRITERIA.message);
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });

  it('VALIDATION_ERROR (400) with a per-field message for a malformed email, value never echoed', async () => {
    app = await build();
    const res = await searchInject(app, { email: 'not-an-email' });
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields?.some((f) => f.field === 'email')).toBe(true);
    // The rejected value is never reflected back.
    expect(res.body).not.toContain('not-an-email');
  });

  it('VALIDATION_ERROR (400) rejects an unknown key (strict schema)', async () => {
    app = await build();
    const res = await searchInject(app, { bogusField: 'x' });
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    expect(res.json<ErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });

  it('a disabled-feature field (city) is rejected with the generic value-free message', async () => {
    const gateway = new ThrowingGateway(() => new Error('must not be reached'));
    app = await build({ gateway });
    const res = await searchInject(app, { city: 'Atlanta' });
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.fields).toContainEqual({
      field: 'city',
      message: 'This field is not yet supported for search.',
    });
    expect(res.body).not.toContain('Atlanta');
    // The guard runs before the gateway.
    expect((gateway as ThrowingGateway).calls).toBe(0);
  });

  it('addressLine2 (permanently disabled) is rejected regardless of flags', async () => {
    app = await build();
    const res = await searchInject(app, { addressLine2: 'Suite 5' });
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    expect(res.json<ErrorResponse>().error.fields).toContainEqual({
      field: 'addressLine2',
      message: 'This field is not yet supported for search.',
    });
  });

  it('an impossible phone number (server libphonenumber check) -> VALIDATION_ERROR, value-free', async () => {
    const gateway = new ThrowingGateway(() => new Error('must not be reached'));
    app = await build({ gateway });
    const res = await searchInject(app, { phone: '123' } satisfies GuestSearchQuery);
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.fields?.some((f) => f.field === 'phone')).toBe(true);
    expect((gateway as ThrowingGateway).calls).toBe(0);
  });
});

// =============================================================================================
// 3. requestId / X-Request-ID present on every body (Req 19.2, 25.8)
// =============================================================================================

describe('every error body carries a requestId equal to the X-Request-ID header', () => {
  const scenarios: { name: string; make: () => Options; payload: unknown; code: ErrorCode }[] = [
    { name: 'validation', make: () => ({}), payload: {}, code: 'NO_CRITERIA' },
    {
      name: 'forbidden',
      make: () => ({ principal: { ...JANE, roles: [] } }),
      payload: { lastName: 'X' },
      code: 'FORBIDDEN',
    },
    {
      name: 'upstream',
      make: () => ({ gateway: new ThrowingGateway(() => new SoapError('UPSTREAM_FAULT')) }),
      payload: { lastName: 'X' },
      code: 'UPSTREAM_FAULT',
    },
    {
      name: 'internal',
      make: () => ({ gateway: new ThrowingGateway(() => new Error('x')) }),
      payload: { lastName: 'X' },
      code: 'INTERNAL_ERROR',
    },
  ];

  for (const s of scenarios) {
    it(`the ${s.name} path echoes a client-supplied X-Request-ID into the body`, async () => {
      app = await build(s.make());
      const requestId = '00000000-0000-4000-8000-00000000c0de';
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/guests/search',
        headers: { ...SPA, 'x-request-id': requestId },
        payload: JSON.stringify(s.payload),
      });
      const body = res.json<ErrorResponse>();
      expect(body.error.code).toBe(s.code);
      // The request id is correlated end to end: header in, same id out, in the body too.
      expect(res.headers['x-request-id']).toBe(requestId);
      expect(body.requestId).toBe(requestId);
    });
  }

  it('401 UNAUTHENTICATED (no principal) also carries a requestId', async () => {
    app = await build({ principal: null });
    const res = await searchInject(app, { lastName: 'X' });
    expect(res.statusCode).toBe(ERROR_CATALOG.UNAUTHENTICATED.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });
});

// =============================================================================================
// 4. Circuit breaker over HTTP: fail fast after the threshold, without calling upstream (Req 10.7)
// =============================================================================================

describe('circuit breaker over the HTTP stack (Req 10.7)', () => {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('after the failure threshold, the next search fails fast as 502 with no upstream hit', async () => {
    // Every upstream attempt is an uncoded network error -> UPSTREAM_UNAVAILABLE (counted, no retry).
    let hits = 0;
    server.use(
      http.post(MSW_ENDPOINT, () => {
        hits += 1;
        return HttpResponse.error();
      }),
    );

    // A real SOAP gateway over MSW, with the breaker threshold lowered to 2.
    const config = makeConfig();
    config.soap.breaker = { failureThreshold: 2, openMs: 30_000 };
    const breaker = new CircuitBreaker(config.soap.breaker, { now: () => 1_700_000_000_000 });
    const transport = createSoapTransport(config.soap, { breaker, fetch: mswFetch });
    const gateway = new SoapGuestSearchGateway({
      cfg: config.soap,
      transport,
      now: () => new Date(1_700_000_000_000),
    });
    app = await build({ config, gateway });

    // First two searches actually call MSW and fail; the breaker opens on the second.
    const first = await searchInject(app, { lastName: 'Testguest' });
    const second = await searchInject(app, { lastName: 'Testguest' });
    expect(first.statusCode).toBe(ERROR_CATALOG.UPSTREAM_UNAVAILABLE.http);
    expect(second.statusCode).toBe(ERROR_CATALOG.UPSTREAM_UNAVAILABLE.http);
    expect(breaker.state).toBe('open');
    expect(hits).toBe(2);

    // The third fails fast from the open circuit: still a 502, but no new upstream call.
    const third = await searchInject(app, { lastName: 'Testguest' });
    expect(third.statusCode).toBe(ERROR_CATALOG.UPSTREAM_UNAVAILABLE.http);
    expect(third.json<ErrorResponse>().error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(hits).toBe(2); // unchanged: the open breaker made no request
  });
});
