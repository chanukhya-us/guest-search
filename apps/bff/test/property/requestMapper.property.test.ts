// Property tests for the SOAP request mapper (task 4.4, Req 9.15, 25.4): P1 request
// round-trip and P2 blank omission (design.md "Correctness Properties").
//
// Queries are produced the way the route produces them: raw candidate inputs go through
// `createCriteriaSchema(cfg).safeParse`, and the mapper receives the schema OUTPUT. Each raw
// field arbitrary is pre-filtered against that field's own rule, so the whole-object parse
// only fails when every field is blank (NO_CRITERIA), which keeps the rejection rate low.
import { fc, test } from '@fast-check/vitest';
import {
  createCriteriaSchema,
  defaultSchemaConfig,
  isNoCriteriaError,
  type CriteriaField,
  type GuestSearchInput,
  type GuestSearchQuery,
  type SchemaConfig,
} from '@ihg-guest-search/shared';
import { describe, expect } from 'vitest';
import { EL, ORDER, type El } from '../../src/soap/contract.js';
import type { HeaderContext } from '../../src/soap/headerBuilder.js';
import {
  buildSearchGuestRequest,
  hasXmlIllegalChar,
  type MapperOptions,
} from '../../src/soap/requestMapper.js';
import { REFERENCE_HEADER, REFERENCE_OPTIONS } from '../helpers/requestFixtures.js';
import {
  attr,
  childElements,
  descendants,
  find,
  findAll,
  parseXml,
  readMappedRequest,
  type MappedRequest,
} from '../helpers/xmlRead.js';

const NUM_RUNS = 300;

/** Default config plus a test-only code with XML specials, so attribute escaping is exercised. */
const CFG: SchemaConfig = {
  ...defaultSchemaConfig,
  memberTypes: [...defaultSchemaConfig.memberTypes, { code: `G&<"'>]]`, label: 'Specials' }],
};
const schema = createCriteriaSchema(CFG);

type Features = MapperOptions['features'];
type MappedField = keyof MappedRequest;
type FlaggedField = keyof Features;

const MAPPED_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'stateOrRegion',
  'country',
  'addressLine1',
  'city',
  'postalCode',
  'memberType',
  'loyaltyMemberId',
] as const satisfies readonly MappedField[];

const isFlagged = (f: MappedField): f is FlaggedField =>
  f === 'addressLine1' || f === 'city' || f === 'postalCode';

/** The value the mapper should emit for `f`: the normalized value, or nothing when flagged off. */
const expected = (q: GuestSearchQuery, f: MappedField, features: Features): string | undefined =>
  isFlagged(f) && !features[f] ? undefined : q[f];

// ---------------------------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------------------------

/**
 * Characters that stress escaping and normalization: XML specials, CDATA terminator pieces,
 * safe whitespace (collapsed/trimmed), combining marks, RTL and CJK letters, and non-BMP
 * characters (surrogate pairs).
 */
const tricky = fc.constantFrom(
  '&',
  '<',
  '>',
  '"',
  "'",
  ']]>',
  '&amp;',
  '<!--',
  ' ',
  '\u00a0',
  '\u3000',
  '\u2028',
  'a',
  'Z',
  '\u00e9',
  'e\u0301',
  '\u0915\u094d',
  '\u05d0',
  '\u0627',
  '\u4e2d',
  '\ufffd',
  '\u{1d400}',
  '\u{1f600}',
  '\u{20000}',
);

const rawText = fc.oneof(
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.string({ unit: 'grapheme-composite', maxLength: 6 }),
  fc.string({ unit: tricky, maxLength: 12 }),
  fc.constantFrom('', ' ', '\u00a0 \u3000'),
);

/** True when `raw` alone passes `field`'s rule (blank counts as passing: not supplied). */
function fieldAccepts(field: CriteriaField, raw: string): boolean {
  const r = schema.safeParse({ [field]: raw });
  if (r.success) {
    // Values that only the mapper's defensive XML 1.0 check rejects (noncharacters, lone
    // surrogates) are outside P1's domain: the mapper throws INTERNAL_ERROR for them.
    const v = r.data[field];
    return v === undefined || !hasXmlIllegalChar(v);
  }
  return isNoCriteriaError(r.error);
}

const textFor = (field: CriteriaField) => rawText.filter((s) => fieldAccepts(field, s));

const EMAIL_LOCAL = [..."abcXYZ019.!#$%&'*+/=?^_`{|}~-"];
const LABEL = [...'abcxyz019'];
const rawEmail = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(...EMAIL_LOCAL), minLength: 1, maxLength: 20 }),
    fc.array(fc.string({ unit: fc.constantFrom(...LABEL), minLength: 1, maxLength: 10 }), {
      minLength: 1,
      maxLength: 3,
    }),
    fc.constantFrom('', ' ', '  '),
  )
  .map(([local, labels, pad]) => pad + local + '@' + labels.join('.') + pad);

