// Route + app-factory integration (task 8.6; design.md "Routes", "app factory / buildApp").
//
// Each test builds the REAL app with `buildApp`, injecting a FAKE gateway and deterministic
// clocks/stores so no SOAP, undici socket or timer is touched. The app otherwise runs the real
// plugin chain, the real `GuestSearchService`, the real masker and the real reveal/session
// stores — so these tests exercise the whole HTTP layer end to end via `fastify.inject`.
import {
  ERROR_CATALOG,
  ROLES,
  type GuestSearchQuery,
  type GuestSearchResult,
} from '@ihg-guest-search/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type BuildAppDeps } from '../../../src/app.js';
import type { AuthProvider, Principal } from '../../../src/auth/authProvider.js';
import type { AppConfig } from '../../../src/config.js';
import type {
  GuestSearchGateway,
  GuestSearchOutcome,
} from '../../../src/ports/GuestSearchGateway.js';

// --- fixtures --------------------------------------------------------------------------------

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

/** Headers a legitimate same-origin SPA request carries (CSRF + JSON). */
const SPA = {
  'x-requested-with': 'guest-search',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
} as const;

const PRINCIPALS: Record<'jane' | 'reader' | 'noaccess', Principal> = {
  jane: {
    id: 'dev-jane.doe',
    displayName: 'Jane Doe (Customer Care)',
    roles: [ROLES.READ, ROLES.REVEAL],
  },
  reader: { id: 'dev-read.only', displayName: 'Riley Reader (Read only)', roles: [ROLES.READ] },
  noaccess: { id: 'dev-no.access', displayName: 'Nora NoAccess', roles: [] },
};

/** One guest with a phone and an email, so the reveal path has material to store. */
const GUEST: GuestSearchResult = {
  enterpriseId: '900000001',
  score: 88,
  firstName: 'Ada',
  lastName: 'Lovelace',
  addresses: [{ city: 'London', country: 'GB', profileDefault: true }],
  phones: [{ number: '+14045550123', type: 'mobile', profileDefault: true }],
  emails: [{ address: 'ada@example.test', profileDefault: true }],
  memberships: [{ memberId: '900000001', memberType: 'PLACEHOLDER', status: 'active' }],
};

/** A scripted gateway: returns a fixed outcome, or throws a supplied error. */
class FakeGateway implements GuestSearchGateway {
  calls = 0;
  lastQuery: GuestSearchQuery | undefined;

  constructor(
    private readonly outcome: GuestSearchOutcome,
    private readonly fail?: () => Error,
  ) {}

  search(query: GuestSearchQuery): Promise<GuestSearchOutcome> {
    this.calls += 1;
    this.lastQuery = query;
    if (this.fail !== undefined) return Promise.reject(this.fail());
    return Promise.resolve(this.outcome);
  }
}

function provider(principal: Principal | null, mode: 'dev' | 'oidc' = 'dev'): AuthProvider {
  return { mode, authenticate: (): Promise<Principal | null> => Promise.resolve(principal) };
}

/** A minimal, valid `AppConfig` for the app factory (no env parsing needed). */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    trustProxy: false,
    auth: { mode: 'dev' },
    session: {
      cookieName: 'gs_session',
      ttlMinutes: 30,
      absoluteHours: 8,
      secret: SESSION_SECRET,
    },
    soap: {
      endpoint: new URL('http://soap.invalid:8080/InitiateService'),
      soapAction: 'searchGuest',
      channelId: 'WEBWB',
      connectTimeoutMs: 3000,
      responseTimeoutMs: 10000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxResults: 50,
      features: { addressLine1: false, city: false, postalCode: false },
      header: {
        languageCode: 'en',
        countryCode: 'US',
        channel: 'test',
        subChannels: ['sub'],
        environment: 'test',
        serviceUser: 'svc',
        sequence: 1,
      },
      breaker: { failureThreshold: 5, openMs: 30000 },
    },
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
  authMode?: 'dev' | 'oidc';
  gateway?: GuestSearchGateway;
  config?: AppConfig;
  deps?: Partial<BuildAppDeps>;
}

