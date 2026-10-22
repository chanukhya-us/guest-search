// Unit tests for the results-table pure helpers (task 12.5): score banding, display
// name, empty-value rendering and the sort comparators. These are value-level tests that
// pin the exact band thresholds (Req 15.6) and the "undefined last" ordering (Req 15.5).
import type { GuestSearchResult } from '@ihg-guest-search/shared';
import { describe, expect, it } from 'vitest';

import { EMPTY_INDICATOR, guestDisplayName, orEmpty, scoreBand } from '../../src/lib/format';
import { scoreCompare, textCompare } from '../../src/lib/sort';

const BANDS = { high: 90, medium: 70 };

describe('scoreBand (Req 15.6)', () => {
  it('maps scores to bands at the configured thresholds (inclusive lower bound)', () => {
    expect(scoreBand(95, BANDS)).toBe('high');
    expect(scoreBand(90, BANDS)).toBe('high'); // boundary
    expect(scoreBand(89, BANDS)).toBe('medium');
    expect(scoreBand(70, BANDS)).toBe('medium'); // boundary
    expect(scoreBand(69, BANDS)).toBe('low');
    expect(scoreBand(0, BANDS)).toBe('low');
  });

  it('honours custom thresholds', () => {
    expect(scoreBand(60, { high: 80, medium: 50 })).toBe('medium');
    expect(scoreBand(80, { high: 80, medium: 50 })).toBe('high');
  });

  it('returns undefined for a missing or non-numeric score (Req 12.8)', () => {
    expect(scoreBand(undefined, BANDS)).toBeUndefined();
    expect(scoreBand(Number.NaN, BANDS)).toBeUndefined();
  });
});

describe('guestDisplayName', () => {
  function g(partial: Partial<GuestSearchResult>): GuestSearchResult {
    return {
      enterpriseId: '900000001',
      addresses: [],
      phones: [],
      emails: [],
      memberships: [],
      ...partial,
    };
  }
  it('joins first and last name', () => {
    expect(guestDisplayName(g({ firstName: 'Alex', lastName: 'Testperson' }))).toBe(
      'Alex Testperson',
    );
  });
  it('uses whatever name parts are present', () => {
    expect(guestDisplayName(g({ lastName: 'Testperson' }))).toBe('Testperson');
  });
  it('falls back to the Enterprise ID when no name is present', () => {
    expect(guestDisplayName(g({}))).toBe('guest 900000001');
  });
});

describe('orEmpty', () => {
  it('returns the value when present', () => {
    expect(orEmpty('Atlanta')).toBe('Atlanta');
  });
  it('returns the empty indicator for empty/null/undefined', () => {
    expect(orEmpty('')).toBe(EMPTY_INDICATOR);
    expect(orEmpty(null)).toBe(EMPTY_INDICATOR);
    expect(orEmpty(undefined)).toBe(EMPTY_INDICATOR);
  });
});

describe('scoreCompare (Req 15.5)', () => {
  it('orders numbers ascending', () => {
    expect(scoreCompare(1, 2)).toBeLessThan(0);
    expect(scoreCompare(2, 1)).toBeGreaterThan(0);
    expect(scoreCompare(2, 2)).toBe(0);
  });
  it('places undefined/NaN after every number', () => {
    expect(scoreCompare(undefined, 5)).toBeGreaterThan(0);
    expect(scoreCompare(5, undefined)).toBeLessThan(0);
    expect(scoreCompare(Number.NaN, 5)).toBeGreaterThan(0);
    expect(scoreCompare(undefined, undefined)).toBe(0);
  });
});

describe('textCompare (Req 15.7)', () => {
  it('compares case-insensitively with locale rules', () => {
    expect(textCompare('alpha', 'Beta')).toBeLessThan(0);
    expect(textCompare('Beta', 'alpha')).toBeGreaterThan(0);
  });
  it('places empty/undefined last', () => {
    expect(textCompare(undefined, 'x')).toBeGreaterThan(0);
    expect(textCompare('x', '')).toBeLessThan(0);
    expect(textCompare(undefined, undefined)).toBe(0);
  });
});
