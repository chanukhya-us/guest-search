// Property tests for the SOAP response parser (task 5.4, Req 11.11, 11.12, 25.4): P3 parser
// totality and P4 prefix invariance (design.md "Correctness Properties").
//
// P3 feeds fully arbitrary strings, XML-ish token soup, mutated fixtures and deep nesting.
// P4 re-serializes the valid fixtures from the DOM with random prefixes (test/helpers/
// prefixRewrite.ts), never with regex over the XML. U+FFFD (in the P3 soup) is tolerated by
// the parser: xmldom only warns on it, and that single warning is not fatal. P3's oracle is
// unchanged by this (a result array or a typed SoapError either way).
import { fc, test } from '@fast-check/vitest';
import type { GuestSearchResult } from '@ihg-guest-search/shared';
import { describe, expect, it } from 'vitest';
import { NS } from '../../src/soap/contract.js';
import {
  SoapError,
  parseSearchGuestResponse,
  type UpstreamCode,
} from '../../src/soap/responseParser.js';
import {
  namespaceSignature,
  rewritePrefixes,
  type PrefixPlan,
  type Rebinding,
} from '../helpers/prefixRewrite.js';
import { readFixture } from '../helpers/requestFixtures.js';
import { RESPONSE_FIXTURES, type ResponseFixture } from '../helpers/responseFixtures.js';

/** The only codes the parser may raise (the transport codes belong to tasks 6.x). */
const PARSER_CODES: ReadonlySet<UpstreamCode> = new Set<UpstreamCode>([
  'UPSTREAM_MALFORMED',
  'UPSTREAM_CONTRACT',
  'UPSTREAM_FAULT',
  'UPSTREAM_TXN_FAILED',
]);
/** Same rule as the parser's SAFE_DETAIL; 'REDACTED' also matches. */
const SAFE_DETAIL = /^[A-Za-z0-9_.:-]{1,64}$/;
const COLLECTIONS = ['addresses', 'phones', 'emails', 'memberships'] as const;

const ALL_FIXTURES = Object.keys(RESPONSE_FIXTURES) as ResponseFixture[];
const VALID_FIXTURES = ALL_FIXTURES.filter((f) => 'guests' in RESPONSE_FIXTURES[f]);
const FIXTURE_XML = new Map(ALL_FIXTURES.map((f) => [f, readFixture(f)]));
const xmlOf = (f: ResponseFixture): string => FIXTURE_XML.get(f) ?? '';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function expectResultShape(result: unknown): void {
  expect(Array.isArray(result)).toBe(true);
  for (const guest of result as unknown[]) {
    expect(isPlainObject(guest)).toBe(true);
    const g = guest as Record<string, unknown>;
    expect(typeof g.enterpriseId).toBe('string');
    // compact(): absent fields are absent keys, never `undefined` values.
    expect(Object.values(g)).not.toContain(undefined);
    for (const key of COLLECTIONS) {
      const items = g[key];
      expect(Array.isArray(items)).toBe(true);
      for (const item of items as unknown[]) expect(isPlainObject(item)).toBe(true);
    }
  }
}

/** P3 oracle: an array of results, or a parser-coded SoapError without a cause. */
function expectTotal(input: string): void {
  let result: unknown;
  try {
    result = parseSearchGuestResponse(input);
  } catch (e) {
    expect(e).toBeInstanceOf(SoapError);
    const err = e as SoapError;
    expect(PARSER_CODES.has(err.code)).toBe(true);
    expect(Object.hasOwn(err, 'cause')).toBe(false);
    expect(err.cause).toBeUndefined();
    if (err.detail !== undefined) expect(err.detail).toMatch(SAFE_DETAIL);
    return;
  }
  expectResultShape(result);
}

// ---------------------------------------------------------------------------------------------
// P3 arbitraries
// ---------------------------------------------------------------------------------------------

/** Every UTF-16 code unit, so lone surrogates appear too ('binary' never yields them). */
const anyCodeUnit = fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c));

