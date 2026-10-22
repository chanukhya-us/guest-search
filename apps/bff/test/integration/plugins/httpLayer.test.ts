// HTTP-layer integration (task 8.5, Req 21, 20.6, 19.2). Composes the real plugin chain with
// `registerHttpPlugins` in the design order and exercises it with `fastify.inject`.
import { ERROR_CATALOG } from '@ihg-guest-search/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthProvider, Principal } from '../../../src/auth/authProvider.js';
import { MemorySessionStore } from '../../../src/auth/sessionStore.js';
import { CSP_DIRECTIVES } from '../../../src/plugins/security.js';
import { genReqId } from '../../../src/plugins/requestId.js';
import { registerHttpPlugins, type HttpPluginDeps } from '../../../src/plugins/index.js';

const JANE: Principal = {
  id: 'dev-jane',
  displayName: 'Jane Doe',
  roles: ['GuestSearch.Read', 'GuestSearch.RevealPII'],
};

/** A provider stub so the 401 path (null principal) is testable without OIDC. */
function provider(principal: Principal | null): AuthProvider {
  return { mode: 'dev', authenticate: (): Promise<Principal | null> => Promise.resolve(principal) };
}

interface BuildOptions {
  principal?: Principal | null;
  production?: boolean;
  searchPerMinute?: number;
}

async function build(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const f = Fastify({ genReqId, logger: false, bodyLimit: 8192 });

  // JSON-only: drop Fastify's default parsers (which also accept text/plain) and keep only the
  // JSON parser, so any other media type is rejected with Fastify's built-in 415 (task 8.6 wires
  // this into buildApp; mirrored here so the 415 path is covered by the security suite).
  f.removeAllContentTypeParsers();
  f.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body === '' ? undefined : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const deps: HttpPluginDeps = {
    production: opts.production ?? false,
    sessionSecret: 'test-session-secret-at-least-32-characters-long',
    sessionCookieName: 'gs_session',
    sessionStore: new MemorySessionStore({ ttlMs: 1_800_000, absoluteMs: 28_800_000 }),
    authProvider: provider(opts.principal === undefined ? JANE : opts.principal),
  };
  await registerHttpPlugins(f, deps);

  f.get('/api/v1/me', async (req: FastifyRequest) => ({
    displayName: req.principal?.displayName ?? null,
  }));
  f.post(
    '/api/v1/guests/search',
    { config: { rateLimit: { max: opts.searchPerMinute ?? 1000, timeWindow: '1 minute' } } },
    async (req: FastifyRequest) => ({ ok: true, body: req.body }),
  );
  f.get('/health/live', async () => ({ status: 'ok' }));

  await f.ready();
  return f;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Headers a legitimate SPA request carries. */
const SPA = { 'x-requested-with': 'guest-search', 'content-type': 'application/json' };

describe('security headers (Req 21.1)', () => {
  it('sets the exact CSP, Referrer-Policy, nosniff and frame headers', async () => {
    app = await build();
    const res = await app.inject('/health/live');

    // helmet serializes directives joined by ';' (no trailing space); assert each directive is
    // present in the single source of truth form.
    const csp = res.headers['content-security-policy'] as string;
    for (const [name, values] of Object.entries(CSP_DIRECTIVES)) {
      expect(csp).toContain(`${name} ${values.join(' ')}`);
    }
    // And exactly these directives, nothing added by a helmet default.
    expect(
      csp
        .split(';')
        .map((d) => d.trim().split(' ')[0])
        .sort(),
    ).toEqual(Object.keys(CSP_DIRECTIVES).sort());
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('omits HSTS in development and sets it in production', async () => {
    app = await build({ production: false });
    expect((await app.inject('/health/live')).headers['strict-transport-security']).toBeUndefined();
    await app.close();

    app = await build({ production: true });
    expect((await app.inject('/health/live')).headers['strict-transport-security']).toBeDefined();
  });
});

describe('no-store (Req 21.2)', () => {
  it('sets Cache-Control: no-store on /api/* but not on health', async () => {
    app = await build();
    expect((await app.inject('/api/v1/me')).headers['cache-control']).toBe('no-store');
    expect((await app.inject('/health/live')).headers['cache-control']).not.toBe('no-store');
  });
});

describe('X-Request-ID (Req 22.10)', () => {
  it('is present on every response including rejections', async () => {
    app = await build({ principal: null });
    const ok = await app.inject('/health/live');
    expect(ok.headers['x-request-id']).toBeDefined();

    const unauth = await app.inject('/api/v1/me');
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers['x-request-id']).toBeDefined();
    expect(unauth.json().requestId).toBe(unauth.headers['x-request-id']);
  });
});

describe('authentication (Req 20.6)', () => {
  it('401 UNAUTHENTICATED on /api/* when the provider returns no principal', async () => {
    app = await build({ principal: null });
    const res = await app.inject('/api/v1/me');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      success: false,
      error: { code: 'UNAUTHENTICATED', message: ERROR_CATALOG.UNAUTHENTICATED.message },
    });
  });

  it('allows a non-API path (health) without a principal', async () => {
    app = await build({ principal: null });
    expect((await app.inject('/health/live')).statusCode).toBe(200);
  });
});

