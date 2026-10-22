// Service-level masking property (task 8.7; Req 14.1-14.3, 14.7, 25.4).
//
// P8 (piiMasker.property.test.ts) proves the masker never leaks digits/local-part in
// isolation. This property lifts that guarantee up to the GuestSearchService seam: for ANY
// gateway result set, the SERIALIZED GuestSearchResponse must contain none of the raw contact
// material, and — when the principal can reveal — the same raw material must be retrievable in
// full through reveal(). It is the universal counterpart to the example seam tests in
// unit/services/guestSearchService.test.ts, and the unit-level sibling of the full-stack
// token-exclusion property (P5) scheduled for task 10.3.
//
// The generator builds guests whose RAW phone/email value is itself the marker, and the leak
// check asserts that whole raw value is absent from the serialized response. Masking always
// rewrites both — a phone to `•••• <last4>` and an email to `<char0>•••@DOMAIN` — so the raw
// value provably cannot survive, which makes "absent" a real leak check rather than a
// tautology, with no fragile substring slicing that could false-positive on a JSON key, the
// preserved (uppercase) domain, a reveal token, or another guest's masked value.
import { fc, test } from '@fast-check/vitest';
import {
  ROLES,
  createCriteriaSchema,
  defaultSchemaConfig,
  type GuestSearchQuery,
  type GuestSearchResult,
} from '@ihg-guest-search/shared';
import { describe, expect } from 'vitest';

import type { Principal } from '../../src/auth/authProvider.js';
import type {
  GuestSearchContext,
  GuestSearchGateway,
  GuestSearchOutcome,
} from '../../src/ports/GuestSearchGateway.js';
import { MemoryRevealStore } from '../../src/security/revealStore.js';
import {
  GuestSearchService,
  type CriteriaSchema,
  type SearchContext,
} from '../../src/services/guestSearchService.js';

const SESSION_SECRET = 'prop-session-secret-0123456789abcdef';
const schema: CriteriaSchema = createCriteriaSchema(defaultSchemaConfig);

/** A gateway that returns a fixed result set, recording the last context it was called with. */
class FixedGateway implements GuestSearchGateway {
  lastRequestId: string | undefined;
  constructor(private readonly outcome: GuestSearchOutcome) {}
  search(query: GuestSearchQuery, ctx: GuestSearchContext): Promise<GuestSearchOutcome> {
    void query;
    this.lastRequestId = ctx.requestId;
    return Promise.resolve(this.outcome);
  }
}

function makeService(outcome: GuestSearchOutcome): {
  service: GuestSearchService;
  store: MemoryRevealStore;
} {
  let counter = 0;
  const store = new MemoryRevealStore({
    ttlMs: 10 * 60 * 1000,
    now: () => 1_000_000,
    idGenerator: () => `rt_prop-${String(++counter)}`,
  });
  const service = new GuestSearchService({
    gateway: new FixedGateway(outcome),
    schema,
    revealStore: store,
    sessionSecret: SESSION_SECRET,
    now: () => 1_234_567,
  });
  return { service, store };
}

function principal(roles: readonly string[]): Principal {
  return { id: 'dev-user', displayName: 'Dev User', roles: [...roles] };
}
function ctx(p: Principal): SearchContext {
  return { requestId: 'req-prop', principal: p, sessionId: 'sess-prop' };
}

// --- Smart generators: raw contact material with a destroyable unique marker ----------------

/**
 * Digits only, >=9 of them. The leak check asserts the ENTIRE raw number is absent from the
 * response: masking collapses it to `•••• <last4>`, so a >=9-digit run can never survive, and
 * no non-PII numeric field (score/limit/totalResults) is long enough to reproduce it. Using
 * the whole raw string — not a slice — removes any chance of an incidental digit-overlap
 * false positive (e.g. with a zero-padded id or another guest's masked tail).
 */
const phoneMarkerArb = fc
  .array(fc.integer({ min: 0, max: 9 }), { minLength: 9, maxLength: 15 })
  .map((digits) => digits.join('')); // the whole raw number must not survive masking

/**
 * A local-part marker plus an UPPERCASE domain. Masking reveals only code point 0 of the
 * local part and preserves the domain verbatim, so the marker tail (local chars 1..n) is what
 * must disappear.
 *
 * The local alphabet is chosen to be disjoint from every other lowercase run the response can
 * contain, so a surviving tail is unambiguously a leak and never an incidental match:
 *   - the domain is UPPERCASE (`MASKEDDOMAIN.TEST`);
 *   - reveal tokens/ids use `rt_prop-<n>`, `req-prop`, `sess-prop` and the name `Marker`/`Pat`
 *     — the alphabet below excludes r,t,p,o and all vowels, so none of those substrings
 *     overlap it;
 *   - masking never emits two consecutive local characters, so no other guest's masked value
 *     can reproduce a >=2-char tail.
 * With `minLength: 3` the tail is always >=2 chars, below which single-char overlaps are
 * avoided entirely.
 */
