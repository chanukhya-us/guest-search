// Focused unit tests for task 2.3. The full suite (incl. property P7) is task 2.4.
import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  ERROR_CODES,
  NO_CRITERIA_MESSAGE,
  pickPrimary,
  ROLES,
  type ErrorCode,
  type GuestMembership,
  type GuestPhone,
} from '@ihg-guest-search/shared';

describe('pickPrimary (Req 13)', () => {
  const phone = (number: string, profileDefault?: boolean): GuestPhone =>
    profileDefault === undefined ? { number } : { number, profileDefault };

  it('returns the first item with profileDefault=true', () => {
    expect(pickPrimary([phone('1'), phone('2', true), phone('3')])?.number).toBe('2');
  });

  it('returns the first default when several items are default (Req 13.2)', () => {
    expect(pickPrimary([phone('1', false), phone('2', true), phone('3', true)])?.number).toBe('2');
  });

  it('falls back to the first item when none is default (Req 13.1)', () => {
    expect(pickPrimary([phone('1', false), phone('2')])?.number).toBe('1');
  });

  it('returns undefined for an empty collection (Req 13.3)', () => {
    expect(pickPrimary([])).toBeUndefined();
  });

  it('accepts memberships (no profileDefault) and returns the first', () => {
    const memberships: GuestMembership[] = [{ memberId: '111111111' }, { memberId: '222222222' }];
    expect(pickPrimary(memberships)?.memberId).toBe('111111111');
  });
});

describe('ERROR_CATALOG (Req 19.1)', () => {
  const GENERIC = 'Unable to complete the guest search. Please try again.';
  // Copied from the Req 19.1 table. VALIDATION_ERROR is "Field messages" there: the
  // per-field text travels in error.fields, and this is the top-level fallback.
  const expected: Record<ErrorCode, { http: number; message: string }> = {
    NO_CRITERIA: { http: 400, message: 'Please enter at least one search criterion.' },
    VALIDATION_ERROR: {
      http: 400,
      message: 'Please correct the highlighted fields and try again.',
    },
    UNAUTHENTICATED: { http: 401, message: 'Your session has expired. Please sign in again.' },
    FORBIDDEN: { http: 403, message: 'You do not have access to this action.' },
    REVEAL_EXPIRED: { http: 404, message: 'Details expired. Please search again.' },
    RATE_LIMITED: { http: 429, message: 'Too many requests. Please wait a moment and try again.' },
    UPSTREAM_TIMEOUT: {
      http: 504,
      message: 'The guest search service did not respond in time. Please try again.',
    },
    UPSTREAM_UNAVAILABLE: { http: 502, message: GENERIC },
    UPSTREAM_HTTP_ERROR: { http: 502, message: GENERIC },
    UPSTREAM_FAULT: { http: 502, message: GENERIC },
    UPSTREAM_TXN_FAILED: { http: 502, message: GENERIC },
    UPSTREAM_CONTRACT: { http: 502, message: GENERIC },
    UPSTREAM_MALFORMED: { http: 502, message: GENERIC },
    INTERNAL_ERROR: { http: 500, message: GENERIC },
  };

  it('contains exactly the ErrorCode set', () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('maps %s to its status and exact message', (code, entry) => {
    expect(ERROR_CATALOG[code as ErrorCode]).toEqual(entry);
  });

  it('shares the NO_CRITERIA text with the schema root error', () => {
    expect(ERROR_CATALOG.NO_CRITERIA.message).toBe(NO_CRITERIA_MESSAGE);
  });
});

describe('ROLES', () => {
  it('defines the read and reveal role names', () => {
    expect(ROLES).toEqual({ READ: 'GuestSearch.Read', REVEAL: 'GuestSearch.RevealPII' });
  });
});
