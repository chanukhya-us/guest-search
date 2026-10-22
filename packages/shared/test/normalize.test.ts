// Focused unit tests for task 2.1. The full schema and property suite is task 2.4.
import { describe, expect, it } from 'vitest';
import {
  CRITERIA_FIELDS,
  defaultLimits,
  hasControlChars,
  normalizeText,
} from '@ihg-guest-search/shared';

describe('normalizeText (Req 4.2)', () => {
  it('trims and collapses internal whitespace runs to one space', () => {
    expect(normalizeText('  Jane   Doe  ')).toBe('Jane Doe');
  });

  it('collapses non-ASCII whitespace (NBSP, ideographic space) that is not Cc/Cf', () => {
    expect(normalizeText('\u00a0Jane\u3000\u2003Doe\u00a0')).toBe('Jane Doe');
  });

  it('applies NFC', () => {
    // "e" + COMBINING ACUTE ACCENT → precomposed "é"
    expect(normalizeText('Rene\u0301')).toBe('Ren\u00e9');
  });

  it('keeps letters and marks from any script and does not change case', () => {
    expect(normalizeText('देवनागरी')).toBe('देवनागरी');
    expect(normalizeText('山田 太郎')).toBe('山田 太郎');
    expect(normalizeText('mcDONALD')).toBe('mcDONALD');
  });

  it('turns empty or whitespace-only input into undefined', () => {
    expect(normalizeText('')).toBeUndefined();
    expect(normalizeText('   \u00a0 ')).toBeUndefined();
  });

  it('passes non-strings through unchanged so Zod reports a type error', () => {
    const obj = { a: 1 };
    expect(normalizeText(42)).toBe(42);
    expect(normalizeText(null)).toBeNull();
    expect(normalizeText(undefined)).toBeUndefined();
    expect(normalizeText(obj)).toBe(obj);
  });

  it('does not collapse or trim Cc/Cf characters, so they can be rejected afterwards', () => {
    expect(normalizeText('John\tSmith')).toBe('John\tSmith');
    expect(normalizeText('Smith\n')).toBe('Smith\n');
    expect(normalizeText('\r\n')).toBe('\r\n');
    expect(normalizeText('\ufeffJane')).toBe('\ufeffJane');
    expect(normalizeText('  a \t b  ')).toBe('a \t b');
  });
});

describe('hasControlChars (Req 4.3)', () => {
  it.each([
    ['TAB', 'a\tb'],
    ['LF', 'a\nb'],
    ['NUL', 'a\u0000b'],
    ['DEL', 'a\u007fb'],
    ['C1 NEL', 'a\u0085b'],
    ['ZERO WIDTH SPACE (Cf)', 'a\u200bb'],
    ['RTL OVERRIDE (Cf)', 'a\u202eb'],
    ['BOM (Cf)', '\ufeffa'],
  ])('detects %s', (_name, s) => {
    expect(hasControlChars(s)).toBe(true);
  });

  it('accepts letters, combining marks and plain spaces', () => {
    expect(hasControlChars('Jane Doe')).toBe(false);
    expect(hasControlChars('Rene\u0301 देवनागरी 山田')).toBe(false);
  });

  it('gives the same answer on repeated calls (no regex lastIndex state)', () => {
    expect(hasControlChars('a\tb')).toBe(true);
    expect(hasControlChars('a\tb')).toBe(true);
  });

  it('flags every Cc/Cf that survives normalization (normalize, then reject)', () => {
    const n = normalizeText(' John\tSmith ');
    expect(typeof n === 'string' && hasControlChars(n)).toBe(true);
  });
});

describe('criteria constants (Req 3.2, 4.12)', () => {
  it('lists the 12 fields in UI order', () => {
    expect(CRITERIA_FIELDS).toEqual([
      'firstName',
      'lastName',
      'email',
      'phone',
      'loyaltyMemberId',
      'memberType',
      'country',
      'stateOrRegion',
      'addressLine1',
      'addressLine2',
      'city',
      'postalCode',
    ]);
  });

  it('defines a positive integer limit for exactly the criteria fields', () => {
    expect(Object.keys(defaultLimits).sort()).toEqual([...CRITERIA_FIELDS].sort());
    for (const f of CRITERIA_FIELDS) expect(Number.isInteger(defaultLimits[f])).toBe(true);
    for (const f of CRITERIA_FIELDS) expect(defaultLimits[f]).toBeGreaterThan(0);
    expect(defaultLimits.email).toBe(254);
    expect(Object.isFrozen(defaultLimits)).toBe(true);
  });
});