async function build(opts: Options = {}): Promise<{ app: FastifyInstance; gateway: FakeGateway }> {
  const gateway =
    (opts.gateway as FakeGateway | undefined) ?? new FakeGateway({ results: [GUEST], limit: 50 });
  const principal = opts.principal === undefined ? PRINCIPALS.jane : opts.principal;
  const app = await buildApp(opts.config ?? makeConfig(), {
    gateway,
    authProvider: provider(principal, opts.authMode),
    now: () => 1_700_000_000_000,
    readinessConnect: () => Promise.resolve(true),
    ...opts.deps,
  });
  return { app, gateway };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Inject a search with the SPA headers and a valid single criterion. */
function searchInject(instance: FastifyInstance, payload: unknown, cookie?: string) {
  return instance.inject({
    method: 'POST',
    url: '/api/v1/guests/search',
    headers: { ...SPA, ...(cookie !== undefined && { cookie }) },
    payload: JSON.stringify(payload),
  });
}

// --- GET /api/v1/config ----------------------------------------------------------------------

describe('GET /api/v1/config', () => {
  it('returns the non-sensitive UiConfig', async () => {
    ({ app } = await build());
    const res = await app.inject('/api/v1/config');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scoreBands: { high: 90, medium: 70 },
      memberTypes: [{ code: 'PLACEHOLDER', label: 'Placeholder member type' }],
      features: { addressLine1: false, city: false, postalCode: false },
      authMode: 'dev',
    });
  });

  it('never leaks a sensitive config value (endpoint, secret, header)', async () => {
    ({ app } = await build());
    const text = (await app.inject('/api/v1/config')).body;
    expect(text).not.toContain('soap.invalid');
    expect(text).not.toContain(SESSION_SECRET);
    expect(text).not.toContain('svc');
  });
});

// --- GET /api/v1/me --------------------------------------------------------------------------

