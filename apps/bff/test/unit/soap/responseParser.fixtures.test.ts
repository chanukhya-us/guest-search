// Fixture-based response-parser tests (task 5.3, Req 11.1-11.9, 12.1-12.12, 25.3). The
// fixtures in test/fixtures/soap/ are the same bytes WireMock serves. Focused inline cases
// live in responseParser.test.ts; the outcome table is in responseFixtures.test.ts.
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { GuestSearchResult } from '@ihg-guest-search/shared';
import { describe, expect, it } from 'vitest';
import { NS } from '../../../src/soap/contract.js';
import {
  STATUS_MISSING,
  SoapError,
  interpretTransactionStatus,
  parseSearchGuestResponse,
} from '../../../src/soap/responseParser.js';
import { readFixture } from '../../helpers/requestFixtures.js';
import {
  CC_TOKEN_FIXTURE_PII,
  CC_TOKEN_MARKER,
  type ResponseFixture,
} from '../../helpers/responseFixtures.js';

const parse = (file: ResponseFixture): GuestSearchResult[] =>
  parseSearchGuestResponse(readFixture(file));

/** Run `fn` and return the SoapError it throws. */
function soapError(fn: () => unknown): SoapError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SoapError);
    return e as SoapError;
  }
  throw new Error('expected a SoapError');
}

const fixtureError = (file: ResponseFixture): SoapError =>
  soapError(() => parseSearchGuestResponse(readFixture(file)));

/** Every place an error could carry text: message, detail, JSON and the non-frame stack lines. */
function errorSurfaces(err: SoapError): string[] {
  const stackHead = (err.stack ?? '')
    .split('\n')
    .filter((line) => !/^\s+at\s/.test(line))
    .join('\n');
  return [err.message, String(err.detail), JSON.stringify(err), stackHead, String(err.cause)];
}

function expectNoLeak(err: SoapError, forbidden: readonly string[]): void {
  for (const surface of errorSurfaces(err)) {
    for (const text of forbidden) expect(surface).not.toContain(text);
  }
}

// ---------------------------------------------------------------------------------------
// Expected results. Field-for-field from the fixture XML.

const SINGLE: GuestSearchResult[] = [
  {
    enterpriseId: '900000001',
    score: 98.5,
    status: 'A',
    gender: 'F',
    firstName: 'Avery',
    lastName: 'Single',
    addresses: [
      {
        line1: '101 Example Way',
        city: 'Atlanta',
        stateOrRegion: 'GA',
        postalCode: '30399',
        country: 'US',
        locationCode: 'H',
        profileDefault: true,
      },
    ],
    phones: [{ number: '+1 404 555 0101', type: 'MOBILE', location: 'H', profileDefault: true }],
    emails: [{ address: 'avery.single@example.test', profileDefault: true }],
    memberships: [{ memberType: 'PLACEHOLDER', memberId: '900000011', status: 'ACTIVE' }],
  },
];

const MULTIPLE: GuestSearchResult[] = [
  {
    enterpriseId: '900000002',
    score: 99,
    status: 'A',
    gender: 'F',
    firstName: 'Blake',
    lastName: 'Testguest',
    addresses: [
      {
        line1: '102 Example Way',
        city: 'Atlanta',
        stateOrRegion: 'GA',
        postalCode: '30399',
        country: 'US',
        locationCode: 'H',
        profileDefault: true,
      },
    ],
    phones: [{ number: '+1 404 555 0102', type: 'MOBILE', location: 'H', profileDefault: true }],
    emails: [{ address: 'blake.testguest@example.test', profileDefault: true }],
    memberships: [{ memberType: 'PLACEHOLDER', memberId: '900000012', status: 'ACTIVE' }],
  },
  {
    enterpriseId: '900000003',
    score: 87.25,
    status: 'A',
    gender: 'M',
    firstName: 'Casey',
    lastName: 'Testguest',
    addresses: [
      {
        line1: '103 Example Way',
        city: 'Toronto',
        stateOrRegion: 'ON',
        postalCode: 'M5V 0Z0',
        country: 'CA',
        locationCode: 'B',
        profileDefault: true,
      },
    ],
    phones: [{ number: '+1 404 555 0103', type: 'WORK', location: 'B', profileDefault: true }],
    emails: [{ address: 'casey.testguest@example.test', profileDefault: true }],
    memberships: [],
  },
  {
    enterpriseId: '900000004',
    score: 64,
    status: 'I',
    firstName: 'Devon',
    lastName: 'Testguest',
    addresses: [],
    phones: [],
    emails: [{ address: 'devon.testguest@example.test', profileDefault: true }],
    memberships: [{ memberType: 'PLACEHOLDER', memberId: '900000014', status: 'INACTIVE' }],
  },
];

