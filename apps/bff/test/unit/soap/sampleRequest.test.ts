// Contract proof against the project team's only real sample request (docs/Request.txt, a curl
// command). The envelope is kept, sanitized, as test/fixtures/soap/sample-request-team.xml.
//
// 1. The fixture equals the curl's --data envelope, except the two sanitized attributes.
// 2. The real mapper, fed the sample's criteria and header values (fixed clock, fixed
//    transaction ID), produces the same structure: namespace URIs, element order, attributes
//    and values. The only allowed differences are the blank groups the mapper omits by rule
//    (copilot-instructions.md §5): the empty email address and membership/@value="".
// 3. The transport sends the sample's HTTP headers with the default configuration.
import { readFileSync } from 'node:fs';
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import type { Document, Element } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { EnvSecretProvider, loadConfig } from '../../../src/config.js';
import { CircuitBreaker } from '../../../src/soap/circuitBreaker.js';
import { EL, type El } from '../../../src/soap/contract.js';
import { createHeaderContext } from '../../../src/soap/headerBuilder.js';
import { buildSearchGuestRequest } from '../../../src/soap/requestMapper.js';
import {
  CONTENT_TYPE,
  createSoapTransport,
  type SoapFetch,
  type SoapFetchInit,
} from '../../../src/soap/transport.js';
import { REFERENCE_OPTIONS, readFixture } from '../../helpers/requestFixtures.js';
import { attr, childElements, find, parseXml, text } from '../../helpers/xmlRead.js';

const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';
const CURL = readFileSync(new URL('../../../../../docs/Request.txt', import.meta.url), 'utf8');
const FIXTURE = 'sample-request-team.xml';

/** Sanitized values in the fixture (the originals are a personal user ID and an internal IP). */
const SERVICE_USER = 'LOCAL\\dev-user';
const TRANSACTION_ID = '192.0.2.10-00000000-0000-4000-8000-000000000001';
const SEND_TIME = '2023-06-06T01:27:14.430Z';

/** The sample's criteria, as the shared schema would hand them to the mapper. */
const SAMPLE_QUERY: GuestSearchQuery = {
  firstName: 'Dan',
  lastName: 'Revees',
  phone: '2482500555',
  stateOrRegion: 'Gerogia',
  country: 'US',
  memberType: 'PC',
};

const SAMPLE_HEADER = createHeaderContext(
  {
    languageCode: 'en',
    countryCode: 'US',
    channel: 'MSCUI',
    subChannels: ['ATLR3', 'profile'],
    environment: 'int_dc4',
    serviceUser: SERVICE_USER,
    sequence: 1,
  },
  { now: () => new Date(SEND_TIME), requestId: TRANSACTION_ID },
);

const REQUEST_PATH = [EL.envelope, EL.body, EL.searchGuestRequest] as const;
const CRITERIA_PATH = [...REQUEST_PATH, EL.searchCriteria] as const;
const HEADER_PATH = [...REQUEST_PATH, EL.header] as const;

/** The --data '...' payload of the curl command. */
function curlEnvelope(): string {
  const m = /--data '([\s\S]*)'\s*$/.exec(CURL);
  if (m?.[1] === undefined) throw new Error('no --data payload in docs/Request.txt');
  return m[1];
}

/** The curl's --header 'Name: value' pairs, names lower-cased. */
function curlHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of CURL.matchAll(/--header '([^:']+):\s*([^']*)'/g)) {
    out[(m[1] ?? '').toLowerCase()] = m[2] ?? '';
  }
  return out;
}

/** Prefix-free structure: identity, sorted attributes, then leaf text or element children. */
interface Shape {
  readonly id: string;
  readonly attrs: readonly string[];
  readonly text?: string;
  readonly children?: readonly Shape[];
}

function shape(el: Element): Shape {
  const kids = childElements(el);
  const attrs = Array.from(el.attributes)
    .filter((a) => a.namespaceURI !== XMLNS_URI)
    .map((a) => '{' + String(a.namespaceURI) + '}' + String(a.localName) + '=' + a.value)
    .sort();
  const id = '{' + String(el.namespaceURI) + '}' + String(el.localName);
  if (kids.length === 0) return { id, attrs, text: el.textContent ?? '' };
  // Mixed content would hide data from the comparison: only indentation may sit between.
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType !== 1) expect((n.nodeValue ?? '').trim(), id).toBe('');
  }
  return { id, attrs, children: kids.map(shape) };
}

const root = (doc: Document): Element => doc.documentElement as Element;

/** xmlns declarations of an element, in document order. */
const declarations = (el: Element | undefined): [string, string][] =>
  Array.from(el?.attributes ?? [])
    .filter((a) => a.namespaceURI === XMLNS_URI)
    .map((a) => [a.name, a.value]);