const rawPhone = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('', '+'),
      fc.array(fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: 1, maxLength: 4 }), {
        minLength: 1,
        maxLength: 4,
      }),
      fc.constantFrom(' ', '-', '.'),
    )
    .map(([plus, parts, sep]) => plus + parts.join(sep)),
  textFor('phone'),
);

/** Nine digits with optional space/hyphen separators; the schema strips them. */
const rawMemberId = fc
  .array(fc.tuple(fc.constantFrom(...'0123456789'), fc.constantFrom('', '', ' ', '-')), {
    minLength: 9,
    maxLength: 9,
  })
  .map((pairs) => pairs.map(([d, sep], i) => (i === 8 ? d : d + sep)).join(''));

const COUNTRIES = ['US', 'GB', 'FR', 'DE', 'JP', 'CN', 'IN', 'BR', 'AE', 'ZA', 'AU', 'CA', 'MX'];
const rawCountry = fc
  .tuple(fc.constantFrom(...COUNTRIES), fc.boolean(), fc.constantFrom('', ' '))
  .map(([c, lower, pad]) => pad + (lower ? c.toLowerCase() : c) + pad);

const rawMemberType = fc.constantFrom(...CFG.memberTypes.map((t) => t.code));

/** Field → arbitrary raw input; each field is optional (absent or blank both mean "not supplied"). */
const RAW: Record<CriteriaField, fc.Arbitrary<string>> = {
  firstName: textFor('firstName'),
  lastName: textFor('lastName'),
  email: rawEmail,
  phone: rawPhone,
  loyaltyMemberId: rawMemberId,
  memberType: rawMemberType,
  country: rawCountry,
  stateOrRegion: textFor('stateOrRegion'),
  addressLine1: textFor('addressLine1'),
  addressLine2: textFor('addressLine2'),
  city: textFor('city'),
  postalCode: textFor('postalCode'),
};

/** A valid `GuestSearchQuery`: the schema output for a raw input that parses. */
const validQuery: fc.Arbitrary<GuestSearchQuery> = fc
  .record(RAW, { requiredKeys: [] })
  .map((raw: GuestSearchInput) => schema.safeParse(raw))
  .filter((r) => r.success)
  .map((r) => {
    if (!r.success) throw new Error('unreachable');
    return r.data;
  });

const features: fc.Arbitrary<Features> = fc.record({
  addressLine1: fc.boolean(),
  city: fc.boolean(),
  postalCode: fc.boolean(),
});

const options: fc.Arbitrary<MapperOptions> = fc
  .record({ features, maxResults: fc.integer({ min: 1, max: 500 }) })
  .map((o) => ({ ...REFERENCE_OPTIONS, ...o }));

/**
 * Header text: printable, XML-legal, including XML specials and non-BMP characters. U+2028 is
 * left out: xmlbuilder2 writes it literally (correct for XML 1.0), but the xmldom test reader
 * applies XML 1.1 line-end handling and reads it back as LF. Criteria never contain it
 * (normalizeText collapses it to a space).
 */
const headerText = fc.oneof(
  fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 20 }),
  fc.string({ unit: tricky.filter((c) => c !== '\u2028'), minLength: 1, maxLength: 10 }),
);
const header: fc.Arbitrary<HeaderContext> = fc
  .record({
    channel: headerText,
    subChannels: fc.array(headerText, { maxLength: 3 }),
    environment: headerText,
    serviceUser: headerText,
  })
  .map((h) => ({ ...REFERENCE_HEADER, ...h }));

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const criteriaOf = (xml: string) => {
  const criteria = find(parseXml(xml), [
    EL.envelope,
    EL.body,
    EL.searchGuestRequest,
    EL.searchCriteria,
  ]);
  if (criteria === undefined) throw new Error('searchCriteria not found');
  return criteria;
};

type GroupKey = (typeof ORDER.searchCriteria)[number];