const SOUP_TOKENS = [
  '<',
  '>',
  '&',
  '"',
  "'",
  '=',
  '/',
  '</',
  '/>',
  ' ',
  '\n',
  '\r',
  '\u0000',
  '\ufeff',
  '\ufffd',
  '&amp;',
  '&lt;',
  '&#0;',
  '&#65;',
  '&#x1F600;',
  '&#xD800;',
  '&#xFFFE;',
  '&#99999999;',
  '&bogus;',
  '&#',
  '<![CDATA[',
  ']]>',
  '<![CDATA[x]]>',
  '<?xml version="1.0"?>',
  '<?xml version="1.1" encoding="UTF-16"?>',
  '<?pi data?>',
  '<?',
  '?>',
  '<!DOCTYPE x>',
  '<!doctype x [',
  '<!ENTITY e "x">',
  '<!eNtItY',
  '<!--',
  '-->',
  '<!-- c -->',
  '<!',
  'xmlns',
  'xmlns=""',
  'xmlns:soap',
  `xmlns:soap="${NS.soap}"`,
  `xmlns="${NS.common}"`,
  `<soap:Envelope xmlns:soap="${NS.soap}">`,
  '</soap:Envelope>',
  '<soap:Body>',
  '</soap:Body>',
  '<soap:Fault>',
  '</soap:Fault>',
  '<faultcode>',
  'soap:Client',
  '</faultcode>',
  `<r:searchGuestResponse xmlns:r="${NS.svc}">`,
  '</r:searchGuestResponse>',
  `<c:transactionStatus xmlns:c="${NS.common}" transactionSuccessful="true" overallStatusCode="0000"/>`,
  `<c:transactionStatus xmlns:c="${NS.common}" transactionSuccessful="false" overallStatusCode="1001"/>`,
  `<g:initiateGuest xmlns:g="${NS.initiate}" score="1e999">`,
  '</g:initiateGuest>',
  `<g:enterpriseId xmlns:g="${NS.initiate}">900000001</g:enterpriseId>`,
  `<x:phone xmlns:x="${NS.initiate}" number="+1 404 555 0101"/>`,
  `<x:name xmlns:x="${NS.initiate}">`,
  '</x:name>',
  'a:b',
  ':',
  'Envelope',
];

const soupPiece = fc.oneof(
  { arbitrary: fc.constantFrom(...SOUP_TOKENS), weight: 4 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 6 }), weight: 1 },
  { arbitrary: fc.string({ unit: anyCodeUnit, maxLength: 3 }), weight: 1 },
);
const soup = fc.array(soupPiece, { maxLength: 40 }).map((parts) => parts.join(''));

/** Soup inside a real envelope and Body, so the Fault/contract/status branches are reached. */
const shelledSoup = soup.map(
  (s) => `<soap:Envelope xmlns:soap="${NS.soap}"><soap:Body>${s}</soap:Body></soap:Envelope>`,
);

const insertText = fc.oneof(soupPiece, fc.string({ unit: 'binary', maxLength: 20 }));
const NS_URIS = Object.values(NS);

type Mutation =
  | { kind: 'truncate'; at: number }
  | { kind: 'delete'; at: number; len: number }
  | { kind: 'insert'; at: number; text: string }
  | { kind: 'duplicate'; at: number; len: number; to: number }
  | { kind: 'swapNs'; from: string; to: string };

const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ kind: fc.constant('truncate' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('delete' as const), at: fc.nat(), len: fc.nat({ max: 200 }) }),
  fc.record({ kind: fc.constant('insert' as const), at: fc.nat(), text: insertText }),
  fc.record({
    kind: fc.constant('duplicate' as const),
    at: fc.nat(),
    len: fc.nat({ max: 400 }),
    to: fc.nat(),
  }),
  fc.record({
    kind: fc.constant('swapNs' as const),
    from: fc.constantFrom(...NS_URIS),
    to: fc.oneof(
      fc.constantFrom(...NS_URIS, '', 'urn:example:other'),
      fc.string({ unit: 'binary', maxLength: 10 }),
    ),
  }),
);

