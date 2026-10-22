// Property tests for the shared package (task 2.4): P9 normalization idempotence and
// P7 primary selection (design.md "Correctness Properties").
import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { normalizeText, pickPrimary } from '@ihg-guest-search/shared';

const NUM_RUNS = 500;

/** `\s` minus Cc/Cf: the whitespace normalizeText trims and collapses. */
const SAFE_WS = /[^\S\p{Cc}\p{Cf}]/u;
const SAFE_WS_OTHER_THAN_SPACE = /[^\S\p{Cc}\p{Cf} ]/u;

/**
 * Characters that stress the normalizer: every safe whitespace, Cc/Cf that look like
 * whitespace, combining marks (incl. ones whose NFC order or composition changes),
 * Hangul jamo that compose under NFC, singletons that NFC maps (U+212B ANGSTROM SIGN),
 * and astral letters.
 */
const tricky = fc.constantFrom(
  ' ',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2003',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\t',
  '\n',
  '\r',
  '\u000b',
  '\u000c',
  '\u0085',
  '\u200b',
  '\ufeff',
  'a',
  'e',
  'A',
  '\u0301',
  '\u0323',
  '\u0308',
  '\u1100',
  '\u1161',
  '\u11a8',
  '\u212b',
  '\u0915\u094d',
  '\u{1d400}',
  '\u{20000}',
);

/** Full-Unicode strings: lone surrogates included ('binary'), real graphemes, and the tricky mix. */
const anyString = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'grapheme-composite' }),
  fc.string({ unit: tricky, maxLength: 40 }),
);

describe('normalizeText', () => {
  // Feature: ihg-guest-search, Property 9: normalization idempotence —
  // for all strings s, normalizeText(normalizeText(s)) === normalizeText(s) (Req 4.2).
  test.prop([anyString], { numRuns: NUM_RUNS })('P9: is idempotent', (s) => {
    const once = normalizeText(s);
    expect(normalizeText(once)).toBe(once);
  });

  // Feature: ihg-guest-search, Property 9 (output shape): no leading/trailing safe
  // whitespace, no runs of collapsible whitespace, NFC, and never the empty string.
  test.prop([anyString], { numRuns: NUM_RUNS })(
    'P9: output is trimmed, collapsed, NFC and non-empty',
    (s) => {
      const out = normalizeText(s);
      if (out === undefined) return;
      expect(out).not.toBe('');
      expect(SAFE_WS.test(out.charAt(0))).toBe(false);
      expect(SAFE_WS.test(out.charAt(out.length - 1))).toBe(false);
      expect(SAFE_WS_OTHER_THAN_SPACE.test(out)).toBe(false);
      expect(out).not.toContain('  ');
      expect(out.normalize('NFC')).toBe(out);
    },
  );
});

interface Item {
  id: number;
  profileDefault?: boolean;
}

const item: fc.Arbitrary<Item> = fc.record(
  { id: fc.nat(), profileDefault: fc.boolean() },
  { requiredKeys: ['id'] },
);

describe('pickPrimary', () => {
  // Feature: ihg-guest-search, Property 7: primary selection — for all arrays of items
  // with random profileDefault, pickPrimary returns the first true item if any exists,
  // else items[0], else undefined (Req 13.1–13.3).
  test.prop([fc.array(item, { maxLength: 20 })], { numRuns: NUM_RUNS })(
    'P7: returns the first default, else the first item, else undefined',
    (items) => {
      const firstDefault = items.find((i) => i.profileDefault === true);
      const result = pickPrimary(items);

      expect(result).toBe(firstDefault ?? items[0]);
      expect(result === undefined).toBe(items.length === 0);
      if (result !== undefined) {
        // Same reference as an element of the input, never a copy.
        expect(items.some((i) => i === result)).toBe(true);
        // Nothing before it is a default (first in service order, Req 13.2).
        const idx = items.indexOf(result);
        expect(items.slice(0, idx).some((i) => i.profileDefault === true)).toBe(false);
      }
    },
  );
});
