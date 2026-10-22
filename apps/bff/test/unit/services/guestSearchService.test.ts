// GuestSearchService (task 8.4; Req 6.4, 6.5, 13.4, 14.5, 14.7, 14.10).
//
// Exercised with a FAKE gateway and the REAL masker + schema + MemoryRevealStore, so the
// behaviour under test is the service's orchestration (validate → gateway → primaries →
// token → mask → response/reveal), not a mock of its own logic. The reveal store's clock and
// token generator are injected for determinism.
import {
  ROLES,
  createCriteriaSchema,
  defaultSchemaConfig,
  type GuestSearchInput,
  type GuestSearchQuery,
  type GuestSearchResult,
} from '@ihg-guest-search/shared';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../../src/auth/authProvider.js';
import { AppError } from '../../../src/errors.js';
import type {
  GuestSearchContext,
  GuestSearchOutcome,
} from '../../../src/ports/GuestSearchGateway.js';
import { MemoryRevealStore } from '../../../src/security/revealStore.js';
import {
  GuestSearchService,
  type AuditEvent,
  type AuditLogger,
  type CriteriaSchema,
  type FieldError,
  type SearchContext,
  type ServiceLogger,
  type ServiceMetrics,
} from '../../../src/services/guestSearchService.js';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

/** A gateway that records the query it received and returns a fixed outcome (or throws). */
class FakeGateway {
  lastQuery: GuestSearchQuery | undefined;
  lastRequestId: string | undefined;
  calls = 0;

  constructor(
    private readonly outcome: GuestSearchOutcome | (() => never),
    private readonly throws = false,
  ) {}

  search(query: GuestSearchQuery, ctx: GuestSearchContext): Promise<GuestSearchOutcome> {
    this.calls += 1;
    this.lastQuery = query;
    this.lastRequestId = ctx.requestId;
    if (this.throws) return Promise.reject((this.outcome as () => never)());
    return Promise.resolve(this.outcome as GuestSearchOutcome);
  }
}

const schema: CriteriaSchema = createCriteriaSchema(defaultSchemaConfig);

function principal(roles: readonly string[]): Principal {
  return Object.freeze({
    id: 'dev-user',
    displayName: 'Dev User',
    roles: Object.freeze([...roles]),
  });
}

function ctx(p: Principal): SearchContext {
  return { requestId: 'req-123', principal: p, sessionId: 'sess-1' };
}

/** A reveal store with an injected clock + counting token generator (deterministic). */
function makeStore(): {
  store: MemoryRevealStore;
  now: () => number;
  setNow: (ms: number) => void;
} {
  let current = 1_000_000;
  let counter = 0;
  const store = new MemoryRevealStore({
    ttlMs: 10 * 60 * 1000,
    now: () => current,
    idGenerator: () => `rt_test-${String(++counter)}`,
  });
  return { store, now: () => current, setNow: (ms) => (current = ms) };
}

function guest(overrides: Partial<GuestSearchResult> = {}): GuestSearchResult {
  return {
    enterpriseId: 'E900000001',
    score: 95,
    firstName: 'Alex',
    lastName: 'Rivera',
    addresses: [],
    phones: [],
    emails: [],
    memberships: [],
    ...overrides,
  };
}

function makeService(
  gateway: FakeGateway,
  deps: {
    store?: MemoryRevealStore;
    audit?: AuditLogger;
    logger?: ServiceLogger;
    metrics?: ServiceMetrics;
  } = {},
): GuestSearchService {
  const store = deps.store ?? makeStore().store;
  return new GuestSearchService({
    // FakeGateway structurally implements GuestSearchGateway.
    gateway,
    schema,
    revealStore: store,
    sessionSecret: SESSION_SECRET,
    now: () => 1_234_567,
    ...(deps.audit && { audit: deps.audit }),
    ...(deps.logger && { logger: deps.logger }),
    ...(deps.metrics && { metrics: deps.metrics }),
  });
}