const COLLECTIONS = ['addresses', 'phones', 'emails', 'memberships'] as const;

// ---------------------------------------------------------------------------------------

describe('guest mapping (Req 12.1-12.7)', () => {
  it('response-single.xml maps every allowlisted field of one guest', () => {
    expect(parse('response-single.xml')).toStrictEqual(SINGLE);
  });

  it('response-multiple.xml maps all guests in service order', () => {
    expect(parse('response-multiple.xml')).toStrictEqual(MULTIPLE);
  });

  it.each(['response-single.xml', 'response-multiple.xml'] as const)(
    '%s represents every collection as an array (Req 12.7)',
    (file) => {
      for (const guest of parse(file)) {
        for (const key of COLLECTIONS) expect(Array.isArray(guest[key])).toBe(true);
      }
    },
  );

  it('response-60-guests.xml maps every guest in service order (Req 12.1)', () => {
    const xml = readFixture('response-60-guests.xml');
    const idsInXml = [...xml.matchAll(/enterpriseId>(\d+)</g)].map((m) => m[1]);
    const results = parseSearchGuestResponse(xml);
    expect(results).toHaveLength(60);
    expect(results.map((g) => g.enterpriseId)).toEqual(idsInXml);
  });

  it('response-empty.xml returns an empty array (zero guests)', () => {
    expect(parse('response-empty.xml')).toStrictEqual([]);
  });
});

describe('repeated contacts (Req 12.3-12.7, 12.12)', () => {
  const [guest] = parse('response-repeated-contacts.xml');

  it('keeps every item in service order', () => {
    expect(guest).toStrictEqual({
      enterpriseId: '900000021',
      score: 91.5,
      status: 'A',
      gender: 'F',
      firstName: 'Emery',
      lastName: 'Repeatguest',
      addresses: [
        {
          line1: '121 Example Way',
          city: 'Atlanta',
          stateOrRegion: 'GA',
          postalCode: '30399',
          country: 'US',
          locationCode: 'B',
          profileDefault: false,
        },
        {
          line1: '122 Example Way',
          city: 'Savannah',
          stateOrRegion: 'GA',
          postalCode: '31499',
          country: 'US',
          locationCode: 'H',
          profileDefault: true,
        },
        { line1: '123 Example Way', city: 'London', country: 'GB', locationCode: 'O' },
      ],
      phones: [
        { number: '+1 404 555 0121', type: 'WORK', location: 'B', profileDefault: false },
        { number: '+1 404 555 0122', type: 'MOBILE', location: 'H', profileDefault: true },
        { number: '+1 404 555 0121', type: 'WORK', location: 'B' },
      ],
      emails: [
        { address: 'emery.work@example.test', profileDefault: false },
        { address: 'emery.repeatguest@example.test', profileDefault: true },
      ],
      memberships: [
        { memberType: 'PLACEHOLDER', memberId: '900000022', status: 'ACTIVE' },
        { memberType: 'PLACEHOLDER-2', memberId: '900000023', status: 'INACTIVE' },
      ],
    });
  });

  it('counts match the fixture and the duplicate phone is not deduplicated', () => {
    expect(guest?.addresses).toHaveLength(3);
    expect(guest?.phones).toHaveLength(3);
    expect(guest?.emails).toHaveLength(2);
    expect(guest?.memberships).toHaveLength(2);
    expect(guest?.phones.map((p) => p.number)).toEqual([
      '+1 404 555 0121',
      '+1 404 555 0122',
      '+1 404 555 0121',
    ]);
  });
});

