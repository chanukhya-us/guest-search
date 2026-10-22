// Full-stack endpoint integration (task 10.1; Req 6, 10.9, 15, 19; design.md "Testing strategy"
// integration section). These tests prove end-to-end behaviour that the route/plugin suites do
// NOT: the whole SOAP stack driven over MSW with real response fixtures (mapper → transport →
// parser → service → masking → reveal, through HTTP), the real personas via `DevAuthProvider`,
// every upstream error surfaced from a real SOAP exchange, and strict response-shape conformance.
//
// Scope split (see the task-10.1 report):
//   - Error-handler mapping for EVERY `UPSTREAM_*` / INTERNAL_ERROR code from an injected throwing
//     gateway, the validation paths and the circuit breaker over HTTP live in `errorPaths.test.ts`.
//   - CSP/helmet/CSRF/415/413/429/no-CORS and the reveal security lifecycle (10.2) and the
//     log-leak / token-exclusion property (10.3) are intentionally left to those tasks.
//
// Determinism: a fixed clock and request id flow through the whole stack; MSW serves fixed
// fixture bytes with `onUnhandledFrame: 'error'` so nothing escapes to the network; handlers are
// reset per test and the server is closed at the end. No real socket, timer or SOAP service.
import {
  ERROR_CATALOG,
  ROLES,
  type ErrorResponse,
  type GuestSearchResponse,
  type MeResponse,
  type RevealResponse,
  type UiConfig,
} from '@ihg-guest-search/shared';
import type { FastifyInstance } from 'fastify';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type BuildAppDeps } from '../../src/app.js';
import { DevAuthProvider } from '../../src/auth/authProvider.js';
import { DEV_PERSONAS, type DevPersonaId } from '../../src/auth/devPersonas.js';
import type { AppConfig } from '../../src/config.js';
import type { GuestSearchGateway } from '../../src/ports/GuestSearchGateway.js';
import { CircuitBreaker } from '../../src/soap/circuitBreaker.js';
import { SoapGuestSearchGateway } from '../../src/soap/soapGuestSearchGateway.js';
import { createSoapTransport } from '../../src/soap/transport.js';
import { MSW_ENDPOINT, mswFetch, mswSoapCfg } from '../helpers/msw.js';
import { readFixture } from '../helpers/requestFixtures.js';

// --- MSW lifecycle (shared by every test driving the real transport) -------------------------

const server = setupServer();
// MSW 3 renamed `onUnhandledRequest` to `onUnhandledFrame`: an unmatched SOAP call fails the test.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Serve `fixture` at the SOAP endpoint with `status`, counting the upstream hits. */
function serveSoap(
  fixture: string,
  status = 200,
  contentType = 'text/xml; charset=utf-8',
): { hits: () => number } {
  let hits = 0;
  server.use(
    http.post(MSW_ENDPOINT, () => {
      hits += 1;
      return new HttpResponse(readFixture(fixture), {
        status,
        headers: { 'content-type': contentType },
      });
    }),
  );
  return { hits: () => hits };
}

// --- app wiring ------------------------------------------------------------------------------

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const FIXED_MS = Date.parse('2026-10-21T12:00:00.000Z');

/** Headers a legitimate same-origin SPA request carries (CSRF + JSON). */
const SPA = {
  'x-requested-with': 'guest-search',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
} as const;

