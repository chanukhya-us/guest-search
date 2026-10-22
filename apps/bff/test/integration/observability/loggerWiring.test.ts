// Logger / audit wiring through buildApp (task 9.1; Req 22.1, 22.2, 22.5, 22.10, 14.10).
//
// This boots the REAL app with `buildApp`, injecting a pino logger bound to an in-memory sink and
// a BufferAuditLogger, plus a fake gateway so no SOAP is touched. It then runs a real search over
// `fastify.inject` and asserts the three things task 9.1 promises end to end:
//   1. the per-request log child carries `reqId`, equal to the `X-Request-ID` response header;
//   2. the service's search-completion line is emitted through the same logger, with criteria
//      field NAMES (not values);
//   3. a `guest.search` audit event is recorded with who/requestId/resultCount and no PII.
// A separate case drives the reveal path to confirm the `guest.reveal` audit event carries the
// Enterprise-ID HMAC and that no contact value appears in either log.
import { ROLES, type GuestSearchResult } from '@ihg-guest-search/shared';
import type { FastifyInstance } from 'fastify';
import pino, { type DestinationStream, type Logger } from 'pino';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/app.js';
import type { AuthProvider, Principal } from '../../../src/auth/authProvider.js';
import type { AppConfig } from '../../../src/config.js';
import { BufferAuditLogger } from '../../../src/observability/audit.js';
import { baseLoggerOptions } from '../../../src/observability/logger.js';
import type {
  GuestSearchGateway,
  GuestSearchOutcome,
} from '../../../src/ports/GuestSearchGateway.js';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';
const NOW = 1_700_000_000_000;

const SPA = {
  'x-requested-with': 'guest-search',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
} as const;

const REVEALER: Principal = {
  id: 'dev-jane.doe',
  displayName: 'Jane Doe',
  roles: [ROLES.READ, ROLES.REVEAL],
};

const GUEST: GuestSearchResult = {
  enterpriseId: '900000001',
  score: 88,
  firstName: 'Ada',
  lastName: 'Lovelace',
  addresses: [{ city: 'London', country: 'GB', profileDefault: true }],
  phones: [{ number: '+14045550123', type: 'mobile', profileDefault: true }],
  emails: [{ address: 'ada-secret@example.test', profileDefault: true }],
  memberships: [{ memberId: '900000001', memberType: 'PLACEHOLDER', status: 'active' }],
};

class FakeGateway implements GuestSearchGateway {
  constructor(private readonly outcome: GuestSearchOutcome) {}
  // The method ignores its arguments; a parameterless method still satisfies the port.
  search(): Promise<GuestSearchOutcome> {
    return Promise.resolve(this.outcome);
  }
}

function provider(principal: Principal): AuthProvider {
  return { mode: 'dev', authenticate: (): Promise<Principal> => Promise.resolve(principal) };
}

/** A pino logger on an in-memory sink, so emitted lines can be parsed and asserted. */
function captureLogger(): { logger: Logger; lines(): Record<string, unknown>[]; text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = pino(
    baseLoggerOptions({ nodeEnv: 'test', log: { level: 'info', auditLogPath: 'x' } }),
    stream as unknown as DestinationStream,
  );
  return {
    logger,
    text: (): string => chunks.join(''),
    lines: (): Record<string, unknown>[] =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 0,
    trustProxy: false,
    auth: { mode: 'dev' },
    session: { cookieName: 'gs_session', ttlMinutes: 30, absoluteHours: 8, secret: SESSION_SECRET },
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
    log: { level: 'info', auditLogPath: 'logs/audit.jsonl' },
    telemetry: { exporter: 'none' },
  };
}

async function build(capture: ReturnType<typeof captureLogger>, audit: BufferAuditLogger) {
  return buildApp(makeConfig(), {
    gateway: new FakeGateway({ results: [GUEST], limit: 50 }),
    authProvider: provider(REVEALER),
    now: () => NOW,
    readinessConnect: () => Promise.resolve(true),
    appLogger: capture.logger,
    audit,
  });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('logger + audit wiring (task 9.1)', () => {
  it('per-request lines carry reqId equal to X-Request-ID, and the search line names fields only', async () => {
    const capture = captureLogger();
    const audit = new BufferAuditLogger();
    app = await build(capture, audit);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: SPA,
      payload: JSON.stringify({ lastName: 'Lovelace', email: 'q@example.test' }),
    });
    expect(res.statusCode).toBe(200);

    const requestId = res.headers['x-request-id'];
    expect(typeof requestId).toBe('string');

    const lines = capture.lines();
    // Fastify's per-request child logs under `reqId` (requestIdLogLabel), matching the header.
    const requestLines = lines.filter((l) => typeof l.reqId === 'string');
    expect(requestLines.length).toBeGreaterThan(0);
    for (const line of requestLines) {
      expect(line.reqId).toBe(requestId);
    }

    // The service completion line went through the same logger: field NAMES, no values.
    const completed = lines.find((l) => l.event === 'guest.search.completed');
    expect(completed).toBeDefined();
    expect(completed?.requestId).toBe(requestId);
    expect(completed?.criteriaFields).toEqual(expect.arrayContaining(['lastName', 'email']));
    expect(completed?.resultCount).toBe(1);
    expect(completed?.outcome).toBe('success');
    // The searched value never appears in the completion payload.
    expect(JSON.stringify(completed)).not.toContain('Lovelace');
    expect(JSON.stringify(completed)).not.toContain('q@example.test');

    // Audit trail: one guest.search event, who/requestId/count, no PII.
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      action: 'guest.search',
      who: REVEALER.id,
      requestId,
      resultCount: 1,
    });
  });

  it('records a guest.reveal audit event with the Enterprise-ID HMAC and leaks no contact value', async () => {
    const capture = captureLogger();
    const audit = new BufferAuditLogger();
    app = await build(capture, audit);

    const searchRes = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/search',
      headers: SPA,
      payload: JSON.stringify({ lastName: 'Lovelace' }),
    });
    const cookie = searchRes.headers['set-cookie'];
    const revealToken = (searchRes.json() as { results: { revealToken?: string }[] }).results[0]
      ?.revealToken;
    expect(revealToken).toBeDefined();

    const revealRes = await app.inject({
      method: 'POST',
      url: '/api/v1/guests/reveal',
      headers: { ...SPA, ...(cookie !== undefined && { cookie: String(cookie) }) },
      payload: JSON.stringify({ revealToken }),
    });
    expect(revealRes.statusCode).toBe(200);

    const reveal = audit.records.find((r) => r.action === 'guest.reveal');
    expect(reveal).toBeDefined();
    expect(reveal?.who).toBe(REVEALER.id);
    expect(typeof reveal?.enterpriseIdHash).toBe('string');
    expect(reveal?.enterpriseIdHash).not.toBe('900000001'); // the HMAC, not the raw id
    expect(reveal).not.toHaveProperty('resultCount');

    // The unmasked email is returned to the authorized client but never written to the app log.
    expect(capture.text()).not.toContain('ada-secret@example.test');
    const auditJson = JSON.stringify(audit.records);
    expect(auditJson).not.toContain('ada-secret@example.test');
    expect(auditJson).not.toContain('900000001');
  });
});