describe('GuestSearchService.search — validation', () => {
  it('throws NO_CRITERIA when no criterion is supplied and never calls the gateway', async () => {
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway);

    await expect(service.search({}, ctx(principal([ROLES.READ])))).rejects.toMatchObject({
      name: 'AppError',
      code: 'NO_CRITERIA',
    });
    expect(gateway.calls).toBe(0);
  });

  it('treats a whitespace-only field as no criterion (NO_CRITERIA)', async () => {
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway);

    await expect(
      service.search({ firstName: '   ' }, ctx(principal([ROLES.READ]))),
    ).rejects.toMatchObject({ code: 'NO_CRITERIA' });
    expect(gateway.calls).toBe(0);
  });

  it('throws VALIDATION_ERROR with per-field messages for an invalid field', async () => {
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway);

    const input: GuestSearchInput = { email: 'not-an-email' };
    try {
      await service.search(input, ctx(principal([ROLES.READ])));
      expect.unreachable('expected VALIDATION_ERROR');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe('VALIDATION_ERROR');
      const fields = err.cause as FieldError[];
      expect(fields).toEqual([{ field: 'email', message: expect.any(String) }]);
      // The field message must NOT echo the submitted value (Req 19.3).
      expect(fields[0]?.message).not.toContain('not-an-email');
    }
    expect(gateway.calls).toBe(0);
  });

  it('rejects an unknown key as VALIDATION_ERROR (strict object), not NO_CRITERIA', async () => {
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway);

    await expect(
      service.search({ bogus: 'x' } as GuestSearchInput, ctx(principal([ROLES.READ]))),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(gateway.calls).toBe(0);
  });

  it('passes the normalized validated query to the gateway, not the raw input', async () => {
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway);

    await service.search({ firstName: '  Alex  ' }, ctx(principal([ROLES.READ])));
    expect(gateway.lastQuery).toEqual({ firstName: 'Alex' });
    expect(gateway.lastRequestId).toBe('req-123');
  });
});

describe('GuestSearchService.search — response shape', () => {
  it('returns requestId, success, totalResults=results.length, limit and results', async () => {
    const gateway = new FakeGateway({
      results: [guest(), guest({ enterpriseId: 'E2' })],
      limit: 50,
    });
    const service = makeService(gateway);

    const res = await service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ])));
    expect(res.requestId).toBe('req-123');
    expect(res.success).toBe(true);
    expect(res.totalResults).toBe(2);
    expect(res.limit).toBe(50);
    expect(res.results).toHaveLength(2);
  });

  it('returns totalResults 0 and an empty results array for zero guests (Req 6.5)', async () => {
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway);

    const res = await service.search({ lastName: 'Nobody' }, ctx(principal([ROLES.READ])));
    expect(res.totalResults).toBe(0);
    expect(res.results).toEqual([]);
  });

  it('propagates gateway errors unchanged (does not swallow UPSTREAM_*)', async () => {
    const boom = new AppError('UPSTREAM_TIMEOUT', 'upstream slow');
    const gateway = new FakeGateway(() => {
      throw boom;
    }, true);
    const service = makeService(gateway);

    await expect(service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ])))).rejects.toBe(
      boom,
    );
  });
});

describe('GuestSearchService.search — masking and primary selection', () => {
  const rich = guest({
    phones: [
      { number: '+1 404 555 0101', type: 'H', profileDefault: false },
      { number: '+1 404 555 0199', type: 'M', profileDefault: true },
    ],
    emails: [
      { address: 'alex.rivera@example.test', profileDefault: false },
      { address: 'a@example.test', profileDefault: true },
    ],
    addresses: [
      { line1: '1 First St', city: 'Atlanta', profileDefault: false },
      { line1: '2 Second St', city: 'Atlanta', profileDefault: true },
    ],
    memberships: [{ memberId: '900000001', memberType: 'PC', status: 'A' }],
  });

  it('masks phone and email values in the full response collections (Req 14.1-14.3)', async () => {
    const gateway = new FakeGateway({ results: [rich], limit: 50 });
    const service = makeService(gateway);

    const res = await service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ])));
    const g = res.results[0]?.guest;
    expect(g?.phones.map((p) => p.number)).toEqual(['•••• 0101', '•••• 0199']);
    expect(g?.emails.map((e) => e.address)).toEqual(['a•••@example.test', '•••@example.test']);
    // Non-contact fields are never masked (Req 14.4).
    expect(g?.firstName).toBe('Alex');
    expect(g?.addresses[0]?.line1).toBe('1 First St');
  });

  it('selects primaries from the real data: profileDefault wins, then masks the primary', async () => {
    const gateway = new FakeGateway({ results: [rich], limit: 50 });
    const service = makeService(gateway);

    const res = await service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ])));
    const primary = res.results[0]?.primary;
    // The profileDefault=true phone/email/address are chosen (selection on unmasked data)...
    expect(primary?.phone?.type).toBe('M');
    expect(primary?.email?.profileDefault).toBe(true);
    expect(primary?.address?.line1).toBe('2 Second St');
    // ...and the primary contact display values are masked (Req 14.1-14.3).
    expect(primary?.phone?.number).toBe('•••• 0199');
    expect(primary?.email?.address).toBe('•••@example.test');
    // Membership primary is the only item; not a contact value, so unmasked.
    expect(primary?.membership?.memberId).toBe('900000001');
  });

  it('reports no primary for empty collections (Req 13.3)', async () => {
    const gateway = new FakeGateway({ results: [guest()], limit: 50 });
    const service = makeService(gateway);

    const res = await service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ])));
    expect(res.results[0]?.primary).toEqual({});
  });
});