/** Group → its element and the mapped fields it carries. */
const GROUP_FIELDS: Record<GroupKey, { el: El; fields: readonly MappedField[] }> = {
  name: { el: EL.name, fields: ['firstName', 'lastName'] },
  phone: { el: EL.phone, fields: ['phone'] },
  email: { el: EL.email, fields: ['email'] },
  address: {
    el: EL.address,
    fields: ['addressLine1', 'city', 'stateOrRegion', 'postalCode', 'country'],
  },
  membership: { el: EL.membership, fields: ['memberType', 'loyaltyMemberId'] },
};

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe('buildSearchGuestRequest', () => {
  // Feature: ihg-guest-search, Property 1: Request round-trip — For all valid
  // `GuestSearchQuery` q (arbitrary Unicode text without Cc/Cf, valid email/phone/country
  // shapes), parsing `buildSearchGuestRequest(q, h, o)` with the namespace-aware test reader
  // yields, for each supplied mapped field, exactly the normalized value, and for each absent
  // group no element.
  // **Validates: Requirements 9.15, 25.4**
  test.prop([validQuery, options], { numRuns: NUM_RUNS })(
    'P1: every mapped field reads back as its normalized value (flags respected)',
    (q, o) => {
      const xml = buildSearchGuestRequest(q, REFERENCE_HEADER, o);
      const read = readMappedRequest(xml);

      const want = {} as Record<MappedField, string | undefined>;
      for (const f of MAPPED_FIELDS) want[f] = expected(q, f, o.features);
      expect(read).toEqual(want);
      // Address Line 2 has no reader field and must not leak into any other one.
      expect(Object.keys(read)).not.toContain('addressLine2');
    },
  );

  // Feature: ihg-guest-search, Property 1: Request round-trip (header values) — generated
  // header text with XML specials and non-BMP characters reads back unchanged.
  // **Validates: Requirements 9.15, 25.4**
  test.prop([validQuery, header], { numRuns: 100 })('P1: header text round-trips', (q, h) => {
    const doc = parseXml(buildSearchGuestRequest(q, h, REFERENCE_OPTIONS));
    // Header values are attributes (docs/Request.txt), so they are read back with `attr`.
    const one = (e: El, name: string): string | undefined => {
      const found = descendants(doc, e);
      expect(found).toHaveLength(1);
      return attr(found[0], name);
    };
    expect(one(EL.headerChannel, 'name')).toBe(h.channel);
    // Nested subchannels appear in document order, outermost first.
    expect(descendants(doc, EL.headerSubChannel).map((e) => attr(e, 'name'))).toEqual(
      h.subChannels,
    );
    expect(one(EL.headerEnvironment, 'name')).toBe(h.environment);
    expect(one(EL.headerUser, 'id')).toBe(h.serviceUser);
  });

  // Feature: ihg-guest-search, Property 2: Blank omission — For all queries where a group's
  // inputs are undefined, the envelope contains no element with that group's (ns, local).
  // **Validates: Requirements 9.7, 9.8, 9.9, 9.10, 9.11, 25.4**
  test.prop([validQuery, options], { numRuns: NUM_RUNS })(
    'P2: a group element exists iff one of its enabled inputs is supplied',
    (q, o) => {
      const xml = buildSearchGuestRequest(q, REFERENCE_HEADER, o);
      const criteria = criteriaOf(xml);
      const doc = parseXml(xml);

      const isSupplied = (key: GroupKey): boolean =>
        GROUP_FIELDS[key].fields.some((f) => expected(q, f, o.features) !== undefined);
      for (const key of ORDER.searchCriteria) {
        const supplied = isSupplied(key);
        // Searched anywhere in the document, so a misplaced group would also be caught. The
        // email child `address` has the same identity as the address group (initiate:address,
        // as in the sample), so it is counted too when email is supplied.
        const sameIdentity = key === 'address' && isSupplied('email') ? 1 : 0;
        expect(descendants(doc, GROUP_FIELDS[key].el).length, key).toBe(
          (supplied ? 1 : 0) + sameIdentity,
        );
        expect(findAll(criteria, [GROUP_FIELDS[key].el]).length, key).toBe(supplied ? 1 : 0);
      }

      // No element for an absent field: name and address/source carry exactly the supplied
      // children, so nothing exists for Address Line 2 or a disabled/absent field.
      const nameChildren = findAll(criteria, [EL.name]).flatMap(childElements);
      expect(nameChildren).toHaveLength(
        ['firstName', 'lastName'].filter((f) => q[f as MappedField] !== undefined).length,
      );
      const sourceChildren = findAll(criteria, [EL.address, EL.source]).flatMap(childElements);
      expect(sourceChildren).toHaveLength(
        GROUP_FIELDS.address.fields.filter((f) => expected(q, f, o.features) !== undefined).length,
      );
      const FLAGGED: readonly [El, FlaggedField][] = [
        [EL.line1, 'addressLine1'],
        [EL.locality1, 'city'],
        [EL.postalCode, 'postalCode'],
      ];
      for (const [e, f] of FLAGGED) {
        if (expected(q, f, o.features) === undefined) expect(descendants(doc, e)).toHaveLength(0);
      }
      const membership = find(criteria, [EL.membership]);
      expect(membership?.hasAttributeNS(null, 'code') ?? false).toBe(q.memberType !== undefined);
      expect(membership?.hasAttributeNS(null, 'value') ?? false).toBe(
        q.loyaltyMemberId !== undefined,
      );
    },
  );
});