function applyMutation(s: string, m: Mutation): string {
  const at = (n: number): number => n % (s.length + 1);
  switch (m.kind) {
    case 'truncate':
      return s.slice(0, at(m.at));
    case 'delete':
      return s.slice(0, at(m.at)) + s.slice(at(m.at) + m.len);
    case 'insert':
      return s.slice(0, at(m.at)) + m.text + s.slice(at(m.at));
    case 'duplicate': {
      const seg = s.slice(at(m.at), at(m.at) + m.len);
      return s.slice(0, at(m.to)) + seg + s.slice(at(m.to));
    }
    case 'swapNs':
      return s.replaceAll(m.from, m.to);
  }
}

const mutatedFixture = fc
  .tuple(fc.constantFrom(...ALL_FIXTURES), fc.array(mutation, { minLength: 1, maxLength: 3 }))
  .map(([f, ms]) => ms.reduce(applyMutation, xmlOf(f)));

type Nesting = 'bare' | 'unclosed' | 'body' | 'given';
const GIVEN = 'Avery</ns3:given>';

function nested(kind: Nesting, depth: number): string {
  const open = '<a>'.repeat(depth);
  const close = '</a>'.repeat(depth);
  switch (kind) {
    case 'bare':
      return open + close;
    case 'unclosed':
      return open;
    case 'body':
      return `<soap:Envelope xmlns:soap="${NS.soap}"><soap:Body>${open}${close}</soap:Body></soap:Envelope>`;
    case 'given':
      // Deep content inside a mapped text element, so textContent walks the whole chain.
      return xmlOf('response-single.xml').replace(GIVEN, open + 'Avery' + close + '</ns3:given>');
  }
}

const deepNesting = fc
  .tuple(
    fc.constantFrom<Nesting>('bare', 'unclosed', 'body', 'given'),
    fc.integer({ min: 1, max: 20_000 }),
  )
  .map(([kind, depth]) => nested(kind, depth));

// ---------------------------------------------------------------------------------------------
// P4 arbitraries
// ---------------------------------------------------------------------------------------------

/** Prefixes: the default namespace (weighted up), familiar and misleading names, random NCNames. */
const prefix = fc.oneof(
  { arbitrary: fc.constant(''), weight: 3 },
  {
    arbitrary: fc.constantFrom(
      'soap',
      'SOAP-ENV',
      'ns2',
      'ns3',
      'ns4',
      'ns5',
      'a',
      'x-1',
      'x.y',
      'ü',
    ),
    weight: 3,
  },
  {
    arbitrary: fc.stringMatching(/^[A-Za-z][A-Za-z0-9._-]{0,7}$/).filter((p) => !/^xml/i.test(p)),
    weight: 2,
  },
);

const rebinding: fc.Arbitrary<Rebinding> = fc.record({ at: fc.nat(), ns: fc.nat(), prefix });

const plan: fc.Arbitrary<PrefixPlan> = fc.record({
  prefixes: fc.array(prefix, { minLength: 8, maxLength: 8 }),
  rebind: fc.array(rebinding, { maxLength: 6 }),
});

const CANONICAL = new Map(VALID_FIXTURES.map((f) => [f, parseSearchGuestResponse(xmlOf(f))]));
const canonical = (f: ResponseFixture): GuestSearchResult[] => CANONICAL.get(f) ?? [];

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe('parseSearchGuestResponse totality', () => {
  // Feature: ihg-guest-search, Property 3: Parser totality — For all strings s (fully
  // arbitrary, plus mutated fixture XML), `parseSearchGuestResponse(s)` returns an array or
  // throws `SoapError` with a code in `UpstreamCode`, never another error type.
  // **Validates: Requirements 11.11, 25.4**
  test.prop([fc.string({ unit: 'binary', maxLength: 300 })], { numRuns: 1000 })(
    'P3: arbitrary Unicode strings',
    (s) => expectTotal(s),
  );

  // Feature: ihg-guest-search, Property 3: Parser totality (XML-ish token soup, bare and
  // inside a SOAP envelope and Body).
  // **Validates: Requirements 11.11, 25.4**
  test.prop([fc.oneof(soup, shelledSoup)], { numRuns: 1000 })('P3: XML token soup', (s) =>
    expectTotal(s),
  );

  // Feature: ihg-guest-search, Property 3: Parser totality (mutated fixture XML: truncation,
  // range deletion, insertion, segment duplication, namespace URI swap).
  // **Validates: Requirements 11.11, 25.4**
  test.prop([mutatedFixture], { numRuns: 500 })('P3: mutated fixtures', (s) => expectTotal(s));

  // Feature: ihg-guest-search, Property 3: Parser totality (deep nesting, closed, unclosed,
  // inside Body and inside a mapped text element).
  // **Validates: Requirements 11.11, 25.4**
  test.prop([deepNesting], { numRuns: 40 })('P3: deep nesting', (s) => expectTotal(s));
});