describe('GuestSearchService.search — reveal-token issuance (Req 14.5)', () => {
  const withContacts = guest({
    phones: [{ number: '+1 404 555 0101', profileDefault: true }],
    emails: [{ address: 'alex@example.test', profileDefault: true }],
  });

  it('issues a reveal token per result only for a principal with the REVEAL role', async () => {
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const service = makeService(gateway);

    const res = await service.search(
      { lastName: 'Rivera' },
      ctx(principal([ROLES.READ, ROLES.REVEAL])),
    );
    expect(res.results[0]?.revealToken).toBe('rt_test-1');
  });

  it('does NOT issue a reveal token for a Read-only principal', async () => {
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const service = makeService(gateway);

    const res = await service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ])));
    expect(res.results[0]?.revealToken).toBeUndefined();
  });

  it('stores the UNMASKED contacts behind the token (masking is display-only)', async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const service = makeService(gateway, { store });

    const res = await service.search(
      { lastName: 'Rivera' },
      ctx(principal([ROLES.READ, ROLES.REVEAL])),
    );
    const token = res.results[0]?.revealToken ?? '';
    const entry = store.consume(token, 'sess-1');
    expect(entry?.phones[0]?.number).toBe('+1 404 555 0101');
    expect(entry?.emails[0]?.address).toBe('alex@example.test');
  });

  it('does not issue a token for a guest with no phones or emails even with the role', async () => {
    const gateway = new FakeGateway({ results: [guest()], limit: 50 });
    const service = makeService(gateway);

    const res = await service.search(
      { lastName: 'Rivera' },
      ctx(principal([ROLES.READ, ROLES.REVEAL])),
    );
    expect(res.results[0]?.revealToken).toBeUndefined();
  });
});

describe('GuestSearchService.reveal', () => {
  const withContacts = guest({
    phones: [{ number: '+1 404 555 0101', profileDefault: true }],
    emails: [{ address: 'alex@example.test', profileDefault: true }],
  });

  async function searchThenToken(
    store: MemoryRevealStore,
    gateway: FakeGateway,
    sessionId = 'sess-1',
  ): Promise<{ service: GuestSearchService; token: string }> {
    const service = makeService(gateway, { store });
    const res = await service.search(
      { lastName: 'Rivera' },
      { requestId: 'req-123', principal: principal([ROLES.READ, ROLES.REVEAL]), sessionId },
    );
    return { service, token: res.results[0]?.revealToken ?? '' };
  }

  it('returns the unmasked phones and emails for a valid token (Req 14.7)', async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const { service, token } = await searchThenToken(store, gateway);

    const revealed = await service.reveal(token, ctx(principal([ROLES.READ, ROLES.REVEAL])));
    expect(revealed.requestId).toBe('req-123');
    expect(revealed.phones[0]?.number).toBe('+1 404 555 0101');
    expect(revealed.emails[0]?.address).toBe('alex@example.test');
  });

  it('throws REVEAL_EXPIRED for an unknown token', async () => {
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway);

    await expect(service.reveal('rt_nope', ctx(principal([ROLES.REVEAL])))).rejects.toMatchObject({
      name: 'AppError',
      code: 'REVEAL_EXPIRED',
    });
  });

  it('throws REVEAL_EXPIRED once the token TTL has elapsed', async () => {
    const clock = makeStore();
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const { service, token } = await searchThenToken(clock.store, gateway);

    clock.setNow(clock.now() + 10 * 60 * 1000 + 1); // past the 10-minute TTL
    await expect(service.reveal(token, ctx(principal([ROLES.REVEAL])))).rejects.toMatchObject({
      code: 'REVEAL_EXPIRED',
    });
  });

  it('rejects a token presented from a different session (Req 14.9)', async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const { service, token } = await searchThenToken(store, gateway, 'sess-1');

    const otherSession: SearchContext = {
      requestId: 'req-123',
      principal: principal([ROLES.REVEAL]),
      sessionId: 'sess-2',
    };
    await expect(service.reveal(token, otherSession)).rejects.toMatchObject({
      code: 'REVEAL_EXPIRED',
    });
  });

  it('returns copies so a caller cannot mutate the stored reveal entry', async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const { service, token } = await searchThenToken(store, gateway);

    const first = await service.reveal(token, ctx(principal([ROLES.REVEAL])));
    if (first.phones[0]) first.phones[0].number = 'MUTATED';
    const second = await service.reveal(token, ctx(principal([ROLES.REVEAL])));
    expect(second.phones[0]?.number).toBe('+1 404 555 0101');
  });
});

