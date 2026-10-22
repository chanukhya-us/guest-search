// Unit tests for the SOAP header builder (task 3.3, Req 8.1-8.3, 8.6, 8.7).
// Broader header/config coverage is task 3.4.
import { DOMParser, type Element } from '@xmldom/xmldom';
import { create } from 'xmlbuilder2';
import { describe, expect, it } from 'vitest';
import { EnvSecretProvider, loadConfig, type AppConfig } from '../../../src/config.js';
import { EL, HEADER_CREDENTIAL_LOCATION, NS, ORDER, nsUri } from '../../../src/soap/contract.js';
import { appendHeader, createHeaderContext } from '../../../src/soap/headerBuilder.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const FIXED = new Date('2026-10-21T12:00:00.000Z');
const CREDENTIAL = 'synthetic-credential-DO-NOT-EMIT';

const cfg: AppConfig['soap']['header'] = {
  languageCode: 'en',
  countryCode: 'US',
  channel: 'TEST-CHANNEL',
  subChannel: 'TEST-SUB',
  environment: 'local',
  serviceUser: 'svc-test-user',
  sequence: 1,
  credential: CREDENTIAL,
};

const deps = { now: () => FIXED, requestId: REQUEST_ID };

/** Build a parent with xmlbuilder2, append the header, serialize, parse back with xmldom. */
function render(header = createHeaderContext(cfg, deps)): { xml: string; header: Element } {
  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const root = doc.ele(nsUri(EL.soapHeader), 'soap:Header');
  appendHeader(root, header);
  const xml = doc.end();
  const parsed = new DOMParser().parseFromString(xml, 'text/xml');
  const found = parsed.getElementsByTagNameNS(NS.common, EL.header.local);
  expect(found.length).toBe(1);
  return { xml, header: found[0] as Element };
}

const children = (parent: Element): Element[] =>
  Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1);

describe('createHeaderContext', () => {
  it('uses the requestId as transaction ID and the injected clock as timestamp', () => {
    expect(createHeaderContext(cfg, deps)).toEqual({
      transactionId: REQUEST_ID,
      sequence: 1,
      timestamp: '2026-10-21T12:00:00.000Z',
      languageCode: 'en',
      countryCode: 'US',
      channel: 'TEST-CHANNEL',
      subChannel: 'TEST-SUB',
      environment: 'local',
      serviceUser: 'svc-test-user',
    });
  });

  it('formats the timestamp as ISO 8601 UTC xs:dateTime', () => {
    const { timestamp } = createHeaderContext(cfg, {
      ...deps,
      now: () => new Date(Date.UTC(2027, 0, 2, 3, 4, 5, 6)),
    });
    expect(timestamp).toBe('2027-01-02T03:04:05.006Z');
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('takes the sequence from config', () => {
    expect(createHeaderContext({ ...cfg, sequence: 7 }, deps).sequence).toBe(7);
  });

  it('is deterministic for the same clock and requestId', () => {
    expect(createHeaderContext(cfg, deps)).toEqual(createHeaderContext(cfg, deps));
  });

  it('gives each request its own transaction ID (Req 8.1)', () => {
    const ids = ['req-a', 'req-b', 'req-c'];
    const txIds = ids.map((requestId) => createHeaderContext(cfg, { ...deps, requestId }));
    expect(txIds.map((h) => h.transactionId)).toEqual(ids);
  });

  it('reads the clock at call time, not once (Req 8.2)', () => {
    let t = Date.UTC(2026, 9, 21, 12, 0, 0, 0);
    const now = (): Date => new Date((t += 1000));
    const a = createHeaderContext(cfg, { ...deps, now }).timestamp;
    const b = createHeaderContext(cfg, { ...deps, now }).timestamp;
    expect([a, b]).toEqual(['2026-10-21T12:00:01.000Z', '2026-10-21T12:00:02.000Z']);
  });

  it('normalizes a non-UTC clock to UTC', () => {
    const { timestamp } = createHeaderContext(cfg, {
      ...deps,
      now: () => new Date('2026-10-21T14:30:00.000+02:00'),
    });
    expect(timestamp).toBe('2026-10-21T12:30:00.000Z');
  });

  it('takes every value from loadConfig output, with sequence defaulting to 1 (Req 8.3, 8.6)', () => {
    const env = {
      SOAP_ENDPOINT: 'http://localhost:8080/GuestSearchService',
      SOAP_ACTION: 'test-action',
      SOAP_HEADER_LANGUAGE_CODE: 'fr',
      SOAP_HEADER_COUNTRY_CODE: 'CA',
      SOAP_HEADER_CHANNEL: 'cfg-channel',
      SOAP_HEADER_SUB_CHANNEL: 'cfg-sub',
      SOAP_HEADER_ENVIRONMENT: 'cfg-env',
      SOAP_HEADER_SERVICE_USER: 'cfg-user',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    };
    const loaded = loadConfig(env, new EnvSecretProvider(env)).soap.header;
    expect(createHeaderContext(loaded, deps)).toMatchObject({
      sequence: 1,
      languageCode: 'fr',
      countryCode: 'CA',
      channel: 'cfg-channel',
      subChannel: 'cfg-sub',
      environment: 'cfg-env',
      serviceUser: 'cfg-user',
    });
  });

  it('never copies the credential into the context', () => {
    expect(JSON.stringify(createHeaderContext(cfg, deps))).not.toContain(CREDENTIAL);
  });
});

describe('appendHeader', () => {
  it('emits every header child in contract order, by namespace URI, with config values', () => {
    const { header } = render();
    const els = children(header);
    expect(els.map((e) => [e.namespaceURI, e.localName])).toEqual(
      ORDER.header.map((k) => [nsUri(EL[k]), EL[k].local]),
    );
    const text = Object.fromEntries(els.map((e) => [e.localName, e.textContent]));
    expect(text).toEqual({
      [EL.headerTransactionId.local]: REQUEST_ID,
      [EL.headerSequence.local]: '1',
      [EL.headerTimestamp.local]: '2026-10-21T12:00:00.000Z',
      [EL.headerLanguageCode.local]: 'en',
      [EL.headerCountryCode.local]: 'US',
      [EL.headerChannel.local]: 'TEST-CHANNEL',
      [EL.headerSubChannel.local]: 'TEST-SUB',
      [EL.headerEnvironment.local]: 'local',
      [EL.headerServiceUser.local]: 'svc-test-user',
    });
  });

  it('places the header in the common namespace under its parent', () => {
    const { header } = render();
    expect(header.namespaceURI).toBe(NS.common);
    expect(header.parentNode).toMatchObject({ namespaceURI: NS.soap, localName: 'Header' });
  });

  it('escapes config values through xmlbuilder2', () => {
    const h = { ...createHeaderContext(cfg, deps), channel: 'a<b>&"c\'' };
    const { xml, header } = render(h);
    expect(xml).not.toContain('a<b>');
    const channel = children(header).find((e) => e.localName === EL.headerChannel.local);
    expect(channel?.textContent).toBe('a<b>&"c\'');
  });

  it('is byte-identical for the same clock and requestId', () => {
    expect(render().xml).toBe(render().xml);
  });

  it('never emits the credential while the contract defines no location (B5/B6)', () => {
    expect(HEADER_CREDENTIAL_LOCATION).toBeNull();
    // Even a context smuggling the credential through an extra property must not leak it.
    const smuggled = { ...createHeaderContext(cfg, deps), credential: CREDENTIAL };
    expect(render(smuggled).xml).not.toContain(CREDENTIAL);
    expect(render().xml).not.toContain(CREDENTIAL);
  });
});
