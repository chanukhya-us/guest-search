/**
 * The two reference requests behind `test/fixtures/soap/request-*.xml` (task 4.2, Req 25.2,
 * 25.11). Fixed clock, fixed request ID and synthetic data only (`@example.test`,
 * `+1 404 555 01xx`, IDs `9000000xx`), so the envelopes are deterministic.
 */
import { readFileSync } from 'node:fs';
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import { createHeaderContext, type HeaderContext } from '../../src/soap/headerBuilder.js';
import { buildSearchGuestRequest, type MapperOptions } from '../../src/soap/requestMapper.js';

export const FIXTURE_DIR = new URL('../fixtures/soap/', import.meta.url);

export const REFERENCE_HEADER: HeaderContext = createHeaderContext(
  {
    languageCode: 'en',
    countryCode: 'US',
    channel: 'TEST-CHANNEL',
    subChannel: 'TEST-SUBCHANNEL',
    environment: 'local',
    serviceUser: 'svc-test-user',
    sequence: 1,
  },
  {
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    requestId: '00000000-0000-4000-8000-000000000001',
  },
);

/** Default flags (address line 1, city and postal code off) and the default `maxResults`. */
export const REFERENCE_OPTIONS: MapperOptions = {
  maxResults: 50,
  features: { addressLine1: false, city: false, postalCode: false },
};

export const REFERENCE_REQUESTS = {
  'request-name-phone.xml': {
    firstName: 'Avery',
    lastName: 'Testguest',
    phone: '+1 404 555 0101',
  },
  'request-loyalty.xml': {
    loyaltyMemberId: '900000011',
    // Member Type code set is Blocker B4; this is the shared schema's placeholder code.
    memberType: 'PLACEHOLDER',
  },
} as const satisfies Record<string, GuestSearchQuery>;

export type ReferenceFixture = keyof typeof REFERENCE_REQUESTS;

/** Build the compact envelope for a reference request with the real mapper. */
export const buildReference = (name: ReferenceFixture): string =>
  buildSearchGuestRequest(REFERENCE_REQUESTS[name], REFERENCE_HEADER, REFERENCE_OPTIONS);

export const readFixture = (name: string): string =>
  readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
