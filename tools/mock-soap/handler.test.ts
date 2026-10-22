/**
 * Dev-tooling test for the local Node mock SOAP server (task 13.1).
 *
 * Verifies the mock end to end WITHOUT leaving a long-running server in the suite:
 *   1. The handler builds real request envelopes (via the BFF request mapper + header builder),
 *      feeds them through `handleRequest`, and the output parses via the BFF's
 *      `parseSearchGuestResponse` into guests.
 *   2. A filtered query (lastName) narrows the result set.
 *   3. The empty and fault magic inputs behave (empty-but-successful; SOAP Fault → UPSTREAM_FAULT).
 *   4. The HTTP server boots on an ephemeral port, round-trips one request, then closes.
 *
 * The mock core is a pure function, so (1)–(3) need no socket; only (4) binds a port, briefly.
 * This test lives with the tool (runs in the Vitest `tools` project) and imports the BFF SOAP
 * source directly to prove the contract holds against the real parser.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { GuestSearchQuery } from '@ihg-guest-search/shared';

import { createHeaderContext } from '../../apps/bff/src/soap/headerBuilder.js';
import {
  buildSearchGuestRequest,
  type MapperOptions,
} from '../../apps/bff/src/soap/requestMapper.js';
import { parseSearchGuestResponse, SoapError } from '../../apps/bff/src/soap/responseParser.js';

import { buildResponseXml, filterSeed, handleRequest, parseCriteria } from './handler.ts';
import { SEED, SEED_SIZE } from './seed.ts';
import { startMockServer } from './server.ts';

const HEADER = createHeaderContext(
  {
    languageCode: 'en',
    countryCode: 'US',
    channel: 'TEST-CHANNEL',
    subChannels: ['TEST-SUBCHANNEL'],
    environment: 'local',
    serviceUser: 'svc-test-user',
    sequence: 1,
  },
  { now: () => new Date('2026-10-21T12:00:00.000Z'), requestId: 'test-request-id' },
);

const OPTIONS: MapperOptions = {
  maxResults: SEED_SIZE,
  features: { addressLine1: false, city: false, postalCode: false },
};

/** Build an authentic searchGuestRequest envelope with the real mapper. */
const request = (q: GuestSearchQuery): string => buildSearchGuestRequest(q, HEADER, OPTIONS);

describe('mock-soap handler', () => {
  it('parseCriteria reads the mapped criteria from a real request envelope', () => {
    const xml = request({ firstName: 'Avery', lastName: 'Anderson', phone: '+1 404 555 0101' });
    const c = parseCriteria(xml);
    expect(c.firstName).toBe('Avery');
    expect(c.lastName).toBe('Anderson');
    expect(c.phone).toBe('+1 404 555 0101');
    expect(c.maxResults).toBe(SEED_SIZE);
  });

  it('produces a response the BFF parser accepts, into guests', () => {
    const xml = request({ country: 'US' });
    const result = handleRequest(xml);
    expect(result.status).toBe(200);

    const guests = parseSearchGuestResponse(result.xml);
    expect(guests.length).toBeGreaterThan(0);
    expect(guests.length).toBe(result.count);
    const first = guests[0];
    expect(first?.enterpriseId).toMatch(/^9000000\d\d$/);
    expect(first?.phones[0]?.number).toMatch(/^\+1 404 555 01\d\d$/);
    expect(first?.emails[0]?.address).toMatch(/@example\.test$/);
  });

  it('sorts guests by score descending', () => {
    const guests = parseSearchGuestResponse(handleRequest(request({ country: 'US' })).xml);
    const scores = guests.map((g) => g.score ?? -Infinity);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });

  it('a filtered query narrows the set', () => {
    const all = parseSearchGuestResponse(handleRequest(request({ country: 'US' })).xml);
    const target = SEED[0]?.lastName ?? 'Anderson';
    const expected = SEED.filter((g) => g.lastName === target).length;

    const narrowed = parseSearchGuestResponse(handleRequest(request({ lastName: target })).xml);
    expect(narrowed.length).toBe(expected);
    expect(narrowed.length).toBeLessThan(all.length);
    expect(narrowed.every((g) => g.lastName === target)).toBe(true);
  });

  it('filterSeed respects maxResults', () => {
    expect(filterSeed({ maxResults: 5 }).length).toBe(5);
  });

  it('magic "nomatch" is empty but successful', () => {
    const result = handleRequest(request({ lastName: 'nomatch' }));
    expect(result.status).toBe(200);
    expect(result.magic).toBe('nomatch');
    expect(parseSearchGuestResponse(result.xml)).toEqual([]);
  });

  it('magic "fault" yields a SOAP Fault the parser maps to UPSTREAM_FAULT', () => {
    const result = handleRequest(request({ lastName: 'fault' }));
    expect(result.status).toBe(500);
    expect(result.magic).toBe('fault');
    expect(() => parseSearchGuestResponse(result.xml)).toThrow(SoapError);
    try {
      parseSearchGuestResponse(result.xml);
    } catch (e) {
      expect((e as SoapError).code).toBe('UPSTREAM_FAULT');
    }
  });

  it('magic "boom"/"many" returns all seed guests (capped at maxResults)', () => {
    for (const surname of ['boom', 'many']) {
      const result = handleRequest(request({ lastName: surname }));
      expect(result.magic).toBe('boom');
      expect(parseSearchGuestResponse(result.xml).length).toBe(SEED_SIZE);
    }
  });

  it('escapes XML special characters in synthetic values', () => {
    const base = SEED[0];
    if (base === undefined) throw new Error('seed is empty');
    const guest = { ...base, firstName: 'A & B <x>', lastName: '"Quote\'s"' };
    const guests = parseSearchGuestResponse(buildResponseXml([guest]));
    expect(guests[0]?.firstName).toBe('A & B <x>');
    expect(guests[0]?.lastName).toBe('"Quote\'s"');
  });
});

describe('mock-soap http server (ephemeral round trip)', () => {
  let close: (() => Promise<void>) | undefined;

  afterAll(async () => {
    if (close !== undefined) await close();
  });

  it('boots, answers one POST and closes', async () => {
    const started = await startMockServer({ port: 0, host: '127.0.0.1' });
    close = started.close;

    const response = await fetch(`http://127.0.0.1:${started.port}/InitiateService`, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8' },
      body: request({ country: 'US' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/xml');

    const guests = parseSearchGuestResponse(await response.text());
    expect(guests.length).toBeGreaterThan(0);
  });

  it('answers GET /health with 200', async () => {
    const started = await startMockServer({ port: 0, host: '127.0.0.1' });
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
    } finally {
      await started.close();
    }
  });
});