describe('GuestSearchService — observability (Req 14.10, 22.3, 22.5)', () => {
  const withContacts = guest({
    phones: [{ number: '+1 404 555 0101', profileDefault: true }],
    emails: [{ address: 'alex@example.test', profileDefault: true }],
  });

  function recorders() {
    const events: AuditEvent[] = [];
    const logs: Record<string, unknown>[] = [];
    const audit: AuditLogger = { record: (e) => events.push(e) };
    const logger: ServiceLogger = { info: (obj) => logs.push(obj) };
    return { events, logs, audit, logger };
  }

  it('audits guest.search with principal id, request id, timestamp and count — no PII', async () => {
    const { events, audit } = recorders();
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const service = makeService(gateway, { audit });

    await service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ, ROLES.REVEAL])));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'guest.search',
      principalId: 'dev-user',
      requestId: 'req-123',
      at: 1_234_567,
      resultCount: 1,
    });
    // No contact value, Enterprise ID or name anywhere in the audit payload.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('Rivera');
    expect(serialized).not.toContain('555');
    expect(serialized).not.toContain('E900000001');
  });

  it('logs only criteria field NAMES, never values (Req 22.3)', async () => {
    const { logs, logger } = recorders();
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway, { logger });

    await service.search(
      { lastName: 'Rivera', phone: '+14045550101' },
      ctx(principal([ROLES.READ])),
    );
    const completed = logs.find((l) => l.event === 'guest.search.completed');
    expect(completed?.criteriaFields).toEqual(expect.arrayContaining(['lastName', 'phone']));
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('Rivera');
    expect(serialized).not.toContain('14045550101');
  });

  it('audits guest.reveal with the Enterprise-ID hash and no contact values (Req 14.10)', async () => {
    const { events, audit } = recorders();
    const { store } = makeStore();
    const gateway = new FakeGateway({ results: [withContacts], limit: 50 });
    const service = makeService(gateway, { store, audit });

    const res = await service.search(
      { lastName: 'Rivera' },
      ctx(principal([ROLES.READ, ROLES.REVEAL])),
    );
    const token = res.results[0]?.revealToken ?? '';
    await service.reveal(token, ctx(principal([ROLES.READ, ROLES.REVEAL])));

    const revealEvent = events.find((e) => e.event === 'guest.reveal');
    expect(revealEvent).toBeDefined();
    expect(revealEvent?.enterpriseIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(revealEvent)).not.toContain('555');
  });

  it('defaults the clock to Date.now when none is injected (audit still records)', async () => {
    const events: AuditEvent[] = [];
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const before = Date.now();
    const service = new GuestSearchService({
      gateway,
      schema,
      revealStore: makeStore().store,
      sessionSecret: SESSION_SECRET,
      audit: { record: (e) => events.push(e) },
      // no `now` → defaults to Date.now
    });

    await service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ])));
    expect(events[0]?.at).toBeGreaterThanOrEqual(before);
  });

  it('counts a rejected reveal via metrics without throwing details', async () => {
    const attempts: { ok: boolean }[] = [];
    const metrics: ServiceMetrics = {
      searchCompleted: () => undefined,
      revealAttempted: (a) => attempts.push(a),
    };
    const gateway = new FakeGateway({ results: [], limit: 50 });
    const service = makeService(gateway, { metrics });

    await expect(service.reveal('rt_nope', ctx(principal([ROLES.REVEAL])))).rejects.toMatchObject({
      code: 'REVEAL_EXPIRED',
    });
    expect(attempts).toEqual([{ ok: false }]);
  });
});

