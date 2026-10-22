// Rate-limit keying (task 8.5, Req 21.6). The limiter keys by session id, falling back to the
// client IP only when no session exists.
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { sessionKey } from '../../../src/plugins/rateLimit.js';

/** Minimal FastifyRequest stand-in: only the fields sessionKey reads. */
function req(session: { id?: string } | undefined, ip = '10.0.0.1'): FastifyRequest {
  return { session, ip } as unknown as FastifyRequest;
}

describe('sessionKey', () => {
  it('keys by session id when a session is present', () => {
    expect(sessionKey(req({ id: 'sess-abc' }))).toBe('s:sess-abc');
  });

  it('falls back to the client IP when there is no session', () => {
    expect(sessionKey(req(undefined, '203.0.113.7'))).toBe('ip:203.0.113.7');
  });

  it('falls back to the client IP when the session has no id', () => {
    expect(sessionKey(req({}, '198.51.100.2'))).toBe('ip:198.51.100.2');
  });
});
