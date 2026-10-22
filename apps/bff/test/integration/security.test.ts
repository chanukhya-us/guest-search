// Security integration tests (task 10.2; Req 14, 20.6/20.7/20.10/20.11, 21; design.md "Security"
// and "Testing strategy").
//
// Scope split with the rest of the suite (deliberate, to avoid duplication):
//   - `plugins/httpLayer.test.ts` already proves the stateless HTTP-layer guarantees at the plugin
//     composition level: the exact CSP/helmet headers, HSTS prod/dev, `no-store`, `X-Request-ID`,
//     the 401 path, the CSRF `X-Requested-With` + `Sec-Fetch-Site` checks, 415, 413, per-session
//     429 and the no-CORS rule. Those are NOT re-proven wholesale here.
//   - This file owns the behaviours task 10.2 enumerates that are stateful or end-to-end and that
//     the plugin suite cannot reach, driven through the REAL `buildApp` with `fastify.inject`:
//       * the reveal security LIFECYCLE end to end — issue, reveal within TTL, expire (advancing an
//         injected reveal-store clock the service shares), cross-session reuse, garbage token, and
//         logout teardown — all failing indistinguishably as REVEAL_EXPIRED (no oracle);
//       * session hardening on a real response — cookie attributes in the dev (`gs_session`) and the
//         production-like (`__Host-`) shapes, signed-cookie tamper resistance, and session expiry;
//       * the 403 / reveal / error-body leak guarantees — 403 never names the missing role, reveal
//         failures are byte-for-byte identical, error bodies carry only catalog messages.
//   - A small set of app-level confirmations (CSRF 403, 415, no-CORS at the `buildApp` level) is
//     kept here as a thin cross-check that the composed app — not just the isolated plugin harness —
//     still enforces them; each notes that the exhaustive proof lives in `httpLayer.test.ts`.
//
// Determinism: the clock is injected through `buildApp`'s `now`, which `buildApp` shares between the
// reveal store (TTL) and the service (audit/timestamps), and a session store built with the same
// clock drives idle/absolute expiry — so TTL and expiry are advanced by moving one number, never a
// real timer.
import {
  ERROR_CATALOG,
  ROLES,
  type ErrorResponse,
  type GuestSearchResult,
} from '@ihg-guest-search/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type BuildAppDeps } from '../../src/app.js';
import type { AuthProvider, Principal } from '../../src/auth/authProvider.js';
import { MemorySessionStore } from '../../src/auth/sessionStore.js';
import type { AppConfig } from '../../src/config.js';
import type { GuestSearchGateway, GuestSearchOutcome } from '../../src/ports/GuestSearchGateway.js';
import { MemoryRevealStore } from '../../src/security/revealStore.js';

// --- fixtures --------------------------------------------------------------------------------

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

/** Headers a legitimate same-origin SPA request carries (CSRF + JSON). */
const SPA = {
  'x-requested-with': 'guest-search',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
} as const;