// -----------------------------------------------------------------------------------------
// No-raw-PII-leak at the service seam (task 8.7; Req 14.1-14.3, 14.7; design.md P5 preview).
//
// This is the core Req 14 guarantee asserted at the GuestSearchService boundary: the raw,
// unmasked phone/email a gateway returns must NEVER appear in the serialized
// GuestSearchResponse. They live only behind the reveal token, released solely through
// reveal(). Existing tests assert the MASKED forms are PRESENT; these assert the RAW forms
// are ABSENT from the whole serialized response and PRESENT only in the RevealResponse.
//
// The full-stack, log-destination leak test (and property P5 over the service response) is
// task 10.3; this seam test is the unit-level counterpart that does not need the HTTP layer.
// -----------------------------------------------------------------------------------------
describe('GuestSearchService — no raw PII in the serialized response (Req 14)', () => {
  // Distinctive synthetic markers chosen so that masking provably removes them:
  //  - the phone's contiguous raw digit run is 11 digits; masking keeps only the last 4, so
  //    the 11-digit marker cannot survive in any form.
  //  - the email local part is a unique token; masking reveals only its first code point, so
  //    the remaining local marker cannot survive. (The DOMAIN is preserved by design — Req
  //    14.2 requires the full domain — so the marker lives strictly in the local part.)
  const RAW_PHONE = '+1 404 555 0177';
  const RAW_PHONE_DIGITS = '14045550177'; // contiguous marker, 11 digits
  const RAW_EMAIL_LOCAL = 'zqxrawlocalmarker';
  const RAW_EMAIL = `${RAW_EMAIL_LOCAL}@masked-domain.test`;

  const markedGuest = guest({
    phones: [
      { number: RAW_PHONE, type: 'M', profileDefault: true },
      { number: '+1 404 555 0288', type: 'H', profileDefault: false },
    ],
    emails: [{ address: RAW_EMAIL, profileDefault: true }],
  });

  it('a REVEAL principal gets masked contacts in the response; the raw markers are absent', async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway({ results: [markedGuest], limit: 50 });
    const service = makeService(gateway, { store });

    const res = await service.search(
      { lastName: 'Rivera' },
      ctx(principal([ROLES.READ, ROLES.REVEAL])),
    );

    // Scan the ENTIRE serialized response (summaries, primaries, every nested collection).
    const serialized = JSON.stringify(res);

    // The raw phone digits never appear — not whole, and not even the body before the last 4.
    expect(serialized).not.toContain(RAW_PHONE_DIGITS);
    expect(serialized).not.toContain('5550177');
    expect(serialized).not.toContain('5550288');
    // The raw email local-part marker never appears.
    expect(serialized).not.toContain(RAW_EMAIL_LOCAL);
    expect(serialized).not.toContain('qxrawlocalmarker');

    // The MASKED forms are what the response carries (sanity: the markers were present and
    // were transformed, not merely dropped).
    expect(serialized).toContain('•••• 0177');
    expect(serialized).toContain('•••• 0288');
    expect(serialized).toContain('z•••@masked-domain.test');

    // A reveal token is present for the REVEAL principal; it is opaque (no PII encoded).
    const token = res.results[0]?.revealToken;
    expect(token).toBeDefined();
    expect(token).not.toContain(RAW_PHONE_DIGITS);
    expect(token).not.toContain(RAW_EMAIL_LOCAL);
  });

  it('a READ-only principal gets no revealToken and no raw markers in the response', async () => {
    const gateway = new FakeGateway({ results: [markedGuest], limit: 50 });
    const service = makeService(gateway);

    const res = await service.search({ lastName: 'Rivera' }, ctx(principal([ROLES.READ])));
    const serialized = JSON.stringify(res);

    // Read-only: no token at all, so nothing to enumerate or reveal (Req 14.5).
    expect(res.results[0]?.revealToken).toBeUndefined();
    expect(serialized).not.toContain('revealToken');
    // Still masked; raw markers still absent.
    expect(serialized).not.toContain(RAW_PHONE_DIGITS);
    expect(serialized).not.toContain(RAW_EMAIL_LOCAL);
    expect(serialized).toContain('•••• 0177');
  });

  it('the raw markers reappear ONLY in the RevealResponse, after the token is exchanged', async () => {
    const { store } = makeStore();
    const gateway = new FakeGateway({ results: [markedGuest], limit: 50 });
    const service = makeService(gateway, { store });

    const search = await service.search(
      { lastName: 'Rivera' },
      ctx(principal([ROLES.READ, ROLES.REVEAL])),
    );
    const token = search.results[0]?.revealToken ?? '';

    const revealed = await service.reveal(token, ctx(principal([ROLES.READ, ROLES.REVEAL])));
    const revealedSerialized = JSON.stringify(revealed);

    // The reveal response is where — and the only place where — the raw values surface.
    expect(revealed.phones.map((p) => p.number)).toEqual([RAW_PHONE, '+1 404 555 0288']);
    expect(revealed.emails.map((e) => e.address)).toEqual([RAW_EMAIL]);
    // The full raw phone (including the body masking would have dropped) is present verbatim.
    expect(revealedSerialized).toContain(RAW_PHONE);
    expect(revealedSerialized).toContain(RAW_EMAIL_LOCAL);
  });
});