describe('parseSearchGuestResponse prefix invariance', () => {
  // Feature: ihg-guest-search, Property 4: Prefix invariance — For all valid fixture
  // responses and all random prefix assignments (including the empty/default namespace and
  // re-declaration mid-tree), the parsed results deep-equal the canonical parse.
  // **Validates: Requirements 11.12, 25.4**
  test.prop([fc.constantFrom(...VALID_FIXTURES), plan], { numRuns: 300 })(
    'P4: random prefixes, default namespace and redeclaration leave the results unchanged',
    (file, p) => {
      const original = xmlOf(file);
      const rewritten = rewritePrefixes(original, p);
      // The rewrite itself must preserve the namespace-level infoset, else P4 proves nothing.
      expect(namespaceSignature(rewritten)).toStrictEqual(namespaceSignature(original));
      expect(parseSearchGuestResponse(rewritten)).toStrictEqual(canonical(file));
    },
    // 300 runs that include the 60-guest fixture take ~5 s under coverage on a loaded worker,
    // right at Vitest's default timeout; give the property explicit headroom.
    30_000,
  );

  // Examples pinning down that the rewriter really exercises the cases P4 is about.
  it('the rewriter can put SOAP itself in the default namespace', () => {
    const xml = rewritePrefixes(xmlOf('response-single.xml'), {
      prefixes: ['', 'p1', 'p2', 'p3', 'p4', 'p5'],
      rebind: [],
    });
    expect(xml).toContain(`<Envelope xmlns="${NS.soap}">`);
    expect(xml).not.toContain('soap:');
    expect(parseSearchGuestResponse(xml)).toStrictEqual(canonical('response-single.xml'));
  });

  it('the rewriter redeclares a namespace mid-tree, including as the default', () => {
    // URIs in document order: soap, svc, common, initiate, complex (the response fixtures use
    // no basictypes element since they mirror the request sample).
    const base = { prefixes: ['s', 'v', 'c', 'i', 'x'], rebind: [] };
    const plain = rewritePrefixes(xmlOf('response-repeated-contacts.xml'), base);
    const rebound = rewritePrefixes(xmlOf('response-repeated-contacts.xml'), {
      ...base,
      // Element 0 is Envelope: the initiate namespace (index 3) becomes the default there, and
      // element 9 (the first `given`) rebinds 's' from SOAP to the complex namespace (index 4).
      rebind: [
        { at: 0, ns: 3, prefix: '' },
        { at: 9, ns: 4, prefix: 's' },
      ],
    });
    expect(rebound).not.toBe(plain);
    expect(rebound).toContain(`xmlns="${NS.initiate}"`);
    expect(rebound).toContain(`xmlns:s="${NS.complex}"`);
    expect(parseSearchGuestResponse(rebound)).toStrictEqual(
      canonical('response-repeated-contacts.xml'),
    );
  });

  it('an unqualified element under a default namespace gets xmlns=""', () => {
    const fault = xmlOf('fault-client.xml');
    const xml = rewritePrefixes(fault, { prefixes: [''], rebind: [] });
    expect(xml).toContain('<faultcode xmlns="">');
    expect(namespaceSignature(xml)).toStrictEqual(namespaceSignature(fault));
    expect(() => parseSearchGuestResponse(xml)).toThrow(SoapError);
  });
});