describe('profileDefault flags (Req 12.3-12.5; primary selection is tested in shared)', () => {
  it('response-no-default.xml: flags are false or absent, never true', () => {
    const [g] = parse('response-no-default.xml');
    expect(g?.addresses.map((a) => a.profileDefault)).toEqual([false, undefined]);
    expect(g?.phones.map((p) => p.profileDefault)).toEqual([false, undefined]);
    expect(g?.emails.map((e) => e.profileDefault)).toEqual([false, undefined]);
    // Absent means absent, not a fabricated false (Req 12.9).
    expect(g?.addresses[1]).not.toHaveProperty('profileDefault');
    expect(g?.phones[1]).not.toHaveProperty('profileDefault');
    expect(g?.emails[1]).not.toHaveProperty('profileDefault');
    expect(g?.phones.map((p) => p.number)).toEqual(['+1 404 555 0131', '+1 404 555 0132']);
  });

  it('response-multiple-defaults.xml: every item keeps its true flag, in order', () => {
    const [g] = parse('response-multiple-defaults.xml');
    expect(g?.addresses.map((a) => [a.line1, a.profileDefault])).toEqual([
      ['141 Example Way', true],
      ['142 Example Way', true],
    ]);
    expect(g?.phones.map((p) => [p.number, p.profileDefault])).toEqual([
      ['+1 404 555 0141', true],
      ['+1 404 555 0142', true],
    ]);
    expect(g?.emails.map((e) => [e.address, e.profileDefault])).toEqual([
      ['gray.manydefaults@example.test', true],
      ['gray.second@example.test', true],
    ]);
  });
});

describe('missing optional fields and non-numeric score (Req 12.8, 12.9)', () => {
  const results = parse('response-missing-optional.xml');

  it('absent fields stay absent and nothing is fabricated', () => {
    expect(results).toStrictEqual([
      { enterpriseId: '900000051', addresses: [], phones: [], emails: [], memberships: [] },
      {
        enterpriseId: '900000052',
        firstName: 'Harper',
        addresses: [{ country: 'US' }],
        phones: [], // phone without @number is skipped
        emails: [], // blank address text is skipped
        memberships: [{ memberType: 'PLACEHOLDER' }],
      },
      // enterpriseId is a required string in the domain type, so a missing one is ''.
      { enterpriseId: '', addresses: [], phones: [], emails: [], memberships: [] },
    ]);
  });

  it('a non-numeric score is undefined and the guest is still mapped', () => {
    const g = results[1];
    expect(g?.score).toBeUndefined();
    expect(g).not.toHaveProperty('score');
    expect(g?.firstName).toBe('Harper');
  });

  it('blank status and blank surname are absent, not empty strings', () => {
    expect(results[1]).not.toHaveProperty('status');
    expect(results[1]).not.toHaveProperty('lastName');
    for (const g of results) expect(Object.values(g)).not.toContain('  ');
  });
});

describe('namespace prefixes (Req 11.4)', () => {
  it.each(['response-odd-prefixes.xml', 'response-default-namespace.xml'] as const)(
    '%s parses to the exact data of response-multiple.xml',
    (file) => {
      expect(parse(file)).toStrictEqual(MULTIPLE);
    },
  );
});

describe('card token exclusion (Req 12.10, 12.11, 12.13)', () => {
  const results = parse('response-with-cc-token.xml');
  const json = JSON.stringify(results);

  it('the output contains neither the token nor the element name', () => {
    expect(json).not.toContain(CC_TOKEN_MARKER);
    expect(json).not.toContain('creditCard');
    expect(json).not.toMatch(/token|expiry|2099-12/i);
  });

  it('the guest itself is still mapped with its non-card PII', () => {
    expect(results).toHaveLength(1);
    for (const value of Object.values(CC_TOKEN_FIXTURE_PII)) expect(json).toContain(value);
    expect(Object.keys(results[0] ?? {}).sort()).toEqual(
      [
        'addresses',
        'emails',
        'enterpriseId',
        'firstName',
        'gender',
        'lastName',
        'memberships',
        'phones',
        'score',
        'status',
      ].sort(),
    );
  });
});

describe('transaction status (Req 11.8, 11.9)', () => {
  it('response-failure-status.xml -> UPSTREAM_TXN_FAILED, status code retained', () => {
    const err = fixtureError('response-failure-status.xml');
    expect(err).toMatchObject({ code: 'UPSTREAM_TXN_FAILED', detail: '1001' });
    // Neither the description nor the guest present in the failed response leaks.
    expectNoLeak(err, ['Synthetic failure for tests', '900000061']);
  });
});

