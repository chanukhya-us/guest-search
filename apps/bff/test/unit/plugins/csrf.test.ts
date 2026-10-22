// CSRF plugin (task 8.5, Req 21.3, 21.4), exercised in isolation with a bare app.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/errors.js';
import { csrfPlugin, REQUIRED_REQUESTED_WITH } from '../../../src/plugins/csrf.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  await f.register(csrfPlugin);
  f.setErrorHandler((err, _req, reply) => {
    const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
    return reply.code(code === 'FORBIDDEN' ? 403 : 500).send({ code });
  });
  f.get('/g', async () => ({ ok: true }));
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    f.route({ method: m, url: '/u', handler: async () => ({ ok: true }) });
  }
  await f.ready();
  app = f;
  return f;
}

const withHeader = { 'x-requested-with': REQUIRED_REQUESTED_WITH };

describe('safe methods', () => {
  it('lets GET through without any CSRF header', async () => {
    const f = await build();
    expect((await f.inject('/g')).statusCode).toBe(200);
  });
});

describe('unsafe methods require X-Requested-With', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    '%s is 403 without the header',
    async (m) => {
      const f = await build();
      expect((await f.inject({ method: m, url: '/u' })).statusCode).toBe(403);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('%s passes with the header', async (m) => {
    const f = await build();
    expect((await f.inject({ method: m, url: '/u', headers: withHeader })).statusCode).toBe(200);
  });

  it('rejects a wrong header value', async () => {
    const f = await build();
    const res = await f.inject({
      method: 'POST',
      url: '/u',
      headers: { 'x-requested-with': 'xhr' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Sec-Fetch-Site', () => {
  it('rejects cross-site even when the custom header is present', async () => {
    const f = await build();
    const res = await f.inject({
      method: 'POST',
      url: '/u',
      headers: { ...withHeader, 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(403);
  });

  it.each(['same-origin', 'same-site', 'none'])(
    'allows %s with the custom header',
    async (site) => {
      const f = await build();
      const res = await f.inject({
        method: 'POST',
        url: '/u',
        headers: { ...withHeader, 'sec-fetch-site': site },
      });
      expect(res.statusCode).toBe(200);
    },
  );
});
