// Property P8 — Masking (task 8.3 / 8.7, Req 14.1–14.3, 25.4; design.md "Correctness
// Properties"):
//   - For all phone strings with > 4 ASCII digits, maskPhone output ends with the last 4
//     digits and contains no other digit.
//   - For all emails, maskEmail output contains the full domain and at most 1 character of
//     the local part.
// These are the formal guarantees behind the example tests in unit/security/piiMasker.test.ts.
import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';

import { maskEmail, maskPhone } from '../../src/security/piiMasker.js';

/** ASCII-digit count, matching the \D-stripping the masker uses. */
function asciiDigits(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Build a phone-like string from an array of digits and a set of separator insertions, so the
 * ASCII-digit count is controlled directly (smart generator) rather than filtered. Separators
 * are sprinkled between/around the digits without changing the digit sequence.
 */
function phoneFrom(digits: number[], seps: string[]): string {
  const parts: string[] = [];
  digits.forEach((d, i) => {
    parts.push(seps[i] ?? '');
    parts.push(String(d));
  });
  parts.push(seps[digits.length] ?? '');
  return parts.join('');
}

const sepArb = fc.constantFrom('', ' ', '-', '.', '(', ')', '+');
const digitArb = fc.integer({ min: 0, max: 9 });

describe('P8 masking properties', () => {
  // 5–20 digits guarantees the >4 branch; separators vary freely around them.
  const longPhoneArb = fc
    .tuple(fc.array(digitArb, { minLength: 5, maxLength: 20 }), fc.array(sepArb, { maxLength: 21 }))
    .map(([digits, seps]) => ({ raw: phoneFrom(digits, seps), digits: digits.join('') }));

  // 0–4 digits guarantees the <=4 (fully masked) branch.
  const shortPhoneArb = fc
    .tuple(fc.array(digitArb, { maxLength: 4 }), fc.array(sepArb, { maxLength: 5 }))
    .map(([digits, seps]) => phoneFrom(digits, seps));

  test.prop([longPhoneArb])(
    'maskPhone with >4 digits ends with the last 4 and leaks no other digit',
    ({ raw, digits }) => {
      const masked = maskPhone(raw);
      const last4 = digits.slice(-4);

      // Ends with exactly the last four source digits.
      expect(masked.endsWith(last4)).toBe(true);
      // No digit anywhere except those four.
      expect(asciiDigits(masked)).toBe(last4);
    },
  );

  test.prop([shortPhoneArb])('maskPhone with <=4 digits reveals no digits at all', (raw) => {
    expect(asciiDigits(maskPhone(raw))).toBe('');
  });

  // An email-ish string. Locals and domains drawn from unicode strings so the property holds
  // for non-ASCII input too; at least one '@' guarantees a domain to check.
  const emailArb = fc
    .tuple(
      fc.string({ unit: 'grapheme', maxLength: 16 }),
      fc.string({ unit: 'grapheme', minLength: 1, maxLength: 16 }),
    )
    .map(([local, domain]) => `${local}@${domain.replace(/@/g, 'x')}`);

  test.prop([emailArb])(
    'maskEmail contains the full domain and at most 1 local character',
    (email) => {
      const at = email.lastIndexOf('@');
      const domain = email.slice(at + 1);

      const masked = maskEmail(email);

      // Full domain preserved verbatim.
      expect(masked.endsWith(`@${domain}`)).toBe(true);

      // At most one revealed local-part character (everything before the bullets).
      const maskedAt = masked.lastIndexOf('@');
      const maskedLocal = masked.slice(0, maskedAt);
      const revealed = maskedLocal.replace(/•+$/u, '');
      expect(Array.from(revealed).length).toBeLessThanOrEqual(1);
    },
  );

  test.prop([fc.string()])(
    'maskEmail never throws and never returns the raw value unchanged',
    (s) => {
      const masked = maskEmail(s);
      expect(typeof masked).toBe('string');
      // Any non-empty input is altered (the local part or whole value is masked).
      if (s.length > 0) {
        expect(masked).not.toBe(s);
      }
    },
  );
});
