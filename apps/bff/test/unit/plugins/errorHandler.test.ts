// Error handler mapping (task 8.5, Req 19). Every thrown value must resolve to the pinned
// ErrorResponse shape with the catalog status/message, a requestId, and no leaked internals.
import { ERROR_CATALOG, type ErrorCode } from '@ihg-guest-search/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../../../src/errors.js';
import { createErrorHandler, createNotFoundHandler } from '../../../src/plugins/errorHandler.js';
import { genReqId } from '../../../src/plugins/requestId.js';
import { SoapError } from '../../../src/soap/responseParser.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A tiny app whose single route throws whatever the test supplies. */
async function buildThrowing(thrown: () => unknown): Promise<FastifyInstance> {
  const f = Fastify({ genReqId, logger: false });
  f.setErrorHandler(createErrorHandler());
  f.setNotFoundHandler(createNotFoundHandler());
  // onRequest sets the header exactly like the requestId plugin, so requestId is always present.
  f.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id);
  });
  f.get('/boom', async () => {
    throw thrown();
  });
  f.post('/echo', async (req) => req.body);
  await f.ready();
  app = f;
  return f;
}

const catalogMessage = (code: ErrorCode) => ERROR_CATALOG[code].message;
const catalogHttp = (code: ErrorCode) => ERROR_CATALOG[code].http;

describe('AppError mapping', () => {
  it.each([
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'REVEAL_EXPIRED',
    'NO_CRITERIA',
    'INTERNAL_ERROR',
  ] as const)('maps AppError(%s) to its catalog status and message', async (code) => {
    const f = await buildThrowing(() => new AppError(code, 'operator-only detail'));
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(catalogHttp(code));
    expect(res.json()).toEqual({
      requestId: expect.any(String),
      success: false,
      error: { code, message: catalogMessage(code) },
    });
    // The operator-only message never reaches the client.
    expect(res.body).not.toContain('operator-only detail');
  });

  it('carries per-field messages for VALIDATION_ERROR from the error cause', async () => {
    const f = await buildThrowing(
      () =>
        new AppError('VALIDATION_ERROR', 'Criteria validation failed', {
          cause: [
            { field: 'email', message: 'Enter a valid email address.' },
            { field: 'country', message: 'Enter a valid country.' },
          ],
        }),
    );
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      requestId: expect.any(String),
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: catalogMessage('VALIDATION_ERROR'),
        fields: [
          { field: 'email', message: 'Enter a valid email address.' },
          { field: 'country', message: 'Enter a valid country.' },
        ],
      },
    });
  });

  it('omits fields when a VALIDATION_ERROR has no usable cause', async () => {
    const f = await buildThrowing(() => new AppError('VALIDATION_ERROR', 'x'));
    const res = await f.inject('/boom');
    expect(res.json().error).not.toHaveProperty('fields');
  });
});

describe('ZodError mapping', () => {
  it('a root-only issue maps to NO_CRITERIA', async () => {
    const schema = z.object({}).refine(() => false, { message: 'root', path: [] });
    const f = await buildThrowing(() => schema.safeParse({}).error);
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(catalogHttp('NO_CRITERIA'));
    expect(res.json().error.code).toBe('NO_CRITERIA');
    expect(res.json().error).not.toHaveProperty('fields');
  });

  it('field issues map to VALIDATION_ERROR with flattened, de-duplicated field messages', async () => {
    const schema = z.object({ email: z.string().email('bad email') });
    const f = await buildThrowing(() => schema.safeParse({ email: 'nope' }).error);
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.fields).toEqual([{ field: 'email', message: 'bad email' }]);
  });
});

describe('SoapError mapping', () => {
  it.each([
    'UPSTREAM_TIMEOUT',
    'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_HTTP_ERROR',
    'UPSTREAM_FAULT',
    'UPSTREAM_TXN_FAILED',
    'UPSTREAM_CONTRACT',
    'UPSTREAM_MALFORMED',
  ] as const)('maps SoapError(%s) through the catalog', async (code) => {
    const f = await buildThrowing(() => new SoapError(code, 'soap:Server'));
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(catalogHttp(code));
    expect(res.json().error).toEqual({ code, message: catalogMessage(code) });
    // The sanitized detail is for logs only; it must not be in the body.
    expect(res.body).not.toContain('soap:Server');
  });
});

/**
 * A fake Fastify transport error carrying only the fields the handler classifies on. Throwing
 * this from a handler exercises the mapping without driving the body parser (the real 413/415
 * paths over the wire are covered end-to-end by the security integration suite).
 */
function fastifyError(
  code: string,
  statusCode: number,
): Error & { code: string; statusCode: number } {
  return Object.assign(new Error('transport'), { code, statusCode });
}

describe('Fastify transport errors', () => {
  it('413 (body too large) keeps status 413 with a VALIDATION_ERROR body', async () => {
    const f = await buildThrowing(() => fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413));
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: catalogMessage('VALIDATION_ERROR') },
    });
    expect(res.json().requestId).toBeDefined();
  });

  it('415 (invalid media type) keeps status 415 with a VALIDATION_ERROR body', async () => {
    const f = await buildThrowing(() => fastifyError('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415));
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('a bare 429 status (rate limit) maps to RATE_LIMITED', async () => {
    const f = await buildThrowing(() => fastifyError('FST_ERR_UNKNOWN', 429));
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('unknown errors', () => {
  it('a plain Error becomes INTERNAL_ERROR and leaks nothing', async () => {
    const f = await buildThrowing(() => new Error('secret stack detail /etc/passwd'));
    const res = await f.inject('/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      requestId: expect.any(String),
      success: false,
      error: { code: 'INTERNAL_ERROR', message: catalogMessage('INTERNAL_ERROR') },
    });
    expect(res.body).not.toContain('secret stack detail');
    expect(res.body).not.toContain('/etc/passwd');
    expect(res.body).not.toContain('stack');
  });
});

describe('not-found handler', () => {
  it('returns a catalog-shaped 404 with a requestId and no route details', async () => {
    const f = await buildThrowing(() => new Error('unused'));
    const res = await f.inject('/no/such/route');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      requestId: expect.any(String),
      success: false,
      error: { code: 'VALIDATION_ERROR', message: catalogMessage('VALIDATION_ERROR') },
    });
  });
});

describe('requestId presence', () => {
  it('every error body carries the same requestId as the X-Request-ID header', async () => {
    const f = await buildThrowing(() => new AppError('FORBIDDEN', 'x'));
    const res = await f.inject({ url: '/boom', headers: { 'x-request-id': 'corr-123' } });
    expect(res.headers['x-request-id']).toBe('corr-123');
    expect(res.json().requestId).toBe('corr-123');
  });
});
