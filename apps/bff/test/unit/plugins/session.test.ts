// Session plugin: cookie hardening and cookie<->store round-trips (task 8.2, Req 20.10).
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySessionStore, type SessionStore } from '../../../src/auth/sessionStore.js';
import { isHostPrefixed, sessionPlugin } from '../../../src/plugins/session.js';

const SECRET = 'test-secret-value-at-least-32-chars-long!!';
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface BuildOpts {
  cookieName?: string;
  store?: SessionStore;
  now?: () => number;
}

// The first Fastify inject lazily loads light-my-request; keep headroom under coverage.
async function build(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const cookieName = opts.cookieName ?? '__Host-Http-gs_session';
  const store =
    opts.store ??
    new MemorySessionStore({ ttlMs: IDLE_MS, absoluteMs: ABSOLUTE_MS, now: opts.now });
  const f = Fastify();
  f.decorateRequest('principal', null);
  await f.register(sessionPlugin, { secret: SECRET, cookieName, store });
  f.get('/whoami', (request) => ({
    id: request.session.id,
    principalId: request.session.principalId,
  }));
  f.post('/logout', (request, reply) => {
    request.destroySession(reply);
    return reply.code(204).send();
  });
  await f.ready();
  app = f;
  return f;
}

/** Collect the Set-Cookie header(s) as a single lower-cased string for attribute checks. */
function setCookie(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie'];
  return Array.isArray(header) ? header.join('\n') : String(header ?? '');
}