const must = (doc: Document, path: readonly El[]): Element => {
  const el = find(doc, path);
  expect(el, path.map((e) => e.local).join('/')).toBeDefined();
  return el as Element;
};

describe('team sample request (docs/Request.txt)', () => {
  it('the fixture is the curl envelope, except the two sanitized attributes', () => {
    const curl = parseXml(curlEnvelope());
    // Overwrite the personal user ID and the internal transaction ID without naming them.
    must(curl, [...HEADER_PATH, EL.headerUser]).setAttribute('id', SERVICE_USER);
    must(curl, [...HEADER_PATH, EL.headerTransactionId]).setAttribute('id', TRANSACTION_ID);
    const fixture = parseXml(readFixture(FIXTURE));
    expect(shape(root(fixture))).toStrictEqual(shape(root(curl)));
    expect(declarations(root(fixture))).toEqual(declarations(root(curl)));
    expect(declarations(find(fixture, REQUEST_PATH))).toEqual(
      declarations(find(curl, REQUEST_PATH)),
    );
  });

  it('the mapper output matches the sample, apart from the blank groups omitted by rule', () => {
    const sample = parseXml(readFixture(FIXTURE));
    const built = parseXml(buildSearchGuestRequest(SAMPLE_QUERY, SAMPLE_HEADER, REFERENCE_OPTIONS));

    // Allowed difference 1: the sample sends an email group with an empty address.
    const email = must(sample, [...CRITERIA_PATH, EL.email]);
    expect(text(find(email, [EL.emailAddress]))).toBe('');
    email.parentNode?.removeChild(email);
    // Allowed difference 2: the sample sends membership/@value="".
    const membership = must(sample, [...CRITERIA_PATH, EL.membership]);
    expect(attr(membership, 'value')).toBe('');
    membership.removeAttribute('value');

    // Everything else is identical: namespace URIs, element order, attributes and values.
    expect(shape(root(built))).toStrictEqual(shape(root(sample)));
    // Same declarations in the same places: soap on the Envelope, the rest on the request.
    expect(declarations(root(built))).toEqual(declarations(root(sample)));
    expect(declarations(find(built, REQUEST_PATH))).toEqual(
      declarations(find(sample, REQUEST_PATH)),
    );
  });

  it('the omitted parts really are absent from the mapper output', () => {
    const built = parseXml(buildSearchGuestRequest(SAMPLE_QUERY, SAMPLE_HEADER, REFERENCE_OPTIONS));
    expect(find(built, [...CRITERIA_PATH, EL.email])).toBeUndefined();
    const membership = must(built, [...CRITERIA_PATH, EL.membership]);
    expect(membership.hasAttributeNS(null, 'value')).toBe(false);
    expect(attr(membership, 'code')).toBe('PC');
  });

  it('the transport sends the sample HTTP headers with the default configuration', async () => {
    const env = {
      SOAP_ENDPOINT: 'http://localhost:8080/InitiateService',
      SOAP_HEADER_LANGUAGE_CODE: 'en',
      SOAP_HEADER_COUNTRY_CODE: 'US',
      SOAP_HEADER_CHANNEL: 'MSCUI',
      SOAP_HEADER_SUB_CHANNEL: 'ATLR3,profile',
      SOAP_HEADER_ENVIRONMENT: 'int_dc4',
      SOAP_HEADER_SERVICE_USER: SERVICE_USER,
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    };
    const cfg = loadConfig(env, new EnvSecretProvider(env)).soap;
    const sent: SoapFetchInit[] = [];
    const fetch: SoapFetch = (_url, init) => {
      sent.push(init);
      return Promise.resolve({ status: 200, headers: { get: () => null }, body: null });
    };
    const breaker = new CircuitBreaker(cfg.breaker);
    await createSoapTransport(cfg, { breaker, fetch }).send('<x/>', { requestId: 'r' });

    const curl = curlHeaders();
    const ours = sent[0]?.headers ?? {};
    expect(Object.keys(ours).sort()).toEqual(Object.keys(curl).sort());
    expect(ours.soapaction).toBe(curl.soapaction); // unquoted, verbatim
    expect(ours['ihg-channelid']).toBe(curl['ihg-channelid']);
    expect(ours.accept).toBe(curl.accept);
    // Same media type; we also declare the charset the envelope is encoded in.
    expect(curl['content-type']).toBe('text/xml');
    expect(ours['content-type']).toBe(CONTENT_TYPE);
    expect(CONTENT_TYPE.split(';')[0]).toBe(curl['content-type']);
  });
});