describe('CSRF (Req 21.3, 21.4)', () => {
  it('rejects a state-changing request without X-Requested-With', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('rejects a state-changing request with Sec-Fetch-Site: cross-site', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: { ...SPA, 'sec-fetch-site': 'cross-site' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('allows a state-changing request with the header and a same-origin fetch site', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: { ...SPA, 'sec-fetch-site': 'same-origin' },
      payload: { firstName: 'A' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not burden safe GET requests with the CSRF check', async () => {
    app = await build();
    expect((await app.inject('/api/v1/me')).statusCode).toBe(200);
  });
});

describe('content-type and body limit (Req 6.2, 6.3)', () => {
  it('415 for a non-JSON content-type', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: { 'x-requested-with': 'guest-search', 'content-type': 'text/plain' },
      payload: 'plain',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('413 for a body over the 8 KB limit', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: SPA,
      payload: JSON.stringify({ firstName: 'x'.repeat(9000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('rate limiting (Req 21.6)', () => {
  it('429 RATE_LIMITED after the per-session budget, mapped through the error handler', async () => {
    app = await build({ searchPerMinute: 2 });

    // The limit is keyed by session, so the test must carry the session cookie across requests
    // (each fresh inject would otherwise get a new session and a fresh budget).
    let cookie = '';
    const req = async () => {
      const res = await app!.inject({
        method: 'POST',
        url: '/api/v1/guests/search',
        headers: { ...SPA, ...(cookie !== '' && { cookie }) },
        payload: { firstName: 'A' },
      });
      const setCookie = res.headers['set-cookie'];
      if (setCookie !== undefined) {
        const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        cookie = (first ?? '').split(';', 1)[0] ?? cookie;
      }
      return res;
    };

    expect((await req()).statusCode).toBe(200);
    expect((await req()).statusCode).toBe(200);
    const limited = await req();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED', message: ERROR_CATALOG.RATE_LIMITED.message },
    });
    expect(limited.json().requestId).toBeDefined();
  });

  it('keeps independent budgets per session (different sessions are not pooled)', async () => {
    app = await build({ searchPerMinute: 1 });
    const call = (cookie?: string) =>
      app!.inject({
        method: 'POST',
        url: '/api/v1/guests/search',
        headers: { ...SPA, ...(cookie !== undefined && { cookie }) },
        payload: { firstName: 'A' },
      });

    const first = await call();
    expect(first.statusCode).toBe(200);
    const setCookie = first.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const sessionCookie = (raw ?? '').split(';', 1)[0];

    // Same session a second time -> limited.
    expect((await call(sessionCookie)).statusCode).toBe(429);
    // A brand-new session (no cookie) still has its own budget.
    expect((await call()).statusCode).toBe(200);
  });
});

describe('no CORS (Req 21.5)', () => {
  it('emits no Access-Control-* headers', async () => {
    app = await build();
    const res = await app.inject({ url: '/api/v1/me', headers: { origin: 'https://evil.test' } });
    for (const h of Object.keys(res.headers)) {
      expect(h.toLowerCase().startsWith('access-control-')).toBe(false);
    }
  });
});
