// Unit tests for the SOAP header builder (task 3.3, Req 8.1-8.3, 8.6, 8.7). The header shape
// is the team's sample request (docs/Request.txt): attributes on `common` elements, a nested
// subChannel chain, and sendTimeStamp as the only text value.
import { DOMParser, type Element } from '@xmldom/xmldom';
import { create } from 'xmlbuilder2';
import { describe, expect, it } from 'vitest';
import { EnvSecretProvider, loadConfig, type AppConfig } from '../../../src/config.js';
import {
  DEFAULTS,
  EL,
  HEADER_CREDENTIAL_LOCATION,
  NS,
  ORDER,
  nsUri,
  qname,
} from '../../../src/soap/contract.js';
import {
  appendHeader,
  createHeaderContext,
  type HeaderContext,
} from '../../../src/soap/headerBuilder.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const FIXED = new Date('2026-10-21T12:00:00.000Z');
const CREDENTIAL = 'synthetic-credential-DO-NOT-EMIT';

const cfg: AppConfig['soap']['header'] = {
  languageCode: 'en',
  countryCode: 'US',
  channel: 'TEST-CHANNEL',
  subChannels: ['TEST-SUB', 'TEST-LEAF'],
  environment: 'local',
  serviceUser: 'svc-test-user',
  sequence: 1,
  credential: CREDENTIAL,
};

const deps = { now: () => FIXED, requestId: REQUEST_ID };

/** Build a parent with xmlbuilder2, append the header, serialize, parse back with xmldom. */
function render(header: HeaderContext = createHeaderContext(cfg, deps)): {
  xml: string;
  header: Element;
} {
  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const root = doc.ele(nsUri(EL.searchGuestRequest), qname(EL.searchGuestRequest));
  appendHeader(root, header);
  const xml = doc.end();
  const parsed = new DOMParser().parseFromString(xml, 'text/xml');
  const found = parsed.getElementsByTagNameNS(NS.common, EL.header.local);
  expect(found.length).toBe(1);
  return { xml, header: found[0] as Element };
}

const children = (parent: Element): Element[] =>
  Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1);

/** Unqualified attributes of an element as a plain object. */
const attrs = (e: Element): Record<string, string> =>
  Object.fromEntries(
    Array.from(e.attributes)
      .filter((a) => a.namespaceURI === null)
      .map((a) => [a.localName ?? a.name, a.value]),
  );

const child = (header: Element, local: string): Element => {
  const found = children(header).find((e) => e.localName === local);
  expect(found, local).toBeDefined();
  return found as Element;
};

/** Names along the channel > subChannel > subChannel ... chain. */
function channelChain(header: Element): string[] {
  const out: string[] = [];
  let level: Element | undefined = child(header, EL.headerChannel.local);
  while (level !== undefined) {
    out.push(level.getAttribute('name') ?? '');
    const next: Element[] = children(level);
    expect(next.length).toBeLessThanOrEqual(1);
    if (next[0] !== undefined) {
      expect([next[0].namespaceURI, next[0].localName]).toEqual([
        NS.common,
        EL.headerSubChannel.local,
      ]);
    }
    level = next[0];
  }
  return out;
}

describe('createHeaderContext', () => {
  it('uses the requestId as transaction ID and the injected clock as timestamp', () => {
    expect(createHeaderContext(cfg, deps)).toEqual({
      transactionId: REQUEST_ID,
      sequence: 1,
      timestamp: '2026-10-21T12:00:00.000Z',
      languageCode: 'en',
      countryCode: 'US',
      channel: 'TEST-CHANNEL',
      subChannels: ['TEST-SUB', 'TEST-LEAF'],
      environment: 'local',
      serviceUser: 'svc-test-user',
    });
  });

  it('copies the subchannel list, so later config changes cannot alter the context', () => {
    const list = ['A', 'B'];
    const h = createHeaderContext({ ...cfg, subChannels: list }, deps);
    list.push('C');
    expect(h.subChannels).toEqual(['A', 'B']);
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
      SOAP_ENDPOINT: 'http://localhost:8080/InitiateService',
      SOAP_HEADER_LANGUAGE_CODE: 'fr',
      SOAP_HEADER_COUNTRY_CODE: 'CA',
      SOAP_HEADER_CHANNEL: 'cfg-channel',
      SOAP_HEADER_SUB_CHANNEL: 'cfg-sub,cfg-leaf',
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
      subChannels: ['cfg-sub', 'cfg-leaf'],
      environment: 'cfg-env',
      serviceUser: 'cfg-user',
    });
  });

  it('never copies the credential into the context', () => {
    expect(JSON.stringify(createHeaderContext(cfg, deps))).not.toContain(CREDENTIAL);
  });
});

