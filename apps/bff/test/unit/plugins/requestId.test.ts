// requestId plugin + genReqId (task 8.5, Req 22.1, 22.10).
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { genReqId, REQUEST_ID_HEADER, requestIdPlugin } from '../../../src/plugins/requestId.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(): Promise<FastifyInstance> {
  const f = Fastify({ genReqId, logger: false });
  await f.register(requestIdPlugin);
  f.get('/x', async (req) => ({ id: req.id }));
  await f.ready();
  app = f;
  return f;
}

describe('genReqId', () => {
  it('mints a UUID v4 when no inbound header is present', () => {
    const id = genReqId({ headers: {} });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('reuses a safe inbound X-Request-ID', () => {
    expect(genReqId({ headers: { 'x-request-id': 'trace-abc_123.9' } })).toBe('trace-abc_123.9');
  });

  it('rejects an unsafe inbound id (control chars / too long) and mints a fresh one', () => {
    const bad = genReqId({ headers: { 'x-request-id': 'line1\r\nInjected: evil' } });
    expect(bad).not.toContain('Injected');
    expect(genReqId({ headers: { 'x-request-id': 'x'.repeat(200) } })).toHaveLength(36);
  });

  it('takes the first value when the header is sent more than once', () => {
    expect(genReqId({ headers: { 'x-request-id': ['first', 'second'] } })).toBe('first');
  });
});

describe('requestIdPlugin', () => {
  it('sets the X-Request-ID header to request.id on every response', async () => {
    const f = await build();
    const res = await f.inject('/x');
    expect(res.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe(res.json().id);
  });

  it('echoes a trusted inbound id end to end', async () => {
    const f = await build();
    const res = await f.inject({ url: '/x', headers: { 'x-request-id': 'corr-1' } });
    expect(res.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe('corr-1');
    expect(res.json().id).toBe('corr-1');
  });
});
