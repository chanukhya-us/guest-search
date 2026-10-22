// Unit tests for the SOAP request mapper (task 4.3, Req 9.1-9.13, 25.2). Every element is
// located by namespace URI + local name (test/helpers/xmlRead.ts), never by document prefix.
// The round-trip and blank-omission properties are task 4.4; XSD validation is task 4.5,
// which validates the same cases (shared through test/helpers/requestCases.ts).
// Req 9.5 (HTTP 400 for a disabled field) belongs to the route; here the mapper is only
// shown to ignore disabled fields defensively.
import { CRITERIA_FIELDS, type GuestSearchQuery } from '@ihg-guest-search/shared';
import type { Element } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/errors.js';
import { DEFAULTS, EL, NS, ORDER, nsUri, type El } from '../../../src/soap/contract.js';
import type { HeaderContext } from '../../../src/soap/headerBuilder.js';
import {
  buildSearchGuestRequest,
  hasXmlIllegalChar,
  type MapperOptions,
} from '../../../src/soap/requestMapper.js';
import { canonicalize, formatForSnapshot } from '../../helpers/c14n.js';
import {
  COMBINED,
  FIELD_CASES,
  FLAGGED,
  FLAGS_OFF,
  FLAGS_ON,
  GROUP_FIELDS,
  LINE2,
  MAX_RESULTS_CASES,
  omit,
  withOnlyFlag,
  type Field,
} from '../../helpers/requestCases.js';
import {
  REFERENCE_HEADER,
  REFERENCE_REQUESTS,
  buildReference,
  readFixture,
  type ReferenceFixture,
} from '../../helpers/requestFixtures.js';
import {
  attr,
  childElements,
  descendants,
  find,
  findAll,
  parseXml,
  readMappedRequest,
  select,
  text,
} from '../../helpers/xmlRead.js';

const REQUEST_PATH = [EL.envelope, EL.body, EL.searchGuestRequest] as const;
const CRITERIA_PATH = [...REQUEST_PATH, EL.searchCriteria] as const;
const SOURCE_PATH = [...CRITERIA_PATH, EL.address, EL.source] as const;

const build = (q: GuestSearchQuery, o: MapperOptions = FLAGS_OFF): string =>
  buildSearchGuestRequest(q, REFERENCE_HEADER, o);

/** The single element at `path`; fails the test when it is absent or repeated. */
function one(xml: string, path: readonly El[]): Element {
  const found = findAll(parseXml(xml), path);
  expect(found, path.map((e) => e.local).join('/')).toHaveLength(1);
  return found[0] as Element;
}

/** `{namespaceURI}localName` of each element child, in document order. */
const childIds = (el: Element): string[] =>
  childElements(el).map((c) => '{' + String(c.namespaceURI) + '}' + c.localName);
const ids = (els: readonly El[]): string[] =>
  els.map((e) => '{' + String(nsUri(e)) + '}' + e.local);

/** Local names of the criteria groups emitted, in order. */
const groupsOf = (xml: string): string[] =>
  childElements(one(xml, CRITERIA_PATH)).map((c) => String(c.localName));

