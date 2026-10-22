// auth + noStore plugins in isolation (task 8.5, Req 20.6, 21.2).
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthProvider, Principal } from '../../../src/auth/authProvider.js';
import { AppError } from '../../../src/errors.js';
import { authPlugin, isApiPath } from '../../../src/plugins/auth.js';
import { noStorePlugin } from '../../../src/plugins/noStore.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const JANE: Principal = { id: 'dev-jane', displayName: 'Jane', roles: ['GuestSearch.Read'] };
const provider = (p: Principal | null): AuthProvider => ({
  mode: 'dev',
  authenticate: (): Promise<Principal | null> => Promise.resolve(p),
});

async function build(principal: Principal | null): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  await f.register(noStorePlugin);
  await f.register(authPlugin, { provider: provider(principal) });
  f.setErrorHandler((err, _req, reply) => {
    const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
    return reply.code(code === 'UNAUTHENTICATED' ? 401 : 500).send({ code });
  });
  f.get('/api/v1/me', async (req) => ({ name: req.principal?.displayName ?? null }));
  f.get('/health/live', async () => ({ status: 'ok' }));
  await f.ready();
  app = f;
  return f;
}

describe('isApiPath', () => {
  it.each([
    ['/api', true],
    ['/api/', true],
    ['/api/v1/me', true],
    ['/api/v1/guests/search?x=1', true],
    ['/health/live', false],
    ['/', false],
    ['/apiary', false],
  ])('%s -> %s', (url, expected) => {
    expect(isApiPath(url)).toBe(expected);
  });
});

describe('auth plugin', () => {
  it('attaches the principal and allows /api/* when authenticated', async () => {
    const f = await build(JANE);
    const res = await f.inject('/api/v1/me');
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Jane');
  });

  it('returns 401 UNAUTHENTICATED on /api/* when the principal is null', async () => {
    const f = await build(null);
    expect((await f.inject('/api/v1/me')).statusCode).toBe(401);
  });

  it('does not require a principal on non-API paths', async () => {
    const f = await build(null);
    expect((await f.inject('/health/live')).statusCode).toBe(200);
  });
});

describe('noStore plugin', () => {
  it('sets no-store on /api/* and leaves other paths cacheable', async () => {
    const f = await build(JANE);
    expect((await f.inject('/api/v1/me')).headers['cache-control']).toBe('no-store');
    expect((await f.inject('/health/live')).headers['cache-control']).not.toBe('no-store');
  });
});