describe('GET /api/v1/me', () => {
  it('returns the display name, roles and auth mode for the full-access persona', async () => {
    ({ app } = await build({ principal: PRINCIPALS.jane }));
    const res = await app.inject('/api/v1/me');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      displayName: 'Jane Doe (Customer Care)',
      roles: [ROLES.READ, ROLES.REVEAL],
      authMode: 'dev',
    });
  });

  it('reflects a read-only persona (no reveal role)', async () => {
    ({ app } = await build({ principal: PRINCIPALS.reader }));
    expect((await app.inject('/api/v1/me')).json().roles).toEqual([ROLES.READ]);
  });

  it('reflects the oidc auth mode when configured', async () => {
    ({ app } = await build({ principal: PRINCIPALS.jane, authMode: 'oidc' }));
    expect((await app.inject('/api/v1/me')).json().authMode).toBe('oidc');
  });

  it('401 when there is no principal', async () => {
    ({ app } = await build({ principal: null }));
    const res = await app.inject('/api/v1/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });
});

// --- POST /api/v1/guests/search --------------------------------------------------------------

describe('POST /api/v1/guests/search', () => {
  it('happy path: delegates to the service and returns a masked response', async () => {
    const { app: a, gateway } = await build();
    app = a;
    const res = await searchInject(a, { firstName: 'Ada' });
    expect(res.statusCode).toBe(200);
    expect(gateway.calls).toBe(1);
    const body = res.json();
    expect(body).toMatchObject({ success: true, totalResults: 1, limit: 50 });
    // Phone/email are masked in the response; a reveal token is present for the REVEAL persona.
    const summary = body.results[0];
    expect(summary.guest.phones[0].number).not.toBe('+14045550123');
    expect(summary.guest.emails[0].address).toContain('•');
    expect(typeof summary.revealToken).toBe('string');
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });

  it('zero results returns an empty, successful response', async () => {
    const gateway = new FakeGateway({ results: [], limit: 50 });
    ({ app } = await build({ gateway }));
    const res = await searchInject(app, { lastName: 'Nobody' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, totalResults: 0, results: [] });
  });

  it('read-only persona gets results but no reveal token', async () => {
    ({ app } = await build({ principal: PRINCIPALS.reader }));
    const res = await searchInject(app, { firstName: 'Ada' });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].revealToken).toBeUndefined();
  });

  it('403 FORBIDDEN for a persona without the Read role', async () => {
    const { app: a, gateway } = await build({ principal: PRINCIPALS.noaccess });
    app = a;
    const res = await searchInject(a, { firstName: 'Ada' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    // The role gate runs before the service, so the gateway is never called.
    expect(gateway.calls).toBe(0);
  });

  it('NO_CRITERIA when the body carries no criterion', async () => {
    ({ app } = await build());
    const res = await searchInject(app, {});
    expect(res.statusCode).toBe(ERROR_CATALOG.NO_CRITERIA.http);
    expect(res.json().error.code).toBe('NO_CRITERIA');
  });

  it('VALIDATION_ERROR for a disabled address field, with a generic value-free message', async () => {
    const { app: a, gateway } = await build();
    app = a;
    const res = await searchInject(a, { city: 'London' });
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields).toContainEqual({
      field: 'city',
      message: 'This field is not yet supported for search.',
    });
    // No value echoed; the guard runs before the gateway.
    expect(body.body).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('London');
    expect(gateway.calls).toBe(0);
  });

  it('allows a feature-flagged field once its flag is on', async () => {
    const config = makeConfig();
    config.soap.features.city = true;
    const { app: a, gateway } = await build({ config });
    app = a;
    const res = await searchInject(a, { city: 'London' });
    expect(res.statusCode).toBe(200);
    expect(gateway.calls).toBe(1);
  });

  it('rejects addressLine2 (permanently disabled) regardless of flags', async () => {
    ({ app } = await build());
    const res = await searchInject(app, { addressLine2: 'Suite 5' });
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    expect(res.json().error.fields).toContainEqual({
      field: 'addressLine2',
      message: 'This field is not yet supported for search.',
    });
  });

  it('rejects an impossible phone with a value-free message', async () => {
    const { app: a, gateway } = await build();
    app = a;
    const res = await searchInject(a, { phone: '123' });
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    expect(res.json().error.fields).toContainEqual({
      field: 'phone',
      message: 'Enter a valid phone number',
    });
    expect(gateway.calls).toBe(0);
  });

  it('allows a plausible phone through to the gateway', async () => {
    const { app: a, gateway } = await build();
    app = a;
    const res = await searchInject(a, { phone: '+14155552671' });
    expect(res.statusCode).toBe(200);
    expect(gateway.calls).toBe(1);
  });

  it('maps a gateway UPSTREAM_TIMEOUT through the error handler', async () => {
    const { SoapError } = await import('../../../src/soap/responseParser.js');
    const gateway = new FakeGateway(
      { results: [], limit: 50 },
      () => new SoapError('UPSTREAM_TIMEOUT'),
    );
    ({ app } = await build({ gateway }));
    const res = await searchInject(app, { firstName: 'Ada' });
    expect(res.statusCode).toBe(ERROR_CATALOG.UPSTREAM_TIMEOUT.http);
    expect(res.json().error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('enforces the per-session search rate limit, mapped to 429 RATE_LIMITED', async () => {
    const config = makeConfig();
    config.rateLimit.searchPerMinute = 2;
    ({ app } = await build({ config }));

    let cookie = '';
    const req = async () => {
      const res = await searchInject(
        app!,
        { firstName: 'Ada' },
        cookie === '' ? undefined : cookie,
      );
      const setCookie = res.headers['set-cookie'];
      const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (first !== undefined) cookie = first.split(';', 1)[0] ?? cookie;
      return res;
    };

    expect((await req()).statusCode).toBe(200);
    expect((await req()).statusCode).toBe(200);
    const limited = await req();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
  });
});

// --- POST /api/v1/guests/reveal --------------------------------------------------------------

describe('POST /api/v1/guests/reveal', () => {
  /** Run a search, capture the session cookie and the reveal token for a follow-up reveal. */
  async function searchThenToken(
    instance: FastifyInstance,
  ): Promise<{ cookie: string; token: string }> {
    const res = await searchInject(instance, { firstName: 'Ada' });
    const setCookie = res.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookie = (first ?? '').split(';', 1)[0] ?? '';
    const token = res.json().results[0].revealToken as string;
    return { cookie, token };
  }

  function revealInject(instance: FastifyInstance, payload: unknown, cookie?: string) {
    return instance.inject({
      method: 'POST',
      url: '/api/v1/guests/reveal',
      headers: { ...SPA, ...(cookie !== undefined && { cookie }) },
      payload: JSON.stringify(payload),
    });
  }

  it('happy path: exchanges a token for the unmasked contacts in the same session', async () => {
    ({ app } = await build());
    const { cookie, token } = await searchThenToken(app);
    const res = await revealInject(app, { revealToken: token }, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phones[0].number).toBe('+14045550123');
    expect(body.emails[0].address).toBe('ada@example.test');
  });

  it('403 FORBIDDEN without the RevealPII role', async () => {
    ({ app } = await build({ principal: PRINCIPALS.reader }));
    const res = await revealInject(app, { revealToken: 'rt_whatever' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('VALIDATION_ERROR when the token is missing', async () => {
    ({ app } = await build());
    const res = await revealInject(app, {});
    expect(res.statusCode).toBe(ERROR_CATALOG.VALIDATION_ERROR.http);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('REVEAL_EXPIRED for an unknown or cross-session token', async () => {
    ({ app } = await build());
    const res = await revealInject(app, { revealToken: 'rt_unknown-token-value' });
    expect(res.statusCode).toBe(ERROR_CATALOG.REVEAL_EXPIRED.http);
    expect(res.json().error.code).toBe('REVEAL_EXPIRED');
  });

  it('REVEAL_EXPIRED once the TTL has lapsed (advancing the injected clock)', async () => {
    let clock = 1_700_000_000_000;
    ({ app } = await build({ deps: { now: () => clock } }));
    const { cookie, token } = await searchThenToken(app);
    // Advance past the 10-minute TTL.
    clock += 11 * 60_000;
    const res = await revealInject(app, { revealToken: token }, cookie);
    expect(res.statusCode).toBe(ERROR_CATALOG.REVEAL_EXPIRED.http);
    expect(res.json().error.code).toBe('REVEAL_EXPIRED');
  });
});

// --- POST /api/v1/session/logout -------------------------------------------------------------

describe('POST /api/v1/session/logout', () => {
  it('clears the cookie, sets Clear-Site-Data and answers 204', async () => {
    ({ app } = await build());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session/logout',
      headers: SPA,
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['clear-site-data']).toContain('cookies');
    const setCookie = res.headers['set-cookie'];
    const serialized = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    // The clear sets an expired/empty cookie.
    expect(serialized.toLowerCase()).toContain('gs_session');
  });

  it('drops the reveal material so a later reveal of the same token is expired', async () => {
    ({ app } = await build());
    // Search to mint a token within a session, keeping the cookie.
    const search = await searchInject(app, { firstName: 'Ada' });
    const setCookie = search.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookie = (first ?? '').split(';', 1)[0] ?? '';
    const token = search.json().results[0].revealToken as string;

    await app.inject({
      method: 'POST',
      url: '/api/v1/session/logout',
      headers: { ...SPA, cookie },
    });

    // The old session cookie is gone; a reveal with it (new session) cannot see the token.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/reveal',
      headers: { ...SPA, cookie },
      payload: JSON.stringify({ revealToken: token }),
    });
    expect(res.json().error?.code ?? 'ok').not.toBe('ok');
  });
});

// --- health ----------------------------------------------------------------------------------

describe('health endpoints', () => {
  it('GET /health/live is a static ok, no auth, no no-store', async () => {
    ({ app } = await build({ principal: null }));
    const res = await app.inject('/health/live');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).not.toBe('no-store');
  });

  it('GET /health/ready reports ok when the SOAP probe connects', async () => {
    ({ app } = await build({
      principal: null,
      deps: { readinessConnect: () => Promise.resolve(true) },
    }));
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { config: true, soap: true } });
  });

  it('GET /health/ready reports 503 degraded when the SOAP probe fails', async () => {
    ({ app } = await build({
      principal: null,
      deps: { readinessConnect: () => Promise.resolve(false) },
    }));
    const res = await app.inject('/health/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { config: true, soap: false } });
  });
});

// --- unknown routes --------------------------------------------------------------------------

describe('unknown routes', () => {
  it('returns a JSON ErrorResponse for an unknown /api route (never HTML)', async () => {
    ({ app } = await build());
    const res = await app.inject('/api/v1/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    expect(res.json().requestId).toBeDefined();
  });
});