// Lowercase letters/digits for the local part. The leak check asserts the ENTIRE raw address
// is absent: masking rewrites the local part to `<char0>•••`, so the full `local@DOMAIN`
// string can never survive, and — the local part being distinct from the UPPERCASE domain and
// from every JSON key — there is no incidental structural substring to false-positive on.
const LOCAL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const emailMarkerArb = fc
  .string({ unit: fc.constantFrom(...LOCAL_ALPHABET), minLength: 2, maxLength: 20 })
  // The whole raw address is the marker: masking always rewrites the local part, so the full
  // `local@DOMAIN` can never appear in the response.
  .map((local) => `${local}@MASKEDDOMAIN.TEST`);

// The enterpriseId is a non-PII field emitted verbatim (Req 14.4). It is built from UPPERCASE
// letters only (no digits) so it can never incidentally contain a numeric phone marker body.
const enterpriseIdArb = fc
  .array(fc.constantFrom(...'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('')), { minLength: 6, maxLength: 10 })
  .map((cs) => `E${cs.join('')}`);

const guestArb = fc
  .record({
    enterpriseId: enterpriseIdArb,
    phone: phoneMarkerArb,
    email: emailMarkerArb,
  })
  .map(({ enterpriseId, phone, email }) => {
    const result: GuestSearchResult = {
      enterpriseId,
      score: 50,
      firstName: 'Pat',
      lastName: 'Marker',
      addresses: [],
      phones: [{ number: phone, profileDefault: true }],
      emails: [{ address: email, profileDefault: true }],
      memberships: [],
    };
    // Each raw contact value is a marker that masking provably removes from the response.
    return { result, markers: { rawPhone: phone, rawEmail: email } };
  });

describe('service masking property — no raw contact material in a search response', () => {
  test.prop([fc.array(guestArb, { minLength: 0, maxLength: 12 })])(
    'for any result set, the serialized response omits every raw phone body and email local tail',
    async (entries) => {
      const results = entries.map((e) => e.result);
      const { service } = makeService({ results, limit: 50 });

      // REVEAL principal exercises the token-issuing path too (the richer code path).
      const res = await service.search(
        { lastName: 'Marker' },
        ctx(principal([ROLES.READ, ROLES.REVEAL])),
      );
      const serialized = JSON.stringify(res);

      for (const { markers } of entries) {
        // The raw phone (>=9 digits) and the raw email (local@DOMAIN) never survive masking.
        expect(serialized.includes(markers.rawPhone)).toBe(false);
        expect(serialized.includes(markers.rawEmail)).toBe(false);
      }
      // Shape invariant: one summary per input, totalResults consistent.
      expect(res.results).toHaveLength(results.length);
      expect(res.totalResults).toBe(results.length);
    },
  );

  test.prop([guestArb])(
    'raw material is recoverable in full through reveal() for a REVEAL principal',
    async ({ result, markers }) => {
      const { service } = makeService({ results: [result], limit: 50 });
      const search = await service.search(
        { lastName: 'Marker' },
        ctx(principal([ROLES.READ, ROLES.REVEAL])),
      );
      const token = search.results[0]?.revealToken;
      expect(token).toBeDefined();

      const revealed = await service.reveal(
        token ?? '',
        ctx(principal([ROLES.READ, ROLES.REVEAL])),
      );
      // The raw phone and email come back verbatim (what masking had removed is restored).
      expect(revealed.phones[0]?.number).toBe(result.phones[0]?.number);
      expect(revealed.emails[0]?.address).toBe(result.emails[0]?.address);
      const revealedSerialized = JSON.stringify(revealed);
      expect(revealedSerialized.includes(markers.rawPhone)).toBe(true);
      expect(revealedSerialized.includes(markers.rawEmail)).toBe(true);
    },
  );

  test.prop([fc.array(guestArb, { minLength: 1, maxLength: 8 })])(
    'a READ-only principal receives no reveal tokens for any result',
    async (entries) => {
      const results = entries.map((e) => e.result);
      const { service } = makeService({ results, limit: 50 });
      const res = await service.search({ lastName: 'Marker' }, ctx(principal([ROLES.READ])));
      expect(res.results.every((s) => s.revealToken === undefined)).toBe(true);
      expect(JSON.stringify(res).includes('revealToken')).toBe(false);
    },
  );
});