/** Mapped fields read back from the envelope, absent ones dropped. */
const suppliedOf = (xml: string): Partial<Record<string, string>> =>
  Object.fromEntries(Object.entries(readMappedRequest(xml)).filter(([, v]) => v !== undefined));

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('buildSearchGuestRequest: field mapping (Req 9.3, 9.7-9.11)', () => {
  it.each(FIELD_CASES)('%s: emits exactly the expected groups and values', (_, q, groups) => {
    const xml = build(q, FLAGS_ON);
    expect(groupsOf(xml)).toEqual(groups);
    expect(suppliedOf(xml)).toEqual(q);
  });

  it('writes name children given then surname', () => {
    const name = one(build(COMBINED), [...CRITERIA_PATH, EL.name]);
    expect(childIds(name)).toEqual(ids([EL.given, EL.surname]));
  });

  it('puts the phone number in @number with the contract location and profileDefault', () => {
    const phone = one(build({ phone: COMBINED.phone }), [...CRITERIA_PATH, EL.phone]);
    expect(childElements(phone)).toEqual([]);
    expect(attr(phone, 'number')).toBe(COMBINED.phone);
    expect(attr(phone, 'location')).toBe(DEFAULTS.phoneLocation);
    expect(attr(phone, 'profileDefault')).toBe(DEFAULTS.phoneProfileDefault);
  });

  it('puts the email in email/address with the contract profileDefault', () => {
    const email = one(build({ email: COMBINED.email }), [...CRITERIA_PATH, EL.email]);
    expect(attr(email, 'profileDefault')).toBe(DEFAULTS.emailProfileDefault);
    expect(childIds(email)).toEqual(ids([EL.emailAddress]));
    expect(text(find(email, [EL.emailAddress]))).toBe(COMBINED.email);
  });

  it('puts state and country under address/source with the contract attributes', () => {
    const xml = build({ stateOrRegion: 'GA', country: 'US' });
    const address = one(xml, [...CRITERIA_PATH, EL.address]);
    expect(attr(address, 'locationCode')).toBe(DEFAULTS.addressLocationCode);
    expect(attr(address, 'profileDefault')).toBe(DEFAULTS.addressProfileDefault);
    expect(childIds(address)).toEqual(ids([EL.source]));
    expect(childIds(one(xml, SOURCE_PATH))).toEqual(ids([EL.region1, EL.country]));
  });

  it('puts Member Type in @code and Loyalty Member ID in @value, with no children', () => {
    const m = one(build({ memberType: 'PLACEHOLDER', loyaltyMemberId: '900000013' }), [
      ...CRITERIA_PATH,
      EL.membership,
    ]);
    expect(childElements(m)).toEqual([]);
    expect(attr(m, 'code')).toBe('PLACEHOLDER');
    expect(attr(m, 'value')).toBe('900000013');
  });
});

describe('buildSearchGuestRequest: omission and group isolation (Req 9.6-9.11)', () => {
  it('omits every group when the query is empty', () => {
    const xml = build({}, FLAGS_ON);
    expect(groupsOf(xml)).toEqual([]);
    expect(attr(one(xml, CRITERIA_PATH), 'status')).toBe(DEFAULTS.criteriaStatus);
  });

  it('omits every group when every field is an empty string', () => {
    const blank = Object.fromEntries(CRITERIA_FIELDS.map((f) => [f, ''])) as GuestSearchQuery;
    expect(groupsOf(build(blank, FLAGS_ON))).toEqual([]);
  });

  it.each(ORDER.searchCriteria)(
    'omits %s when only its fields are missing, and ignores fields of other groups',
    (group) => {
      const q = omit(COMBINED, GROUP_FIELDS[group]);
      const xml = build(q, FLAGS_ON);
      expect(groupsOf(xml)).toEqual(ORDER.searchCriteria.filter((g) => g !== group));
      expect(suppliedOf(xml)).toEqual(q);
    },
  );

  it.each(ORDER.searchCriteria)('omits %s when its fields are empty strings', (group) => {
    const blanks = Object.fromEntries(GROUP_FIELDS[group].map((f) => [f, '']));
    const xml = build({ ...COMBINED, ...blanks }, FLAGS_ON);
    expect(groupsOf(xml)).not.toContain(group);
  });

  it.each([FLAGS_OFF, FLAGS_ON])('never emits Address Line 2 (flags %#)', (o) => {
    const alone = build({ addressLine2: LINE2 }, o);
    expect(groupsOf(alone)).toEqual([]);
    expect(alone).not.toContain(LINE2);

    const withAll = build({ ...COMBINED, addressLine2: LINE2 }, o);
    expect(withAll).not.toContain(LINE2);
    const expected = o.features.addressLine1
      ? [EL.line1, EL.locality1, EL.region1, EL.postalCode, EL.country]
      : [EL.region1, EL.country];
    expect(childIds(one(withAll, SOURCE_PATH))).toEqual(ids(expected));
  });
});

