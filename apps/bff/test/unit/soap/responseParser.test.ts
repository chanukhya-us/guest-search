// Focused unit tests for the SOAP response parser (task 5.1, Req 11, 12). Inline synthetic
// responses only. Fixture-based assertions are in responseParser.fixtures.test.ts (task 5.3);
// property tests are task 5.4.
import { DOMParser, type Element } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { NS, SUCCESS } from '../../../src/soap/contract.js';
import {
  DETAIL_REDACTED,
  STATUS_MISSING,
  SoapError,
  interpretTransactionStatus,
  parseSearchGuestResponse,
} from '../../../src/soap/responseParser.js';

const CARD_TOKEN = 'SYNTH-CARD-TOKEN-7f3a9c';

/** Namespace declarations; `common` is the default namespace, as in the approved sample. */
const DECLS =
  `xmlns:soap="${NS.soap}" xmlns="${NS.common}" xmlns:ns2="${NS.initiate}" ` +
  `xmlns:ns3="${NS.complex}" xmlns:ns4="${NS.svc}" xmlns:ns5="${NS.basic}"`;

const envelope = (body: string, decls = DECLS): string =>
  `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope ${decls}><soap:Header/>` +
  `<soap:Body>${body}</soap:Body></soap:Envelope>`;

const status = (
  successful: string = SUCCESS.transactionSuccessful,
  code: string = SUCCESS.overallStatusCode,
): string =>
  `<header><transactionStatus overallStatusCode="${code}" overallStatusDescription="x" ` +
  `transactionSuccessful="${successful}"/></header>`;

const response = (guests: string, txn = status()): string =>
  envelope(`<ns4:searchGuestResponse>${txn}${guests}</ns4:searchGuestResponse>`);

const GUEST_FULL =
  `<ns2:initiateGuest score="97.5" status="A" gender="F">` +
  `<ns2:enterpriseId> 900000001 </ns2:enterpriseId>` +
  `<ns3:name><ns5:given>Ada</ns5:given><ns5:surname>Example</ns5:surname></ns3:name>` +
  `<ns3:name><ns5:given>Second</ns5:given></ns3:name>` +
  `<ns3:address locationCode="H" profileDefault="false"><ns3:source><ns5:line1>1 Test St</ns5:line1>` +
  `<ns5:locality1>Atlanta</ns5:locality1><ns5:region1>GA</ns5:region1>` +
  `<ns5:postalCode>30301</ns5:postalCode><ns5:country>US</ns5:country></ns3:source></ns3:address>` +
  `<ns3:address profileDefault="true"><ns3:source><ns5:line1>2 Test St</ns5:line1></ns3:source></ns3:address>` +
  `<ns3:phone number="+1 404 555 0101" type="MOBILE" location="H" profileDefault="true"/>` +
  `<ns3:phone number="+1 404 555 0101" profileDefault="maybe"/>` +
  `<ns3:phone type="WORK"/>` +
  `<ns3:email profileDefault="true"><ns5:address>ada@example.test</ns5:address></ns3:email>` +
  `<ns3:email><ns5:address>   </ns5:address></ns3:email>` +
  `<ns3:membership code="PC" value="900000011" status="ACTIVE"/>` +
  `<ns3:membership code="AMB"/>` +
  `<ns3:creditCard token="${CARD_TOKEN}"><ns5:number>${CARD_TOKEN}</ns5:number></ns3:creditCard>` +
  `</ns2:initiateGuest>`;

const GUEST_MIN = `<ns2:initiateGuest score="n/a"/>`;

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

const parseCode = (xml: unknown): string =>
  soapError(() => parseSearchGuestResponse(xml as string)).code;

const statusEl = (attrs: string): Element =>
  new DOMParser().parseFromString(`<transactionStatus xmlns="${NS.common}" ${attrs}/>`, 'text/xml')
    .documentElement as Element;