describe('SOAP Faults (Req 11.6)', () => {
  it.each([
    [
      'fault-client.xml',
      'soap:Client',
      [
        'Synthetic client fault',
        'faultmarker@example.test',
        'Synthetic validation detail',
        '+1 404 555 0190',
      ],
    ],
    [
      'fault-server.xml',
      'soap:Server',
      [
        'Synthetic internal error',
        'Service.java:42',
        'example.Service',
        'urn:example:guest-service',
      ],
    ],
  ] as const)('%s -> UPSTREAM_FAULT, only the faultcode retained', (file, faultcode, forbidden) => {
    const err = fixtureError(file);
    expect(err).toMatchObject({ code: 'UPSTREAM_FAULT', detail: faultcode });
    expect(err.cause).toBeUndefined();
    expectNoLeak(err, forbidden);
  });
});

describe('structural contract breaks (Req 11.5, 11.7)', () => {
  const single = readFixture('response-single.xml');

  it('missing Body -> UPSTREAM_CONTRACT', () => {
    const xml = single.replace(/<soap:Body>[\s\S]*<\/soap:Body>/, '');
    expect(xml).not.toContain('Body');
    expect(soapError(() => parseSearchGuestResponse(xml)).code).toBe('UPSTREAM_CONTRACT');
  });

  it('missing searchGuestResponse -> UPSTREAM_CONTRACT', () => {
    const xml = single.replaceAll('ns4:searchGuestResponse', 'ns4:somethingElse');
    expect(soapError(() => parseSearchGuestResponse(xml)).code).toBe('UPSTREAM_CONTRACT');
  });

  it('searchGuestResponse in the wrong namespace -> UPSTREAM_CONTRACT', () => {
    const xml = single.replace(`xmlns:ns4="${NS.svc}"`, 'xmlns:ns4="urn:example:other"');
    expect(soapError(() => parseSearchGuestResponse(xml)).code).toBe('UPSTREAM_CONTRACT');
  });
});

describe('malformed input (Req 11.1-11.3)', () => {
  it('malformed-truncated.xml -> UPSTREAM_MALFORMED without partial data', () => {
    const err = fixtureError('malformed-truncated.xml');
    expect(err.code).toBe('UPSTREAM_MALFORMED');
    expectNoLeak(err, ['Indigo', '900000081', 'Trunc']);
  });

  it('malformed-proxy-502.html -> UPSTREAM_MALFORMED', () => {
    const err = fixtureError('malformed-proxy-502.html');
    expect(err.code).toBe('UPSTREAM_MALFORMED');
    expectNoLeak(err, ['502 Bad Gateway', 'synthetic-proxy']);
  });

  it('malformed-dtd.xml is rejected quickly, without resolving any entity', () => {
    const xml = readFixture('malformed-dtd.xml');
    const started = performance.now();
    const err = soapError(() => parseSearchGuestResponse(xml));
    const elapsed = performance.now() - started;
    expect(err.code).toBe('UPSTREAM_MALFORMED');
    expect(err.detail).toBeUndefined(); // rejected by the pre-check, before the parser runs
    expect(elapsed).toBeLessThan(100);
    // Nothing from the entities or the external resource surfaces anywhere.
    expectNoLeak(err, ['lol', 'passwd', 'root:', 'xxe', '900000091']);
  });
});

describe('interpretTransactionStatus on fixture elements (Req 11.9)', () => {
  const statusOf = (file: ResponseFixture): Element | null => {
    const doc = new DOMParser().parseFromString(readFixture(file), 'text/xml');
    return doc.getElementsByTagNameNS(NS.common, 'transactionStatus').item(0);
  };

  it.each([
    'response-single.xml',
    'response-multiple.xml',
    'response-empty.xml',
    'response-odd-prefixes.xml',
    'response-default-namespace.xml',
  ] as const)('%s -> ok', (file) => {
    const el = statusOf(file);
    expect(el).not.toBeNull();
    expect(interpretTransactionStatus(el)).toEqual({ ok: true });
  });

  it('response-failure-status.xml -> not ok with its status code', () => {
    expect(interpretTransactionStatus(statusOf('response-failure-status.xml'))).toEqual({
      ok: false,
      code: '1001',
    });
  });

  it('a fault has no transactionStatus, which reads as MISSING', () => {
    expect(statusOf('fault-client.xml')).toBeNull();
    expect(interpretTransactionStatus(statusOf('fault-client.xml'))).toEqual({
      ok: false,
      code: STATUS_MISSING,
    });
  });
});