/** Extract the raw (still signed) cookie value for a given name from a Set-Cookie header. */
function cookieValue(res: { headers: Record<string, unknown> }, name: string): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : [String(header ?? '')];
  const match = list.find((c) => c.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no ${name} cookie set`);
  return match.slice(name.length + 1).split(';')[0] as string;
}

describe('isHostPrefixed', () => {
  it('is true only for __Host- names', () => {
    expect(isHostPrefixed('__Host-Http-gs_session')).toBe(true);
    expect(isHostPrefixed('gs_session')).toBe(false);
  });
});

describe('cookie attributes', () => {
  it('non-dev __Host- cookie is HttpOnly, Secure, SameSite=Strict, Path=/, no Domain', async () => {
    const f = await build({ cookieName: '__Host-Http-gs_session' });
    const res = await f.inject('/whoami');
    const header = setCookie(res).toLowerCase();
    expect(header).toContain('__host-http-gs_session=');
    expect(header).toContain('httponly');
    expect(header).toContain('secure');
    expect(header).toContain('samesite=strict');
    expect(header).toContain('path=/');
    expect(header).not.toContain('domain=');
  });

  it('dev gs_session cookie is HttpOnly and SameSite=Strict but not Secure', async () => {
    const f = await build({ cookieName: 'gs_session' });
    const res = await f.inject('/whoami');
    const header = setCookie(res).toLowerCase();
    expect(header).toContain('gs_session=');
    expect(header).toContain('httponly');
    expect(header).toContain('samesite=strict');
    expect(header).not.toContain('secure');
    expect(header).not.toContain('domain=');
  });

  it('sends a signed value (not the bare opaque ID)', async () => {
    const store = new MemorySessionStore({ ttlMs: IDLE_MS, absoluteMs: ABSOLUTE_MS });
    const f = await build({ store });
    const res = await f.inject('/whoami');
    const sessionId = (res.json() as { id: string }).id;
    const raw = cookieValue(res, '__Host-Http-gs_session');
    // Signed cookies carry the value plus an HMAC, so the raw cookie is longer and differs.
    expect(raw).not.toBe(sessionId);
    expect(raw.startsWith(`${sessionId}.`)).toBe(true);
  });
});

describe('session establishment and reuse', () => {
  it('creates a session on the first request', async () => {
    const f = await build();
    const res = await f.inject('/whoami');
    expect((res.json() as { id: string }).id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('reuses the same session when the signed cookie is returned', async () => {
    const f = await build();
    const first = await f.inject('/whoami');
    const cookieHeader = cookieValue(first, '__Host-Http-gs_session');
    const firstId = (first.json() as { id: string }).id;

    const second = await f.inject({
      url: '/whoami',
      headers: { cookie: `__Host-Http-gs_session=${cookieHeader}` },
    });
    expect((second.json() as { id: string }).id).toBe(firstId);
  });

  it('issues a new session for a tampered signature', async () => {
    const f = await build();
    const first = await f.inject('/whoami');
    const firstId = (first.json() as { id: string }).id;
    const raw = cookieValue(first, '__Host-Http-gs_session');
    const tampered = `${raw.slice(0, -3)}zzz`; // corrupt the HMAC tail

    const second = await f.inject({
      url: '/whoami',
      headers: { cookie: `__Host-Http-gs_session=${tampered}` },
    });
    expect((second.json() as { id: string }).id).not.toBe(firstId);
  });

  it('issues a new session for an unknown (unsigned) cookie value', async () => {
    const f = await build();
    const res = await f.inject({
      url: '/whoami',
      headers: { cookie: '__Host-Http-gs_session=never-signed-value' },
    });
    expect((res.json() as { id: string }).id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('principal binding', () => {
  it('binds a new session to request.principal.id when present', async () => {
    const store = new MemorySessionStore({ ttlMs: IDLE_MS, absoluteMs: ABSOLUTE_MS });
    const f = Fastify();
    f.decorateRequest('principal', null);
    // Stand-in for the task 8.5 auth plugin: set a principal before the session hook.
    f.addHook('onRequest', async (request) => {
      request.principal = { id: 'dev-jane.doe', displayName: 'Jane', roles: [] };
    });
    await f.register(sessionPlugin, { secret: SECRET, cookieName: 'gs_session', store });
    f.get('/whoami', (request) => ({ principalId: request.session.principalId }));
    await f.ready();
    app = f;

    const res = await f.inject('/whoami');
    expect((res.json() as { principalId: string }).principalId).toBe('dev-jane.doe');
  });

  it('falls back to an anonymous binding without a principal', async () => {
    const f = await build({ cookieName: 'gs_session' });
    const res = await f.inject('/whoami');
    expect((res.json() as { principalId: string }).principalId).toBe('anonymous');
  });
});

describe('store eviction', () => {
  it('issues a new session when a validly signed cookie is no longer in the store', async () => {
    let now = 1_000_000;
    const store = new MemorySessionStore({
      ttlMs: IDLE_MS,
      absoluteMs: ABSOLUTE_MS,
      now: () => now,
    });
    const f = await build({ store, now: () => now });
    const first = await f.inject('/whoami');
    const firstId = (first.json() as { id: string }).id;
    const signed = cookieValue(first, '__Host-Http-gs_session');

    // Advance past the idle window so the (still correctly signed) ID is gone from the store.
    now += IDLE_MS;
    const second = await f.inject({
      url: '/whoami',
      headers: { cookie: `__Host-Http-gs_session=${signed}` },
    });
    expect((second.json() as { id: string }).id).not.toBe(firstId);
  });
});

describe('cookie plugin reuse', () => {
  it('works when @fastify/cookie is already registered by the app', async () => {
    const store = new MemorySessionStore({ ttlMs: IDLE_MS, absoluteMs: ABSOLUTE_MS });
    const f = Fastify();
    f.decorateRequest('principal', null);
    await f.register(cookie, { secret: SECRET });
    await f.register(sessionPlugin, { secret: SECRET, cookieName: 'gs_session', store });
    f.get('/whoami', (request) => ({ id: request.session.id }));
    await f.ready();
    app = f;

    const res = await f.inject('/whoami');
    expect((res.json() as { id: string }).id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(setCookie(res).toLowerCase()).toContain('gs_session=');
  });
});

describe('destroySession (logout)', () => {
  it('removes the session from the store and expires the cookie', async () => {
    const store = new MemorySessionStore({ ttlMs: IDLE_MS, absoluteMs: ABSOLUTE_MS });
    const f = await build({ store });
    const first = await f.inject('/whoami');
    const sessionId = (first.json() as { id: string }).id;
    const signed = cookieValue(first, '__Host-Http-gs_session');
    expect(store.get(sessionId)).not.toBeNull();

    const res = await f.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie: `__Host-Http-gs_session=${signed}` },
    });
    expect(res.statusCode).toBe(204);
    // The onRequest hook recreated a session for this very request, but the ORIGINAL
    // session ID must be gone from the store after destroy.
    expect(store.get(sessionId)).toBeNull();
    // The logout response expires the cookie (Max-Age=0 / Expires in the past).
    const header = setCookie(res).toLowerCase();
    expect(header).toMatch(/max-age=0|expires=/);
  });
});