describe('buildSearchGuestRequest: address feature flags (Req 9.4, 9.5)', () => {
  const flagged = FLAGGED;

  it('with every flag off, drops line1, locality1 and postalCode', () => {
    const xml = build(COMBINED, FLAGS_OFF);
    expect(childIds(one(xml, SOURCE_PATH))).toEqual(ids([EL.region1, EL.country]));
    for (const [, , e] of flagged) expect(descendants(parseXml(xml), e)).toEqual([]);
  });

  it('with every flag off, flagged fields alone create no address element', () => {
    const q = { addressLine1: '1 Test Street', city: 'Atlanta', postalCode: '30301' };
    expect(groupsOf(build(q, FLAGS_OFF))).toEqual([]);
  });

  it('with every flag on, emits all source children in contract order', () => {
    const xml = build(COMBINED, FLAGS_ON);
    expect(childIds(one(xml, SOURCE_PATH))).toEqual(
      ids([EL.line1, EL.locality1, EL.region1, EL.postalCode, EL.country]),
    );
  });

  it.each(flagged)('flag %s toggles only its own element', (flag, field, e) => {
    const o = withOnlyFlag(flag);
    const xml = build(COMBINED, o);
    const source = one(xml, SOURCE_PATH);
    expect(childIds(source)).toEqual(
      ids(
        [EL.line1, EL.locality1, EL.region1, EL.postalCode, EL.country].filter(
          (x) => x === e || x === EL.region1 || x === EL.country,
        ),
      ),
    );
    expect(text(find(source, [e]))).toBe(COMBINED[field as keyof typeof COMBINED]);

    // The field alone is enough to create the address group when its flag is on.
    const alone = build({ [field]: COMBINED[field as keyof typeof COMBINED] }, o);
    expect(childIds(one(alone, SOURCE_PATH))).toEqual(ids([e]));
  });
});

