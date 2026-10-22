// Unit tests for the criteria schema factory (tasks 2.2 and 2.4, Req 4).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CRITERIA_FIELDS,
  createCriteriaSchema,
  defaultSchemaConfig,
  isNoCriteriaError,
  MESSAGES,
  NO_CRITERIA_MESSAGE,
  type CriteriaField,
  type GuestSearchInput,
} from '@ihg-guest-search/shared';

const schema = createCriteriaSchema(defaultSchemaConfig);

function issuesFor(input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error('expected failure');
  return r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

describe('installed Zod', () => {
  it('exports z.regexes.html5Email', () => {
    expect(z.regexes.html5Email).toBeInstanceOf(RegExp);
  });
});

describe('root "at least one" rule', () => {
  it.each<[string, unknown]>([
    ['empty object', {}],
    ['whitespace-only values', { firstName: '   ', email: '\u00a0', loyaltyMemberId: ' ' }],
  ])('reports only the root issue for %s', (_, input) => {
    const r = schema.safeParse(input);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toHaveLength(1);
    expect(r.error.issues[0]).toMatchObject({ path: [], message: NO_CRITERIA_MESSAGE });
    expect(isNoCriteriaError(r.error)).toBe(true);
  });

  it('is not reported alongside field errors or unknown keys', () => {
    for (const input of [{ email: 'nope' }, { extra: 'x' }]) {
      const r = schema.safeParse(input);
      expect(r.success).toBe(false);
      if (r.success) continue;
      expect(r.error.issues.some((i) => i.message === NO_CRITERIA_MESSAGE)).toBe(false);
      expect(isNoCriteriaError(r.error)).toBe(false);
    }
  });
});

describe('strict object', () => {
  it('rejects unknown keys', () => {
    const r = schema.safeParse({ lastName: 'Smith', ccNumber: '4111' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('rejects non-string values', () => {
    expect(issuesFor({ lastName: 42 })).toEqual([{ path: 'lastName', message: MESSAGES.notText }]);
  });
});

describe('text fields', () => {
  it('normalizes but does not change case or content (Req 4.11)', () => {
    const input: GuestSearchInput = {
      firstName: '  mARY   anne ',
      lastName: 'Cafe\u0301', // decomposed é → NFC
      email: 'First.Last+tag@Example.TEST',
      phone: '+1 (404) 555-0101',
      addressLine1: '1  Main   St',
    };
    expect(schema.parse(input)).toEqual({
      firstName: 'mARY anne',
      lastName: 'Caf\u00e9',
      email: 'First.Last+tag@Example.TEST',
      phone: '+1 (404) 555-0101',
      addressLine1: '1 Main St',
    });
  });

  it('accepts any script and combining marks (Req 4.3)', () => {
    for (const name of ['देवनागरी', '山田', 'Zoë', 'Ngũgĩ']) {
      expect(schema.safeParse({ lastName: name }).success).toBe(true);
    }
  });

  it.each(['John\tSmith', 'Smith\n', 'Smi\u200bth', 'A\u0000'])(
    'rejects control/format chars in %j',
    (v) => {
      expect(issuesFor({ lastName: v })).toEqual([
        { path: 'lastName', message: MESSAGES.controlChars },
      ]);
    },
  );

  it('enforces the configured max length', () => {
    const max = defaultSchemaConfig.limits.firstName;
    expect(schema.safeParse({ firstName: 'a'.repeat(max) }).success).toBe(true);
    expect(issuesFor({ firstName: 'a'.repeat(max + 1) })).toEqual([
      { path: 'firstName', message: MESSAGES.tooLong(max) },
    ]);
  });

  it('keeps addressLine2 in the schema', () => {
    expect(schema.parse({ addressLine2: 'Suite 5' })).toEqual({ addressLine2: 'Suite 5' });
  });
});

describe('email', () => {
  it.each(['a@b', "o'neil@example.test", 'x@sub.example.test'])('accepts %j', (v) => {
    expect(schema.safeParse({ email: v }).success).toBe(true);
  });

  it.each(['plain', 'a@', '@b.test', 'a b@c.test', `${'a'.repeat(250)}@b.test`, 'a\t@b.test'])(
    'rejects %j with the email message',
    (v) => {
      expect(issuesFor({ email: v })).toEqual([{ path: 'email', message: MESSAGES.email }]);
    },
  );
});

describe('country', () => {
  it('accepts alpha-2 in either case and outputs uppercase', () => {
    expect(schema.parse({ country: 'GB' })).toEqual({ country: 'GB' });
    expect(schema.parse({ country: 'us' })).toEqual({ country: 'US' });
  });

  it.each(['ZZ', 'USA', '840', 'U', 'ß', 'ıN', '1A'])('rejects %j', (v) => {
    expect(issuesFor({ country: v })).toEqual([{ path: 'country', message: MESSAGES.country }]);
  });
});

describe('loyalty member ID', () => {
  it('strips spaces and hyphens before matching ^\\d{9}$', () => {
    expect(schema.parse({ loyaltyMemberId: ' 900-000 001 ' })).toEqual({
      loyaltyMemberId: '900000001',
    });
  });

  it.each(['90000001', '9000000011', '90000000A', '---'])('rejects %j', (v) => {
    expect(issuesFor({ loyaltyMemberId: v })).toEqual([
      { path: 'loyaltyMemberId', message: MESSAGES.memberId },
    ]);
  });

  it('uses the configured pattern', () => {
    const custom = createCriteriaSchema({
      ...defaultSchemaConfig,
      memberIdPattern: /^[A-Z]\d{3}$/g,
    });
    expect(custom.parse({ loyaltyMemberId: 'A-123' })).toEqual({ loyaltyMemberId: 'A123' });
    // Repeated parses must not depend on a global regex's lastIndex.
    expect(custom.parse({ loyaltyMemberId: 'A-123' })).toEqual({ loyaltyMemberId: 'A123' });
  });
});

describe('member type', () => {
  it('accepts configured codes only', () => {
    expect(schema.parse({ memberType: 'PLACEHOLDER' })).toEqual({ memberType: 'PLACEHOLDER' });
    expect(issuesFor({ memberType: 'GOLD' })).toEqual([
      { path: 'memberType', message: MESSAGES.memberType },
    ]);
    const custom = createCriteriaSchema({
      ...defaultSchemaConfig,
      memberTypes: [{ code: 'GOLD', label: 'Gold' }],
    });
    expect(custom.parse({ memberType: 'GOLD' })).toEqual({ memberType: 'GOLD' });
  });
});

describe('phone (format-only)', () => {
  it('accepts any formatting within the limit and rejects control chars', () => {
    expect(schema.safeParse({ phone: '404.555.0101 ext 2' }).success).toBe(true);
    expect(issuesFor({ phone: '404\n5550101' })).toEqual([
      { path: 'phone', message: MESSAGES.controlChars },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 2.4: full unit suite (Req 4.1–4.13).
// ---------------------------------------------------------------------------

describe('root rule: blank-only input (Req 4.2, 4.4, 4.5)', () => {
  it('treats every field supplied as whitespace-only as "no criteria"', () => {
    const blanks = [' ', '\u00a0', '\u3000', '  \u2003 ', '\u2028'];
    const input = Object.fromEntries(CRITERIA_FIELDS.map((f, i) => [f, blanks[i % blanks.length]]));
    const r = schema.safeParse(input);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toEqual([
      expect.objectContaining({ path: [], message: NO_CRITERIA_MESSAGE }),
    ]);
    expect(isNoCriteriaError(r.error)).toBe(true);
  });

  it('treats explicit undefined values and empty strings as not supplied', () => {
    const r = schema.safeParse({ firstName: undefined, email: '', country: '' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(isNoCriteriaError(r.error)).toBe(true);
  });

  it('does not treat a TAB-only value as blank: it is a control-character error', () => {
    expect(issuesFor({ firstName: '\t' })).toEqual([
      { path: 'firstName', message: MESSAGES.controlChars },
    ]);
  });

  it('drops blank fields from the output when another field is supplied', () => {
    expect(schema.parse({ firstName: '  ', lastName: 'Smith', city: '\u00a0' })).toEqual({
      lastName: 'Smith',
    });
  });
});

describe('free-text fields: valid and invalid examples (Req 4.2, 4.3, 4.12)', () => {
  const plainFields = [
    ['firstName', 'Mary-Jane'],
    ['lastName', "O'Brien"],
    ['phone', '+44 20 7946 0000'],
    ['stateOrRegion', 'Île-de-France'],
    ['addressLine1', 'Flat 2, 10 Downing St.'],
    ['addressLine2', 'c/o Reception #3'],
    ['city', 'São Paulo'],
    ['postalCode', 'SW1A 1AA'],
  ] as const satisfies readonly (readonly [CriteriaField, string])[];

  describe.each(plainFields)('%s', (f, example) => {
    const max = defaultSchemaConfig.limits[f];

    it('accepts a typical value unchanged', () => {
      expect(schema.parse({ [f]: example })).toEqual({ [f]: example });
    });

    it('accepts exactly the max length and rejects one more', () => {
      expect(schema.safeParse({ [f]: 'x'.repeat(max) }).success).toBe(true);
      expect(issuesFor({ [f]: 'x'.repeat(max + 1) })).toEqual([
        { path: f, message: MESSAGES.tooLong(max) },
      ]);
    });

    it('measures the length after normalization', () => {
      expect(schema.safeParse({ [f]: `   ${'x'.repeat(max)}   ` }).success).toBe(true);
    });

    it('rejects control and format characters', () => {
      expect(issuesFor({ [f]: `${example}\u0007` })).toEqual([
        { path: f, message: MESSAGES.controlChars },
      ]);
    });
  });
});

describe('Unicode names (Req 4.3)', () => {
  it.each([
    ['Devanagari with virama and vowel signs', 'क्षत्रिय'],
    ['Devanagari full name', 'अनन्या शर्मा'],
    ['CJK (Han)', '王小明'],
    ['CJK (Japanese kana + kanji)', 'さとう 太郎'],
    ['CJK (Hangul)', '김민준'],
    ['Arabic', 'محمد'],
    ['precomposed Latin diacritics', 'Zoë Ngũgĩ'],
  ])('accepts %s and returns it unchanged', (_name, v) => {
    expect(schema.parse({ firstName: v, lastName: v })).toEqual({ firstName: v, lastName: v });
  });

  it('accepts decomposed combining marks and returns the NFC form', () => {
    expect(schema.parse({ lastName: 'Ngu\u0303gi\u0303' })).toEqual({
      lastName: 'Ng\u0169g\u0129',
    });
  });

  it('accepts combining marks with no precomposed form', () => {
    // q + COMBINING DOT BELOW + COMBINING ACUTE stays decomposed under NFC.
    const v = 'q\u0323\u0301';
    expect(schema.parse({ firstName: v })).toEqual({ firstName: v.normalize('NFC') });
  });
});

describe('control and format characters (Req 4.3)', () => {
  it.each([
    ['NUL (Cc)', '\u0000'],
    ['ESC (Cc)', '\u001b'],
    ['DEL (Cc)', '\u007f'],
    ['C1 NEL (Cc)', '\u0085'],
    ['CR (Cc)', '\r'],
    ['SOFT HYPHEN (Cf)', '\u00ad'],
    ['ZERO WIDTH JOINER (Cf)', '\u200d'],
    ['LEFT-TO-RIGHT MARK (Cf)', '\u200e'],
    ['RIGHT-TO-LEFT OVERRIDE (Cf)', '\u202e'],
    ['FIRST STRONG ISOLATE (Cf)', '\u2068'],
    ['BOM (Cf)', '\ufeff'],
  ])('rejects %s in any free-text field, even at the edges', (_name, c) => {
    for (const v of [`Ja${c}ne`, `${c}Jane`, `Jane${c}`]) {
      expect(issuesFor({ firstName: v, city: v })).toEqual([
        { path: 'firstName', message: MESSAGES.controlChars },
        { path: 'city', message: MESSAGES.controlChars },
      ]);
    }
  });

  it('rejects control characters in email, member ID, member type and country', () => {
    expect(issuesFor({ email: 'a@b.test\u200b' })).toEqual([
      { path: 'email', message: MESSAGES.email },
    ]);
    expect(issuesFor({ loyaltyMemberId: '900000001\u0000' })).toEqual([
      { path: 'loyaltyMemberId', message: MESSAGES.controlChars },
    ]);
    expect(issuesFor({ memberType: 'PLACEHOLDER\n' })).toEqual([
      { path: 'memberType', message: MESSAGES.controlChars },
    ]);
    expect(issuesFor({ country: 'G\u200bB' })).toEqual([
      { path: 'country', message: MESSAGES.country },
    ]);
  });
});

describe('unknown keys (Req 4.13)', () => {
  it('reports every unknown key, even next to valid criteria', () => {
    const r = schema.safeParse({ lastName: 'Smith', ccNumber: '4111', enterpriseId: '1' });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toHaveLength(1);
    expect(r.error.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['ccNumber', 'enterpriseId'],
    });
    expect(isNoCriteriaError(r.error)).toBe(false);
  });

  it('rejects an own "__proto__" key from parsed JSON', () => {
    const r = schema.safeParse(JSON.parse('{"lastName":"Smith","__proto__":{"x":1}}'));
    expect(r.success).toBe(false);
  });

  it('rejects field names that differ only in case', () => {
    expect(schema.safeParse({ LastName: 'Smith' }).success).toBe(false);
  });
});

describe('email boundaries (Req 4.6)', () => {
  // 64 + 1 + 63 + 1 + 63 + 1 + 61 = 254
  const at254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;

  it('accepts a 254-character address and rejects 255', () => {
    expect(at254).toHaveLength(254);
    expect(schema.safeParse({ email: at254 }).success).toBe(true);
    expect(issuesFor({ email: `${at254}d` })).toEqual([{ path: 'email', message: MESSAGES.email }]);
  });

  it('caps at 254 even when the limits table allows more', () => {
    const custom = createCriteriaSchema({
      ...defaultSchemaConfig,
      limits: { ...defaultSchemaConfig.limits, email: 1000 },
    });
    expect(custom.safeParse({ email: `${at254}d` }).success).toBe(false);
  });
});

describe('loyalty member ID separators (Req 4.8)', () => {
  it.each([
    ['spaces', '900 000 001'],
    ['hyphens', '900-000-001'],
    ['mixed and repeated', ' 9-0 0--000 0 01 '],
    ['NBSP around the value (normalized first)', '\u00a0900000001\u00a0'],
  ])('normalizes %s to digits only', (_name, v) => {
    expect(schema.parse({ loyaltyMemberId: v })).toEqual({ loyaltyMemberId: '900000001' });
  });

  it.each(['900.000.001', '900_000_001', '900/000/001', '９００００００01'])(
    'does not strip other separators or accept non-ASCII digits: %j',
    (v) => {
      expect(issuesFor({ loyaltyMemberId: v })).toEqual([
        { path: 'loyaltyMemberId', message: MESSAGES.memberId },
      ]);
    },
  );
});

describe('no case or format changes (Req 4.11)', () => {
  it('keeps the case of names and emails exactly', () => {
    const input = { firstName: 'JEAN-luc', lastName: 'van der BERG', email: 'A.B@EXAMPLE.TEST' };
    expect(schema.parse(input)).toEqual(input);
  });

  it.each(['+1 404 555 0101', '(404) 555-0101', '404.555.0101', '+14045550101', '0044-20-7946'])(
    'keeps phone formatting %j',
    (v) => {
      expect(schema.parse({ phone: v })).toEqual({ phone: v });
    },
  );

  it('keeps address punctuation and case', () => {
    const input = { addressLine1: '221B Baker St.', city: 'ST. ALBANS', postalCode: 'al1 1aa' };
    expect(schema.parse(input)).toEqual(input);
  });
});