const PRINCIPALS: Record<'reveal' | 'reader' | 'noaccess', Principal> = {
  reveal: {
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

/** A fake gateway: returns a fixed single-guest outcome; never touches SOAP/undici. */
class FakeGateway implements GuestSearchGateway {
  calls = 0;
  constructor(private readonly outcome: GuestSearchOutcome = { results: [GUEST], limit: 50 }) {}
  search(): Promise<GuestSearchOutcome> {
    this.calls += 1;
    return Promise.resolve(this.outcome);
  }
}

function provider(principal: Principal | null): AuthProvider {
  return { mode: 'dev', authenticate: (): Promise<Principal | null> => Promise.resolve(principal) };
}

/** A minimal, valid `AppConfig`. `cookieName` and `production` are the two security-relevant knobs. */
function makeConfig(
  overrides: {
    cookieName?: string;
    nodeEnv?: AppConfig['nodeEnv'];
    revealTtlMinutes?: number;
  } = {},
): AppConfig {
  return {
    nodeEnv: overrides.nodeEnv ?? 'test',
    port: 0,
    trustProxy: false,
    auth: { mode: 'dev' },
    session: {
      cookieName: overrides.cookieName ?? 'gs_session',
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
    reveal: { ttlMinutes: overrides.revealTtlMinutes ?? 10 },
    ui: {
      scoreBands: { high: 90, medium: 70 },
      memberTypes: [{ code: 'PLACEHOLDER', label: 'Placeholder member type' }],
    },
    log: { level: 'silent', auditLogPath: 'logs/audit.jsonl' },
    telemetry: { exporter: 'none' },
  };
}

interface Options {
  principal?: Principal | null;
  config?: AppConfig;
  deps?: Partial<BuildAppDeps>;
}

async function build(opts: Options = {}): Promise<FastifyInstance> {
  const principal = opts.principal === undefined ? PRINCIPALS.reveal : opts.principal;
  return buildApp(opts.config ?? makeConfig(), {
    gateway: new FakeGateway(),
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

// --- cookie helpers --------------------------------------------------------------------------

/** The raw `Set-Cookie` header value(s), always as an array. */
function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

/** The `name=value` pair of the named cookie from a response, for carrying across requests. */
function cookiePair(res: { headers: Record<string, unknown> }, name: string): string {
  const match = setCookies(res).find((c) => c.startsWith(`${name}=`));
  return (match ?? '').split(';', 1)[0] ?? '';
}

function searchInject(instance: FastifyInstance, payload: unknown, cookie?: string) {
  return instance.inject({
    method: 'POST',
    url: '/api/v1/guests/search',
    headers: { ...SPA, ...(cookie !== undefined && { cookie }) },
    payload: JSON.stringify(payload),
  });
}

function revealInject(instance: FastifyInstance, token: unknown, cookie?: string) {
  return instance.inject({
    method: 'POST',
    url: '/api/v1/guests/reveal',
    headers: { ...SPA, ...(cookie !== undefined && { cookie }) },
    payload: JSON.stringify({ revealToken: token }),
  });
}

/** Run a search for the reveal persona and return the issued token plus the session cookie. */
async function searchForToken(
  instance: FastifyInstance,
  cookieName = 'gs_session',
): Promise<{ cookie: string; token: string }> {
  const res = await searchInject(instance, { firstName: 'Ada' });
  const cookie = cookiePair(res, cookieName);
  const token = res.json().results[0].revealToken as string;
  return { cookie, token };
}

// =============================================================================================
// 1. Reveal security lifecycle end to end (Req 14.6, 14.7, 14.9, 14.11, 20.11)
// =============================================================================================

describe('reveal security lifecycle (Req 14.6, 14.9, 14.11, 20.11)', () => {
  it('a token issued within the TTL returns the UNMASKED contacts for the same session', async () => {
    app = await build();
    const { cookie, token } = await searchForToken(app);

    const res = await revealInject(app, token, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phones[0].number).toBe('+14045550123');
    expect(body.emails[0].address).toBe('ada@example.test');
  });

  it('the SAME token after the TTL elapses is REVEAL_EXPIRED (404) — injected clock advanced', async () => {
    // The reveal store is built with the clock the service also reads (buildApp shares `now`),
    // so advancing the one number expires the entry exactly as a wall clock would after the TTL.
    let clock = 1_700_000_000_000;
    const revealStore = new MemoryRevealStore({ ttlMs: 10 * 60_000, now: () => clock });
    app = await build({ deps: { now: () => clock, revealStore } });

    const { cookie, token } = await searchForToken(app);

    // Within the window it still works.
    expect((await revealInject(app, token, cookie)).statusCode).toBe(200);

    // Advance just past the 10-minute TTL; the same token is now expired.
    clock += 10 * 60_000 + 1;
    const expired = await revealInject(app, token, cookie);
    expect(expired.statusCode).toBe(ERROR_CATALOG.REVEAL_EXPIRED.http);
    expect(expired.json<ErrorResponse>().error.code).toBe('REVEAL_EXPIRED');
  });

  it('a token minted in session A cannot be consumed by session B (cross-session) — REVEAL_EXPIRED', async () => {
    app = await build();

    // Session A searches and gets a token bound to A's session.
    const { cookie: cookieA, token } = await searchForToken(app);

    // Session B is a fresh session (its own cookie); it must not be able to spend A's token.
    const seedB = await searchInject(app, { firstName: 'Ada' });
    const cookieB = cookiePair(seedB, 'gs_session');
    expect(cookieB).not.toBe(cookieA);

    const crossed = await revealInject(app, token, cookieB);
    expect(crossed.statusCode).toBe(ERROR_CATALOG.REVEAL_EXPIRED.http);
    expect(crossed.json<ErrorResponse>().error.code).toBe('REVEAL_EXPIRED');

    // And the token still works for its own session — proving B was rejected on binding, not
    // because the token was globally consumed/destroyed.
    expect((await revealInject(app, token, cookieA)).statusCode).toBe(200);
  });

  it('an unknown / garbage token is REVEAL_EXPIRED (404), indistinguishable from expired', async () => {
    app = await build();
    const { cookie } = await searchForToken(app);

    const res = await revealInject(app, 'rt_this-token-was-never-issued', cookie);
    expect(res.statusCode).toBe(ERROR_CATALOG.REVEAL_EXPIRED.http);
    expect(res.json<ErrorResponse>().error.code).toBe('REVEAL_EXPIRED');
  });

  it('expired, cross-session and unknown tokens produce a BYTE-FOR-BYTE identical body (no oracle)', async () => {
    // The three failure modes must be indistinguishable to a caller, or the error becomes an
    // oracle (e.g. "this token exists but is expired" vs "never existed"). Compare the full bodies.
    let clock = 1_700_000_000_000;
    const revealStore = new MemoryRevealStore({ ttlMs: 10 * 60_000, now: () => clock });
    app = await build({ deps: { now: () => clock, revealStore } });

    // (a) expired
    const { cookie: cookieA, token } = await searchForToken(app);
    clock += 10 * 60_000 + 1;
    const expired = await revealInject(app, token, cookieA);

    // (b) cross-session: a fresh session spending a freshly minted token from another session.
    clock += 1; // keep moving so the fresh token is not already expired
    const seedB = await searchInject(app, { firstName: 'Ada' });
    const cookieB = cookiePair(seedB, 'gs_session');
    const freshA = await searchForToken(app, 'gs_session');
    const crossed = await revealInject(app, freshA.token, cookieB);

    // (c) unknown
    const unknown = await revealInject(app, 'rt_never-existed', cookieB);

    // Same status and same body — only the requestId differs, so strip it before comparing.
    const strip = (r: { json: () => ErrorResponse }) => {
      const b = r.json();
      return { statusAndError: { success: b.success, error: b.error } };
    };
    expect(expired.statusCode).toBe(ERROR_CATALOG.REVEAL_EXPIRED.http);
    expect(crossed.statusCode).toBe(expired.statusCode);
    expect(unknown.statusCode).toBe(expired.statusCode);
    expect(strip(crossed)).toEqual(strip(expired));
    expect(strip(unknown)).toEqual(strip(expired));
  });

  it('after logout the token is dropped AND the cookie is cleared; a later reveal is REVEAL_EXPIRED', async () => {
    app = await build();
    const { cookie, token } = await searchForToken(app);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/session/logout',
      headers: { ...SPA, cookie },
    });
    expect(logout.statusCode).toBe(204);
    // Clear-Site-Data instructs the browser to drop cookies/storage/cache for the origin.
    expect(logout.headers['clear-site-data']).toBe('"cache", "cookies", "storage"');
    // The session cookie is actively cleared in the logout response: an empty value plus an
    // expiry in the past (either a 1970 `Expires` or `Max-Age=0`, depending on serialization).
    const cleared = setCookies(logout).find((c) => c.startsWith('gs_session='));
    expect(cleared).toBeDefined();
    const clearedLower = (cleared ?? '').toLowerCase();
    expect(clearedLower.startsWith('gs_session=;')).toBe(true);
    expect(
      clearedLower.includes('expires=thu, 01 jan 1970') || clearedLower.includes('max-age=0'),
    ).toBe(true);

    // Reusing the OLD cookie now resolves to a brand-new session (the store entry was destroyed),
    // so A's reveal material is gone: the token no longer belongs to the caller's session.
    const afterLogout = await revealInject(app, token, cookie);
    expect(afterLogout.statusCode).toBe(ERROR_CATALOG.REVEAL_EXPIRED.http);
    expect(afterLogout.json<ErrorResponse>().error.code).toBe('REVEAL_EXPIRED');
  });
});

// =============================================================================================
// 2. Session cookie hardening end to end (Req 20.10)
// =============================================================================================

describe('session cookie hardening (Req 20.10)', () => {
  /** Parse the attributes of the named Set-Cookie into a lower-cased flag set + values. */
  function parseCookie(res: { headers: Record<string, unknown> }, name: string) {
    const header = setCookies(res).find((c) => c.startsWith(`${name}=`)) ?? '';
    const parts = header.split(';').map((p) => p.trim());
    const flags = new Set(parts.map((p) => p.toLowerCase()));
    const attr = (key: string): string | undefined => {
      const hit = parts.find((p) => p.toLowerCase().startsWith(`${key.toLowerCase()}=`));
      return hit?.slice(key.length + 1);
    };
    return { header, flags, attr };
  }

  it('the dev gs_session cookie is HttpOnly, SameSite=Strict, Path=/, and NOT Secure', async () => {
    app = await build({ config: makeConfig({ cookieName: 'gs_session' }) });
    const res = await app.inject('/api/v1/me');
    const { flags, attr } = parseCookie(res, 'gs_session');

    expect(flags.has('httponly')).toBe(true);
    expect(attr('SameSite')?.toLowerCase()).toBe('strict');
    expect(attr('Path')).toBe('/');
    // Plain-HTTP localhost dev must omit Secure so the cookie works without TLS.
    expect(flags.has('secure')).toBe(false);
    // No Domain is ever pinned.
    expect(attr('Domain')).toBeUndefined();
  });

  it('a production-like __Host- cookie is Secure, HttpOnly, SameSite=Strict, Path=/ and carries no Domain', async () => {
    const cookieName = '__Host-gs_session';
    app = await build({ config: makeConfig({ cookieName, nodeEnv: 'production' }) });
    const res = await app.inject('/api/v1/me');
    const { flags, attr } = parseCookie(res, cookieName);

    // The __Host- prefix is a browser-enforced contract: Secure + Path=/ + no Domain.
    expect(flags.has('secure')).toBe(true);
    expect(flags.has('httponly')).toBe(true);
    expect(attr('SameSite')?.toLowerCase()).toBe('strict');
    expect(attr('Path')).toBe('/');
    expect(attr('Domain')).toBeUndefined();
  });

  it('the session cookie is SIGNED: tampering the value yields a fresh session, not an error', async () => {
    app = await build();

    // First request mints a signed session cookie.
    const first = await app.inject('/api/v1/me');
    expect(first.statusCode).toBe(200);
    const good = cookiePair(first, 'gs_session'); // name=value.value.sig

    // Flip a character in the cookie value to break the HMAC signature.
    const value = good.slice('gs_session='.length);
    const tamperedChar = value.charAt(0) === 'A' ? 'B' : 'A';
    const tampered = `gs_session=${tamperedChar}${value.slice(1)}`;

    const res = await app.inject({ url: '/api/v1/me', headers: { cookie: tampered } });
    // A forged/tampered id is ignored and a new session is established — not a 4xx/5xx.
    expect(res.statusCode).toBe(200);
    const reissued = cookiePair(res, 'gs_session');
    expect(reissued).not.toBe('');
    expect(reissued).not.toBe(tampered);
  });

  it('an expired session is replaced and its reveal material does not survive (idle+absolute timeout)', async () => {
    // A session store on the same injected clock makes idle/absolute expiry deterministic.
    let clock = 1_700_000_000_000;
    const sessionStore = new MemorySessionStore({
      ttlMs: 30 * 60_000,
      absoluteMs: 8 * 3_600_000,
      now: () => clock,
    });
    // Reveal TTL kept long so it is the SESSION expiry (not the token TTL) that ends the reveal.
    const revealStore = new MemoryRevealStore({ ttlMs: 24 * 3_600_000, now: () => clock });
    app = await build({
      config: makeConfig({ revealTtlMinutes: 24 * 60 }),
      deps: { now: () => clock, sessionStore, revealStore },
    });

    const { cookie, token } = await searchForToken(app);
    expect((await revealInject(app, token, cookie)).statusCode).toBe(200);

    // Idle past the 30-minute window with no activity: the session is dead on the next read.
    clock += 30 * 60_000 + 1;

    // The old cookie now resolves to a brand-new session, so the token's session is gone:
    // protected reveal state does not survive session expiry.
    const afterExpiry = await revealInject(app, token, cookie);
    expect(afterExpiry.statusCode).toBe(ERROR_CATALOG.REVEAL_EXPIRED.http);
    expect(afterExpiry.json<ErrorResponse>().error.code).toBe('REVEAL_EXPIRED');
  });
});

// =============================================================================================
// 3. Authorization / no-leak guarantees (Req 20.6, 20.7; design.md "Security" — fail securely)
// =============================================================================================

describe('authorization never leaks internals (Req 20.7, 19.3)', () => {
  it('403 FORBIDDEN never names the missing role or the required permission', async () => {
    app = await build({ principal: PRINCIPALS.noaccess });
    const res = await searchInject(app, { firstName: 'Ada' });
    expect(res.statusCode).toBe(ERROR_CATALOG.FORBIDDEN.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.code).toBe('FORBIDDEN');
    // Only the generic catalog message — no role names, no "RevealPII"/"Read", no permission list.
    expect(body.error.message).toBe(ERROR_CATALOG.FORBIDDEN.message);
    expect(res.body).not.toContain('Read');
    expect(res.body).not.toContain('RevealPII');
    expect(res.body).not.toContain('role');
  });

  it('a read-only persona is forbidden from reveal and the body names no role', async () => {
    app = await build({ principal: PRINCIPALS.reader });
    const res = await revealInject(app, 'rt_whatever');
    expect(res.statusCode).toBe(ERROR_CATALOG.FORBIDDEN.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.message).toBe(ERROR_CATALOG.FORBIDDEN.message);
    expect(res.body).not.toContain('RevealPII');
  });

  it('401 UNAUTHENTICATED (no principal) carries only the catalog message', async () => {
    app = await build({ principal: null });
    const res = await app.inject('/api/v1/me');
    expect(res.statusCode).toBe(ERROR_CATALOG.UNAUTHENTICATED.http);
    const body = res.json<ErrorResponse>();
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(body.error.message).toBe(ERROR_CATALOG.UNAUTHENTICATED.message);
  });

  it('a read-only search response carries no reveal token to leak (Req 14.5)', async () => {
    app = await build({ principal: PRINCIPALS.reader });
    const res = await searchInject(app, { firstName: 'Ada' });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].revealToken).toBeUndefined();
    // And no raw contact leaks in the masked response.
    expect(res.body).not.toContain('+14045550123');
    expect(res.body).not.toContain('ada@example.test');
  });
});

// =============================================================================================
// 4. App-level cross-checks of the stateless HTTP-layer guarantees (Req 21)
// =============================================================================================
// The exhaustive proofs live in `plugins/httpLayer.test.ts`; these confirm the SAME rules still
// hold once composed by the real `buildApp` (not just the isolated plugin harness).

describe('composed-app cross-checks (Req 21.1-21.5, 6.2)', () => {
  it('sets Content-Security-Policy and the baseline hardening headers on an API response', async () => {
    app = await build();
    const res = await app.inject('/api/v1/me');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects a state-changing request missing X-Requested-With with 403 (CSRF)', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      payload: JSON.stringify({ firstName: 'Ada' }),
    });
    expect(res.statusCode).toBe(ERROR_CATALOG.FORBIDDEN.http);
    expect(res.json<ErrorResponse>().error.code).toBe('FORBIDDEN');
  });

  it('rejects a cross-site state-changing request with 403 (CSRF)', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: { ...SPA, 'sec-fetch-site': 'cross-site' },
      payload: JSON.stringify({ firstName: 'Ada' }),
    });
    expect(res.statusCode).toBe(ERROR_CATALOG.FORBIDDEN.http);
  });

  it('answers 415 for a non-JSON content-type on a state-changing route (Req 6.2)', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: { 'x-requested-with': 'guest-search', 'content-type': 'text/plain' },
      payload: 'not json',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json<ErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });

  it('emits no Access-Control-* (CORS) headers (Req 21.5)', async () => {
    app = await build();
    const res = await app.inject({
      url: '/api/v1/me',
      headers: { origin: 'https://evil.test' },
    });
    for (const header of Object.keys(res.headers)) {
      expect(header.toLowerCase().startsWith('access-control-')).toBe(false);
    }
  });
});