describe('appendHeader', () => {
  it('emits every header child in sample order, in the common namespace', () => {
    const { header } = render();
    expect(children(header).map((e) => [e.namespaceURI, e.localName])).toEqual(
      ORDER.header.map((k) => [nsUri(EL[k]), EL[k].local]),
    );
    expect(ORDER.header.map((k) => EL[k].local)).toEqual([
      'language',
      'channel',
      'headerVersion',
      'environment',
      'user',
      'transactionId',
      'transactionSequence',
      'sendTimeStamp',
    ]);
  });

  it('writes every value as the sample attribute, and the timestamp as text', () => {
    const { header } = render();
    const attrsOf = (local: string) => attrs(child(header, local));
    expect(attrsOf('language')).toEqual({ isoCountryCode: 'US', isoLanguageCode: 'en' });
    expect(attrsOf('channel')).toEqual({ name: 'TEST-CHANNEL' });
    expect(attrsOf('headerVersion')).toEqual({
      major: DEFAULTS.headerVersionMajor,
      minor: DEFAULTS.headerVersionMinor,
    });
    expect([DEFAULTS.headerVersionMajor, DEFAULTS.headerVersionMinor]).toEqual(['1', '0']);
    expect(attrsOf('environment')).toEqual({ name: 'local' });
    expect(attrsOf('user')).toEqual({ id: 'svc-test-user' });
    expect(attrsOf('transactionId')).toEqual({ id: REQUEST_ID });
    expect(attrsOf('transactionSequence')).toEqual({ number: '1' });
    const ts = child(header, 'sendTimeStamp');
    expect(attrs(ts)).toEqual({});
    expect(ts.textContent).toBe('2026-10-21T12:00:00.000Z');
    // Only sendTimeStamp has content; subChannel nesting is checked separately.
    for (const e of children(header)) {
      if (e.localName !== 'sendTimeStamp' && e.localName !== 'channel') {
        expect(e.childNodes.length, String(e.localName)).toBe(0);
      }
    }
  });

  it.each([
    [[], ['C']],
    [['ATLR3'], ['C', 'ATLR3']],
    [
      ['ATLR3', 'profile'],
      ['C', 'ATLR3', 'profile'],
    ],
    [
      ['a', 'b', 'c'],
      ['C', 'a', 'b', 'c'],
    ],
  ])('nests subchannels %j inside the channel, in order', (subChannels, chain) => {
    const h = { ...createHeaderContext(cfg, deps), channel: 'C', subChannels };
    expect(channelChain(render(h).header)).toEqual(chain);
  });

  it('places the header in the common namespace under its parent', () => {
    const { header } = render();
    expect(header.namespaceURI).toBe(NS.common);
    expect(header.parentNode).toMatchObject({
      namespaceURI: NS.svc,
      localName: EL.searchGuestRequest.local,
    });
  });

  it('escapes config values through xmlbuilder2, in attributes and text', () => {
    const tricky = 'a<b>&"c\'&amp;';
    const h = {
      ...createHeaderContext(cfg, deps),
      channel: tricky,
      subChannels: [tricky],
      serviceUser: 'LOCAL\\' + tricky,
      timestamp: tricky,
    };
    const { xml, header } = render(h);
    expect(xml).not.toContain('a<b>');
    expect(child(header, 'channel').getAttribute('name')).toBe(tricky);
    expect(channelChain(header)).toEqual([tricky, tricky]);
    expect(child(header, 'user').getAttribute('id')).toBe('LOCAL\\' + tricky);
    expect(child(header, 'sendTimeStamp').textContent).toBe(tricky);
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