describe('parseSearchGuestResponse: mapping (Req 12)', () => {
  it('maps every guest in order, with all allowlisted fields', () => {
    const results = parseSearchGuestResponse(response(GUEST_FULL + GUEST_MIN));
    expect(results).toStrictEqual([
      {
        enterpriseId: '900000001',
        score: 97.5,
        status: 'A',
        gender: 'F',
        firstName: 'Ada',
        lastName: 'Example',
        addresses: [
          {
            line1: '1 Test St',
            city: 'Atlanta',
            stateOrRegion: 'GA',
            postalCode: '30301',
            country: 'US',
            locationCode: 'H',
            profileDefault: false,
          },
          { line1: '2 Test St', profileDefault: true },
        ],
        phones: [
          { number: '+1 404 555 0101', type: 'MOBILE', location: 'H', profileDefault: true },
          { number: '+1 404 555 0101' }, // not deduplicated; unknown boolean -> undefined
        ],
        emails: [{ address: 'ada@example.test', profileDefault: true }],
        memberships: [
          { memberType: 'PC', memberId: '900000011', status: 'ACTIVE' },
          { memberType: 'AMB' },
        ],
      },
      // Non-numeric score left undefined; missing enterpriseId is ''; collections are arrays.
      { enterpriseId: '', addresses: [], phones: [], emails: [], memberships: [] },
    ]);
  });

  it('never returns card data', () => {
    const json = JSON.stringify(parseSearchGuestResponse(response(GUEST_FULL)));
    expect(json).not.toContain(CARD_TOKEN);
    expect(json).not.toMatch(/creditCard|token/i);
  });

  it('returns [] for zero guests', () => {
    expect(parseSearchGuestResponse(response(''))).toEqual([]);
  });

  it.each([
    ['', undefined],
    ['  ', undefined],
    ['0x10', undefined],
    ['1e999', undefined],
    ['Infinity', undefined],
    [' 42 ', 42],
    ['-.5', -0.5],
    ['1E2', 100],
  ])('score %j -> %j', (raw, expected) => {
    const [g] = parseSearchGuestResponse(response(`<ns2:initiateGuest score="${raw}"/>`));
    expect(g?.score).toBe(expected);
  });

  it('is independent of prefixes, including default namespaces and redeclaration', () => {
    const renamed = response(GUEST_FULL + GUEST_MIN)
      .replaceAll('soap:', 'S:')
      .replaceAll('xmlns:soap=', 'xmlns:S=')
      .replaceAll('ns3:', 'c:')
      .replaceAll('xmlns:ns3=', 'xmlns:c=');
    // svc response element in its own default namespace; inner common redeclared on header.
    const defaultSvc = response(GUEST_FULL + GUEST_MIN)
      .replace('<ns4:searchGuestResponse>', `<searchGuestResponse xmlns="${NS.svc}">`)
      .replace('</ns4:searchGuestResponse>', '</searchGuestResponse>')
      .replace('<header>', `<header xmlns="${NS.common}">`);
    const expected = parseSearchGuestResponse(response(GUEST_FULL + GUEST_MIN));
    expect(parseSearchGuestResponse(renamed)).toStrictEqual(expected);
    expect(parseSearchGuestResponse(defaultSvc)).toStrictEqual(expected);
  });

  it('ignores elements with the right local name in the wrong namespace', () => {
    const wrongNs = `<x:initiateGuest xmlns:x="urn:other" score="1"/>`;
    expect(parseSearchGuestResponse(response(wrongNs))).toEqual([]);
  });

  it('ignores a transactionStatus nested inside a guest', () => {
    const xml = envelope(
      `<ns4:searchGuestResponse><ns2:initiateGuest>${status()}</ns2:initiateGuest>` +
        `</ns4:searchGuestResponse>`,
    );
    expect(parseCode(xml)).toBe('UPSTREAM_CONTRACT');
  });
});

