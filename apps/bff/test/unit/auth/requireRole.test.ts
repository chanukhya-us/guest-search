// requireRole preHandler (task 8.1, Req 20.6, 20.7, 14.8), exercised with each dev persona.
import { ERROR_CATALOG, ROLES } from '@ihg-guest-search/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DevAuthProvider, type Principal } from '../../../src/auth/authProvider.js';
import { DEV_PERSONAS, type DevPersonaId } from '../../../src/auth/devPersonas.js';
import { hasRole, requireRole } from '../../../src/auth/requireRole.js';
import { AppError } from '../../../src/errors.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Minimal app: a principal hook (stand-in for the task 8.5 auth plugin) and an error
 * handler mapping AppError codes through ERROR_CATALOG, as the real one will.
 */
async function build(principal: () => Promise<Principal | null>): Promise<FastifyInstance> {
  const f = Fastify();
  f.decorateRequest('principal', null);
  f.addHook('onRequest', async (request) => {
    request.principal = await principal();
  });
  f.setErrorHandler((err, _request, reply) => {
    const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
    const { http, message } = ERROR_CATALOG[code];
    return reply.code(http).send({ success: false, error: { code, message } });
  });
  f.get('/read', { preHandler: requireRole(ROLES.READ) }, () => ({ ok: true }));
  f.get('/reveal', { preHandler: requireRole(ROLES.REVEAL) }, () => ({ ok: true }));
  await f.ready();
  app = f;
  return f;
}

const asPersona = (id: DevPersonaId) => {
  const provider = new DevAuthProvider(DEV_PERSONAS[id]);
  return () => provider.authenticate();
};

// The first Fastify inject lazily loads light-my-request; under the parallel coverage run
// that cold start can exceed Vitest's 5 s default, so give these tests headroom.
describe('requireRole with dev personas', { timeout: 20_000 }, () => {
  it.each([
    ['jane.doe', 200, 200],
    ['read.only', 200, 403],
    ['no.access', 403, 403],
  ] as const)('%s: read=%i reveal=%i', async (persona, readStatus, revealStatus) => {
    const f = await build(asPersona(persona));
    expect((await f.inject('/read')).statusCode).toBe(readStatus);
    expect((await f.inject('/reveal')).statusCode).toBe(revealStatus);
  });

  it('responds 403 FORBIDDEN with the catalog message only', async () => {
    const res = await (await build(asPersona('no.access'))).inject('/read');
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: ERROR_CATALOG.FORBIDDEN.message },
    });
    expect(res.body).not.toContain(ROLES.READ);
  });

  it('responds 401 UNAUTHENTICATED when no principal is present', async () => {
    const res = await (await build(() => Promise.resolve(null))).inject('/read');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});

describe('hasRole', () => {
  const p: Principal = { id: 'dev-x', displayName: 'X', roles: [ROLES.READ] };

  it('matches roles exactly (case-sensitive, no prefix match)', () => {
    expect(hasRole(p, ROLES.READ)).toBe(true);
    expect(hasRole(p, 'guestsearch.read')).toBe(false);
    expect(hasRole(p, 'GuestSearch')).toBe(false);
    expect(hasRole(p, ROLES.REVEAL)).toBe(false);
  });

  it('is false without a principal', () => {
    expect(hasRole(null, ROLES.READ)).toBe(false);
    expect(hasRole(undefined, ROLES.READ)).toBe(false);
  });
});