describe('buildSearchGuestRequest: escaping (Req 9.1, 9.2)', () => {
  // Every XML special character, a CDATA terminator and non-BMP characters (surrogate pairs).
  const SPECIAL = 'A&B <c> "d" \'e\' ]]> 𝄞 😀';

  const textFields: [Field, readonly El[]][] = [
    ['firstName', [EL.name, EL.given]],
    ['lastName', [EL.name, EL.surname]],
    ['email', [EL.email, EL.emailAddress]],
    ['stateOrRegion', [EL.address, EL.source, EL.region1]],
    ['country', [EL.address, EL.source, EL.country]],
    ['addressLine1', [EL.address, EL.source, EL.line1]],
    ['city', [EL.address, EL.source, EL.locality1]],
    ['postalCode', [EL.address, EL.source, EL.postalCode]],
  ];
  const attrFields: [Field, El, string][] = [
    ['phone', EL.phone, 'number'],
    ['memberType', EL.membership, 'code'],
    ['loyaltyMemberId', EL.membership, 'value'],
  ];

  it.each(textFields)('round-trips %s as element text', (field, path) => {
    const xml = build({ [field]: SPECIAL }, FLAGS_ON);
    expect(text(one(xml, [...CRITERIA_PATH, ...path]))).toBe(SPECIAL);
  });

  it.each(attrFields)('round-trips %s as an attribute value', (field, e, name) => {
    const xml = build({ [field]: SPECIAL }, FLAGS_ON);
    expect(attr(one(xml, [...CRITERIA_PATH, e]), name)).toBe(SPECIAL);
  });

  it('escapes markup characters in the serialized text and attributes', () => {
    const xml = build({ lastName: SPECIAL, phone: SPECIAL });
    // No raw markup survives: the only '<' are tag openers and no CDATA terminator remains.
    expect(xml).not.toContain(']]>');
    expect(xml).not.toContain('<c>');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
    expect(xml).toContain('A&amp;B &lt;c&gt;');
    // In a double-quoted attribute the quote must be escaped.
    expect(xml).toMatch(/number="A&amp;B &lt;c&gt; &quot;d&quot; /);
    // Non-BMP characters are written as valid characters (pair intact) and are not illegal.
    expect(hasXmlIllegalChar(xml)).toBe(false);
  });

  it('throws an INTERNAL_ERROR AppError without the value on XML 1.0 illegal characters', () => {
    const fields: Field[] = [...textFields.map(([f]) => f), ...attrFields.map(([f]) => f)];
    for (const field of fields) {
      for (const bad of ['a\u0000', 'a\u000B', 'a\uFFFF', '\uD800x', 'x\uDC00']) {
        let err: unknown;
        try {
          build({ [field]: bad }, FLAGS_ON);
        } catch (e) {
          err = e;
        }
        expect(err, field + ' ' + JSON.stringify(bad)).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INTERNAL_ERROR');
        expect((err as AppError).message).not.toContain(bad);
      }
    }
  });
});

describe('hasXmlIllegalChar', () => {
  it('accepts tab, LF, CR, BMP text and valid surrogate pairs', () => {
    expect(hasXmlIllegalChar('a\tb\nc\rd é 𝄞 \uFFFD')).toBe(false);
  });

  it('rejects each illegal class', () => {
    for (const s of ['\u0008', '\u000C', '\u000E', '\u001F', '\uFFFE', '\uD83D', '\uDD1E']) {
      expect(hasXmlIllegalChar(s), JSON.stringify(s)).toBe(true);
    }
  });
});

describe('buildSearchGuestRequest: namespaces (Req 9.1, 9.13)', () => {
  const xml = build(COMBINED, FLAGS_ON);
  const doc = parseXml(xml);

  it('puts every element in a contract namespace', () => {
    const uris = new Set<string>(Object.values(NS));
    const all = [doc.documentElement as Element, ...descendantsAll(doc.documentElement as Element)];
    for (const el of all) expect(uris.has(String(el.namespaceURI)), el.tagName).toBe(true);
  });

  it('places each request element at its contract namespace URI', () => {
    const paths: (readonly El[])[] = [
      REQUEST_PATH,
      CRITERIA_PATH,
      [...CRITERIA_PATH, EL.name, EL.given],
      [...CRITERIA_PATH, EL.name, EL.surname],
      [...CRITERIA_PATH, EL.phone],
      [...CRITERIA_PATH, EL.email, EL.emailAddress],
      [...SOURCE_PATH, EL.line1],
      [...SOURCE_PATH, EL.locality1],
      [...SOURCE_PATH, EL.region1],
      [...SOURCE_PATH, EL.postalCode],
      [...SOURCE_PATH, EL.country],
      [...CRITERIA_PATH, EL.membership],
      [...REQUEST_PATH, EL.allAttributes],
      [...REQUEST_PATH, EL.allHistory],
      [...REQUEST_PATH, EL.maxResults],
      [EL.envelope, EL.soapHeader, EL.header],
    ];
    for (const path of paths) {
      expect(findAll(doc, path), path.map((e) => e.local).join('/')).toHaveLength(1);
    }
  });

  it('resolves through XPath prefixes that differ from the document prefixes', () => {
    // `svc`, `complex` and `basic` are the NS keys; the document uses ns4, ns3 and ns5.
    expect(xml).not.toContain('<svc:');
    const given = select(
      doc,
      '/soap:Envelope/soap:Body/svc:searchGuestRequest/svc:searchCriteria/complex:name/basic:given',
    );
    expect(given.map((n) => n.textContent)).toEqual([COMBINED.firstName]);
    // Same local name, different namespace: email/address (basic) is not the address group.
    expect(select(doc, '//svc:searchCriteria/complex:email/basic:address')).toHaveLength(1);
    expect(select(doc, '//svc:searchCriteria/complex:address')).toHaveLength(1);
  });
});

/** Every element descendant of `root`, in document order. */
function descendantsAll(root: Element): Element[] {
  return childElements(root).flatMap((c) => [c, ...descendantsAll(c)]);
}

describe('buildSearchGuestRequest: envelope, header and fixed values (Req 9.12, 9.13)', () => {
  it('writes envelope children Header then Body, and the request children in contract order', () => {
    const xml = build(COMBINED);
    expect(childIds(one(xml, [EL.envelope]))).toEqual(ids([EL.soapHeader, EL.body]));
    expect(childIds(one(xml, [EL.envelope, EL.body]))).toEqual(ids([EL.searchGuestRequest]));
    expect(childIds(one(xml, REQUEST_PATH))).toEqual(
      ids(ORDER.searchGuestRequest.map((k) => EL[k])),
    );
    expect(childIds(one(xml, CRITERIA_PATH))).toEqual(ids(ORDER.searchCriteria.map((k) => EL[k])));
  });

  it('embeds every header value from the header context, in contract order', () => {
    const header = one(build(COMBINED), [EL.envelope, EL.soapHeader, EL.header]);
    expect(childIds(header)).toEqual(ids(ORDER.header.map((k) => EL[k])));
    const values: Record<(typeof ORDER.header)[number], string> = {
      headerTransactionId: REFERENCE_HEADER.transactionId,
      headerSequence: String(REFERENCE_HEADER.sequence),
      headerTimestamp: REFERENCE_HEADER.timestamp,
      headerLanguageCode: REFERENCE_HEADER.languageCode,
      headerCountryCode: REFERENCE_HEADER.countryCode,
      headerChannel: REFERENCE_HEADER.channel,
      headerSubChannel: REFERENCE_HEADER.subChannel,
      headerEnvironment: REFERENCE_HEADER.environment,
      headerServiceUser: REFERENCE_HEADER.serviceUser,
    };
    for (const key of ORDER.header) expect(text(find(header, [EL[key]])), key).toBe(values[key]);
  });

  it('emits allAttributes and allHistory from the contract', () => {
    const xml = build({ lastName: 'Testguest' });
    expect(text(one(xml, [...REQUEST_PATH, EL.allAttributes]))).toBe(DEFAULTS.allAttributes);
    expect(text(one(xml, [...REQUEST_PATH, EL.allHistory]))).toBe(DEFAULTS.allHistory);
    expect(DEFAULTS.allAttributes).toBe('true');
    expect(DEFAULTS.allHistory).toBe('false');
  });

  it.each(MAX_RESULTS_CASES)('emits maxResults %i from the options', (maxResults) => {
    const xml = build({ lastName: 'Testguest' }, { ...FLAGS_OFF, maxResults });
    expect(text(one(xml, [...REQUEST_PATH, EL.maxResults]))).toBe(String(maxResults));
  });

  it('serializes compactly behind a UTF-8 XML declaration', () => {
    const xml = build(COMBINED);
    expect(xml).not.toContain('\n');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe('buildSearchGuestRequest: purity (Req 9.14)', () => {
  it('gives byte-identical output for the same input and never mutates it', () => {
    const q = deepFreeze({ ...COMBINED, addressLine2: LINE2 });
    const h: HeaderContext = deepFreeze({ ...REFERENCE_HEADER });
    const o: MapperOptions = deepFreeze({ ...FLAGS_ON, features: { ...FLAGS_ON.features } });
    const snapshot = JSON.stringify([q, h, o]);

    const first = buildSearchGuestRequest(q, h, o);
    const second = buildSearchGuestRequest(q, h, o);
    expect(second).toBe(first);
    expect(JSON.stringify([q, h, o])).toBe(snapshot);
    // A structurally equal, unfrozen copy gives the same bytes: output depends on values only.
    expect(buildSearchGuestRequest(structuredClone(q), { ...h }, structuredClone(o))).toBe(first);
  });
});

describe('reference request snapshots (Req 25.2)', () => {
  const names = Object.keys(REFERENCE_REQUESTS) as ReferenceFixture[];

  it.each(names)('%s matches its canonical file snapshot and fixture', async (name) => {
    const formatted = formatForSnapshot(canonicalize(buildReference(name)));
    await expect(formatted).toMatchFileSnapshot('../__snapshots__/soap/' + name);

    // The snapshot and the fixture cannot drift: `formatted` equals the snapshot file (above),
    // and the fixture, with its comment dropped and formatting ignored, re-formats to exactly
    // the same bytes. (The file is not re-read here: Vitest writes new snapshots after the run.)
    const fixture = readFixture(name);
    expect(formatForSnapshot(canonicalize(fixture, { ignoreFormatting: true }))).toBe(formatted);
  });
});

describe('reference-like text (regression for the P1 counterexample)', () => {
  it('round-trips values that look like entity or character references', () => {
    const q = {
      stateOrRegion: '&amp;',
      firstName: '&lt;b&gt;',
      phone: '&#0;&quot;',
      country: 'US',
    } as const satisfies GuestSearchQuery;
    const header: HeaderContext = { ...REFERENCE_HEADER, channel: '&amp;&' };
    const xml = buildSearchGuestRequest(q, header, FLAGS_OFF);

    const read = readMappedRequest(xml);
    expect(read.stateOrRegion).toBe('&amp;');
    expect(read.firstName).toBe('&lt;b&gt;');
    expect(read.phone).toBe('&#0;&quot;');
    expect(text(descendants(parseXml(xml), EL.headerChannel)[0])).toBe('&amp;&');
  });
});