/** A valid `AppConfig` for the app factory; SOAP points at the MSW endpoint. */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const soap = mswSoapCfg();
  return {
    nodeEnv: 'test',
    port: 0,
    trustProxy: false,
    auth: { mode: 'dev' },
    session: { cookieName: 'gs_session', ttlMinutes: 30, absoluteHours: 8, secret: SESSION_SECRET },
    soap,
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

/**
 * Build a REAL SOAP gateway wired to `mswFetch`, so `buildApp` runs the whole stack
 * (header builder → request mapper → transport+breaker → response parser) over MSW instead
 * of the fake gateway the route suite uses.
 */
function realSoapGateway(config: AppConfig): GuestSearchGateway {
  const breaker = new CircuitBreaker(config.soap.breaker, { now: () => FIXED_MS });
  const transport = createSoapTransport(config.soap, { breaker, fetch: mswFetch });
  return new SoapGuestSearchGateway({ cfg: config.soap, transport, now: () => new Date(FIXED_MS) });
}

/** The real dev-auth provider for a persona (Req 20.3), exactly as production builds it. */
function devProvider(persona: DevPersonaId): DevAuthProvider {
  return new DevAuthProvider({ ...DEV_PERSONAS[persona] });
}

interface Options {
  persona?: DevPersonaId;
  config?: AppConfig;
  gateway?: GuestSearchGateway;
  deps?: Partial<BuildAppDeps>;
}

/** Build the real app with the real persona provider and a real (MSW-backed) SOAP gateway. */
async function build(opts: Options = {}): Promise<FastifyInstance> {
  const config = opts.config ?? makeConfig();
  return buildApp(config, {
    gateway: opts.gateway ?? realSoapGateway(config),
    authProvider: devProvider(opts.persona ?? 'jane.doe'),
    now: () => FIXED_MS,
    readinessConnect: () => Promise.resolve(true),
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

/** The session cookie name=value from a response's Set-Cookie (first cookie), or ''. */
function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'];
  const first = Array.isArray(setCookie)
    ? (setCookie[0] as string | undefined)
    : (setCookie as string | undefined);
  return (first ?? '').split(';', 1)[0] ?? '';
}

// =============================================================================================
// 1. Full happy path over the whole stack with a real SOAP response fixture
// =============================================================================================

describe('full stack: search then reveal over MSW (Req 6, 10.9, 14)', () => {
  it('search masks contacts and mints a reveal token; reveal returns the unmasked contacts', async () => {
    // One guest with a phone and email, served as real SOAP bytes by MSW.
    const upstream = serveSoap('response-single.xml');
    app = await build();

    // --- search: mapper -> transport -> parser -> service -> masking ---------------------
    const search = await searchInject(app, { lastName: 'Single' });
    expect(search.statusCode).toBe(200);
    expect(upstream.hits()).toBe(1); // the real transport actually called MSW

    const body = search.json<GuestSearchResponse>();
    expect(body).toMatchObject({ success: true, totalResults: 1, limit: 50 });
    expect(body.requestId).toBe(search.headers['x-request-id']);

    const summary = body.results[0]!;
    // Contacts are masked in the response (the raw values live only in the reveal store).
    expect(summary.guest.phones[0]!.number).toBe('•••• 0101');
    expect(summary.guest.emails[0]!.address).toBe('a•••@example.test');
    // Names / enterprise id / address are never masked (Req 14.4).
    expect(summary.guest.enterpriseId).toBe('900000001');
    expect(summary.guest.firstName).toBe('Avery');
    expect(summary.guest.lastName).toBe('Single');
    // A reveal token is present for the REVEAL persona.
    expect(typeof summary.revealToken).toBe('string');
    expect(summary.revealToken).toMatch(/^rt_/);

    // --- reveal: exchange the token in the same session for the unmasked contacts --------
    const cookie = sessionCookie(search);
    const reveal = await revealInject(app, { revealToken: summary.revealToken }, cookie);
    expect(reveal.statusCode).toBe(200);
    const revealed = reveal.json<RevealResponse>();
    expect(revealed.phones[0]!.number).toBe('+1 404 555 0101');
    expect(revealed.emails[0]!.address).toBe('avery.single@example.test');
    expect(revealed.requestId).toBe(reveal.headers['x-request-id']);
  });

  it('a success fixture with zero guests returns an empty, successful response', async () => {
    const upstream = serveSoap('response-empty.xml');
    app = await build();
    const res = await searchInject(app, { lastName: 'Nobody' });
    expect(res.statusCode).toBe(200);
    expect(res.json<GuestSearchResponse>()).toMatchObject({
      success: true,
      totalResults: 0,
      limit: 50,
      results: [],
    });
    expect(upstream.hits()).toBe(1);
  });

  it('the capped `maxResults` limit is reported alongside a large result set', async () => {
    // 60 guests from the fixture, with the limit raised to 60 so none is dropped upstream.
    const config = makeConfig();
    config.soap.maxResults = 60;
    const upstream = serveSoap('response-60-guests.xml');
    app = await build({ config });
    const res = await searchInject(app, { lastName: 'Testguest' });
    expect(res.statusCode).toBe(200);
    const body = res.json<GuestSearchResponse>();
    expect(body.totalResults).toBe(60);
    expect(body.limit).toBe(60);
    expect(upstream.hits()).toBe(1);
  });
});

// =============================================================================================
// 2. Every upstream error surfaced from a REAL SOAP exchange over MSW (Req 10.9, 19.1)
// =============================================================================================

describe('upstream errors surfaced end to end over MSW (Req 10.9, 19.1)', () => {
  // Each case drives the real parser/transport so the FULL classification path is exercised,
  // then asserts the catalog status, code and generic (leak-free) message reach the client.
  const cases: {
    name: string;
    fixture: string;
    status?: number;
    contentType?: string;
    code: keyof typeof ERROR_CATALOG;
    detail?: string;
  }[] = [
    { name: 'a 200 SOAP Fault', fixture: 'fault-client.xml', code: 'UPSTREAM_FAULT' },
    { name: 'a 500 SOAP Fault', fixture: 'fault-server.xml', status: 500, code: 'UPSTREAM_FAULT' },
    {
      name: 'a failed transaction status',
      fixture: 'response-failure-status.xml',
      code: 'UPSTREAM_TXN_FAILED',
    },
    {
      name: 'a 502 HTML proxy page',
      fixture: 'malformed-proxy-502.html',
      status: 502,
      contentType: 'text/html; charset=utf-8',
      code: 'UPSTREAM_HTTP_ERROR',
    },
    {
      name: 'a truncated response body',
      fixture: 'malformed-truncated.xml',
      code: 'UPSTREAM_MALFORMED',
    },
    {
      name: 'a DTD/entity response body',
      fixture: 'malformed-dtd.xml',
      code: 'UPSTREAM_MALFORMED',
    },
  ];

  for (const c of cases) {
    it(`${c.name} -> ${c.code} (${ERROR_CATALOG[c.code].http}) with a generic message and a requestId`, async () => {
      serveSoap(c.fixture, c.status ?? 200, c.contentType);
      app = await build();
      const res = await searchInject(app, { lastName: 'Testguest' });

      expect(res.statusCode).toBe(ERROR_CATALOG[c.code].http);
      const body = res.json<ErrorResponse>();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(c.code);
      // The client sees only the catalog's safe message; no upstream detail leaks.
      expect(body.error.message).toBe(ERROR_CATALOG[c.code].message);
      expect(body.requestId).toBe(res.headers['x-request-id']);
      // No fixture payload (fault strings, status descriptions, HTML) leaks into the body.
      const raw = res.body;
      expect(raw).not.toMatch(/faultstring|overallStatusDescription|<html/i);
    });
  }

  it('maps a non-2xx status without a Fault to UPSTREAM_HTTP_ERROR (502), not UPSTREAM_MALFORMED', async () => {
    // A 503 carrying a well-formed but non-Fault body: Req 10.9 classifies by HTTP status.
    serveSoap('response-single.xml', 503);
    app = await build();
    const res = await searchInject(app, { lastName: 'Single' });
    expect(res.statusCode).toBe(ERROR_CATALOG.UPSTREAM_HTTP_ERROR.http);
    expect(res.json<ErrorResponse>().error.code).toBe('UPSTREAM_HTTP_ERROR');
  });
});

// =============================================================================================
// 3. Auth / role end to end with the REAL personas via DevAuthProvider (Req 20)
// =============================================================================================

describe('personas end to end via DevAuthProvider (Req 20.3, 20.6, 20.7)', () => {
  it('jane.doe (Read + RevealPII): search succeeds and reveal works', async () => {
    serveSoap('response-single.xml');
    app = await build({ persona: 'jane.doe' });
    const search = await searchInject(app, { lastName: 'Single' });
    expect(search.statusCode).toBe(200);
    const token = search.json<GuestSearchResponse>().results[0]!.revealToken;
    expect(typeof token).toBe('string');
    const reveal = await revealInject(app, { revealToken: token }, sessionCookie(search));
    expect(reveal.statusCode).toBe(200);
  });

  it('read.only (Read): search succeeds with no token; reveal is 403 FORBIDDEN', async () => {
    serveSoap('response-single.xml');
    app = await build({ persona: 'read.only' });
    const search = await searchInject(app, { lastName: 'Single' });
    expect(search.statusCode).toBe(200);
    // No reveal token is minted without the RevealPII role.
    expect(search.json<GuestSearchResponse>().results[0]!.revealToken).toBeUndefined();

    const reveal = await revealInject(app, { revealToken: 'rt_anything' }, sessionCookie(search));
    expect(reveal.statusCode).toBe(ERROR_CATALOG.FORBIDDEN.http);
    expect(reveal.json<ErrorResponse>().error.code).toBe('FORBIDDEN');
  });

  it('no.access (no roles): search is 403 FORBIDDEN and never reaches upstream', async () => {
    const upstream = serveSoap('response-single.xml');
    app = await build({ persona: 'no.access' });
    const res = await searchInject(app, { lastName: 'Single' });
    expect(res.statusCode).toBe(ERROR_CATALOG.FORBIDDEN.http);
    expect(res.json<ErrorResponse>().error.code).toBe('FORBIDDEN');
    // The role gate runs before the service, so no SOAP call is made.
    expect(upstream.hits()).toBe(0);
  });
});

// =============================================================================================
// 4. config and me end to end per persona (Req 3.4, 3.5, 20.8)
// =============================================================================================

describe('GET /api/v1/me and /api/v1/config per persona', () => {
  const expectations: Record<DevPersonaId, { displayName: string; roles: string[] }> = {
    'jane.doe': { displayName: 'Jane Doe (Customer Care)', roles: [ROLES.READ, ROLES.REVEAL] },
    'read.only': { displayName: 'Riley Reader (Read only)', roles: [ROLES.READ] },
    'no.access': { displayName: 'Nora NoAccess', roles: [] },
  };

  for (const persona of Object.keys(expectations) as DevPersonaId[]) {
    it(`/me reflects the ${persona} persona exactly`, async () => {
      app = await build({ persona });
      const res = await app.inject('/api/v1/me');
      expect(res.statusCode).toBe(200);
      expect(res.json<MeResponse>()).toEqual({
        displayName: expectations[persona].displayName,
        roles: expectations[persona].roles,
        authMode: 'dev',
      });
    });
  }

  it('/config serves only the non-sensitive UiConfig and no persona affects it', async () => {
    app = await build({ persona: 'no.access' });
    const res = await app.inject('/api/v1/config');
    expect(res.statusCode).toBe(200);
    expect(res.json<UiConfig>()).toEqual({
      scoreBands: { high: 90, medium: 70 },
      memberTypes: [{ code: 'PLACEHOLDER', label: 'Placeholder member type' }],
      features: { addressLine1: false, city: false, postalCode: false },
      authMode: 'dev',
    });
    // No sensitive config value leaks (endpoint, secret, header service user).
    const raw = res.body;
    expect(raw).not.toContain('soap.example.test');
    expect(raw).not.toContain(SESSION_SECRET);
    expect(raw).not.toContain('svc-test-user');
  });
});

// =============================================================================================
// 5. Response-shape conformance against the shared types (Req 19.2)
// =============================================================================================

describe('response-shape conformance against the shared contract', () => {
  it('GuestSearchResponse carries exactly its contract keys and a success flag', async () => {
    serveSoap('response-single.xml');
    app = await build();
    const body = (await searchInject(app, { lastName: 'Single' })).json<GuestSearchResponse>();
    expect(Object.keys(body).sort()).toEqual([
      'limit',
      'requestId',
      'results',
      'success',
      'totalResults',
    ]);
    expect(body.success).toBe(true);
    const summary = body.results[0]!;
    // A GuestSummary is {guest, primary, revealToken?} — no stray top-level fields. The
    // single fixture has contacts and the persona can reveal, so the token key is present.
    expect(Object.keys(summary).sort()).toEqual(['guest', 'primary', 'revealToken']);
  });

  it('RevealResponse carries exactly {requestId, phones, emails}', async () => {
    serveSoap('response-single.xml');
    app = await build();
    const search = await searchInject(app, { lastName: 'Single' });
    const token = search.json<GuestSearchResponse>().results[0]!.revealToken;
    const revealed = (
      await revealInject(app, { revealToken: token }, sessionCookie(search))
    ).json<RevealResponse>();
    expect(Object.keys(revealed).sort()).toEqual(['emails', 'phones', 'requestId']);
  });

  it('MeResponse carries exactly {displayName, roles, authMode}', async () => {
    app = await build();
    const me = (await app.inject('/api/v1/me')).json<MeResponse>();
    expect(Object.keys(me).sort()).toEqual(['authMode', 'displayName', 'roles']);
  });

  it('UiConfig carries exactly {scoreBands, memberTypes, features, authMode}', async () => {
    app = await build();
    const cfg = (await app.inject('/api/v1/config')).json<UiConfig>();
    expect(Object.keys(cfg).sort()).toEqual(['authMode', 'features', 'memberTypes', 'scoreBands']);
  });

  it('ErrorResponse carries exactly {requestId, success:false, error{code,message}}', async () => {
    serveSoap('fault-server.xml', 500);
    app = await build();
    const body = (await searchInject(app, { lastName: 'Testguest' })).json<ErrorResponse>();
    expect(Object.keys(body).sort()).toEqual(['error', 'requestId', 'success']);
    expect(body.success).toBe(false);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
  });
});