describe('parseSearchGuestResponse: errors (Req 11)', () => {
  it.each([
    ['missing Envelope', `<x xmlns="${NS.soap}"/>`],
    ['Envelope in the wrong namespace', `<Envelope xmlns="urn:x"><Body/></Envelope>`],
    ['missing Body', `<soap:Envelope xmlns:soap="${NS.soap}"><soap:Header/></soap:Envelope>`],
    ['missing searchGuestResponse', envelope('<ns4:other/>')],
    ['missing transactionStatus', envelope('<ns4:searchGuestResponse/>')],
    ['well-formed HTML-like page', '<html><body><p>Bad gateway</p></body></html>'],
  ])('%s -> UPSTREAM_CONTRACT', (_label, xml) => {
    expect(parseCode(xml)).toBe('UPSTREAM_CONTRACT');
  });

  it.each([
    ['unqualified faultcode', '<faultcode xmlns="">soap:Client</faultcode>', 'soap:Client'],
    ['soap-qualified faultcode', '<soap:faultcode>soap:Server</soap:faultcode>', 'soap:Server'],
    ['no faultcode', '<faultstring xmlns="">secret text</faultstring>', undefined],
  ])('Fault with %s -> UPSTREAM_FAULT', (_label, inner, detail) => {
    const err = soapError(() =>
      parseSearchGuestResponse(
        envelope(`<soap:Fault>${inner}<faultstring xmlns="">PII here</faultstring></soap:Fault>`),
      ),
    );
    expect(err.code).toBe('UPSTREAM_FAULT');
    expect(err.detail).toBe(detail);
    expect(err.message).not.toMatch(/PII|secret/);
  });

  it('a Fault wins over a searchGuestResponse', () => {
    const xml = envelope(
      `<soap:Fault/><ns4:searchGuestResponse>${status()}</ns4:searchGuestResponse>`,
    );
    expect(parseCode(xml)).toBe('UPSTREAM_FAULT');
  });

  it.each([
    ['transactionSuccessful=false', status('false'), SUCCESS.overallStatusCode],
    ['non-success status code', status(SUCCESS.transactionSuccessful, 'E123'), 'E123'],
  ])('%s -> UPSTREAM_TXN_FAILED with the status code', (_label, txn, code) => {
    const err = soapError(() => parseSearchGuestResponse(response(GUEST_MIN, txn)));
    expect(err).toMatchObject({ code: 'UPSTREAM_TXN_FAILED', detail: code });
  });

  it.each([
    ['empty string', ''],
    ['truncated XML', response(GUEST_FULL).slice(0, 200)],
    ['plain text', 'Service Unavailable'],
    ['HTML with an undefined entity', '<html><body>&nbsp;</body></html>'],
    ['unbound prefix', '<a:b/>'],
    ['duplicate attribute', `<x a="1" a="2"/>`],
    ['non-string input', 42],
    ['null input', null],
  ])('%s -> UPSTREAM_MALFORMED', (_label, xml) => {
    expect(parseCode(xml)).toBe('UPSTREAM_MALFORMED');
  });

  it('rejects a billion-laughs DTD without expanding it', () => {
    const lol =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">' +
      Array.from(
        { length: 9 },
        (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i || ''};`.repeat(10)}">`,
      ).join('') +
      ']><lolz>&lol9;</lolz>';
    const started = performance.now();
    expect(parseCode(lol)).toBe('UPSTREAM_MALFORMED');
    expect(performance.now() - started).toBeLessThan(100);
  });

  it.each([
    ['external entity', '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><x>&xxe;</x>'],
    ['lower-case doctype', '<!doctype x><x/>'],
    ['ENTITY without DOCTYPE', response(GUEST_MIN).replace('<soap:Header/>', '<!ENTITY a "b">')],
  ])('rejects %s', (_label, xml) => {
    expect(parseCode(xml)).toBe('UPSTREAM_MALFORMED');
  });

  it('error messages never contain payload text', () => {
    const err = soapError(() => parseSearchGuestResponse(`<x>${CARD_TOKEN}`));
    expect(err.message).not.toContain(CARD_TOKEN);
    expect(err.cause).toBeUndefined();
  });
});

describe('interpretTransactionStatus (Req 11.8, 11.9)', () => {
  const ok = `transactionSuccessful="${SUCCESS.transactionSuccessful}"`;
  const code = `overallStatusCode="${SUCCESS.overallStatusCode}"`;

  it.each([
    ['both success values', `${ok} ${code}`, { ok: true }],
    ['surrounding whitespace', `transactionSuccessful=" true " ${code}`, { ok: true }],
    [
      'successful=false',
      `transactionSuccessful="false" ${code}`,
      { ok: false, code: SUCCESS.overallStatusCode },
    ],
    [
      'successful=TRUE (case matters)',
      `transactionSuccessful="TRUE" ${code}`,
      { ok: false, code: SUCCESS.overallStatusCode },
    ],
    ['successful missing', code, { ok: false, code: SUCCESS.overallStatusCode }],
    ['other status code', `${ok} overallStatusCode="9999"`, { ok: false, code: '9999' }],
    ['status code missing', ok, { ok: false, code: STATUS_MISSING }],
  ])('%s', (_label, attrs, expected) => {
    expect(interpretTransactionStatus(statusEl(attrs))).toEqual(expected);
  });

  it('null element -> not ok, MISSING', () => {
    expect(interpretTransactionStatus(null)).toEqual({ ok: false, code: STATUS_MISSING });
  });
});

describe('SoapError', () => {
  it('keeps short code-like details and redacts anything else', () => {
    expect(new SoapError('UPSTREAM_FAULT', 'soap:Client').detail).toBe('soap:Client');
    expect(new SoapError('UPSTREAM_FAULT', 'line\nbreak').detail).toBe(DETAIL_REDACTED);
    expect(new SoapError('UPSTREAM_FAULT', 'x'.repeat(65)).detail).toBe(DETAIL_REDACTED);
    expect(new SoapError('UPSTREAM_HTTP_ERROR')).toMatchObject({
      name: 'SoapError',
      code: 'UPSTREAM_HTTP_ERROR',
      detail: undefined,
    });
  });
});
