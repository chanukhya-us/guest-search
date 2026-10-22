/**
 * Request-mapper query cases shared by the 4.3 unit tests (`test/unit/soap/requestMapper.test.ts`)
 * and the XSD harness (`test/xsd/requestXsd.test.ts`, task 4.5, Req 25.7), so the XSD test
 * validates exactly the envelopes the unit tests generate. Synthetic data only.
 */
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import { EL, ORDER, type El } from '../../src/soap/contract.js';
import { buildSearchGuestRequest, type MapperOptions } from '../../src/soap/requestMapper.js';
import {
  REFERENCE_HEADER,
  REFERENCE_OPTIONS,
  REFERENCE_REQUESTS,
  buildReference,
  type ReferenceFixture,
} from './requestFixtures.js';

export type Field = keyof GuestSearchQuery;
export type GroupKey = (typeof ORDER.searchCriteria)[number];

export const FLAGS_OFF: MapperOptions = REFERENCE_OPTIONS;
export const FLAGS_ON: MapperOptions = {
  ...REFERENCE_OPTIONS,
  features: { addressLine1: true, city: true, postalCode: true },
};

/** Every mapped field, synthetic data only. Address Line 2 is supplied to prove it is dropped. */
export const COMBINED = {
  firstName: 'Avery',
  lastName: 'Testguest',
  phone: '+1 404 555 0102',
  email: 'guest02@example.test',
  addressLine1: '1 Test Street',
  city: 'Atlanta',
  stateOrRegion: 'GA',
  postalCode: '30301',
  country: 'US',
  memberType: 'PLACEHOLDER',
  loyaltyMemberId: '900000012',
} as const satisfies GuestSearchQuery;
export const LINE2 = 'LINE2-MUST-NOT-APPEAR';

/** Which query fields each criteria group reads. */
export const GROUP_FIELDS: Record<GroupKey, readonly Field[]> = {
  name: ['firstName', 'lastName'],
  phone: ['phone'],
  email: ['email'],
  address: ['addressLine1', 'city', 'stateOrRegion', 'postalCode', 'country'],
  membership: ['memberType', 'loyaltyMemberId'],
};

/** Field-mapping cases (Req 9.3, 9.7-9.11): label, query, expected groups. Built with FLAGS_ON. */
export const FIELD_CASES: [string, GuestSearchQuery, GroupKey[]][] = [
  ['first name only', { firstName: 'Avery' }, ['name']],
  ['last name only', { lastName: 'Testguest' }, ['name']],
  ['first and last name', { firstName: 'Avery', lastName: 'Testguest' }, ['name']],
  ['phone only', { phone: '+1 404 555 0103' }, ['phone']],
  ['email only', { email: 'guest03@example.test' }, ['email']],
  ['state and country', { stateOrRegion: 'GA', country: 'US' }, ['address']],
  [
    'Loyalty Member ID and Member Type',
    { loyaltyMemberId: '900000013', memberType: 'PLACEHOLDER' },
    ['membership'],
  ],
  ['Loyalty Member ID only', { loyaltyMemberId: '900000014' }, ['membership']],
  ['Member Type only', { memberType: 'PLACEHOLDER' }, ['membership']],
  ['combined multi-attribute search', COMBINED, [...ORDER.searchCriteria]],
];

/** Address feature flags (Req 9.4): flag, the query field it gates, the element it emits. */
export const FLAGGED: [keyof MapperOptions['features'], Field, El][] = [
  ['addressLine1', 'addressLine1', EL.line1],
  ['city', 'city', EL.locality1],
  ['postalCode', 'postalCode', EL.postalCode],
];

/** `maxResults` values exercised by the mapper tests. */
export const MAX_RESULTS_CASES = [1, 25, 50, 200] as const;

export const omit = (q: GuestSearchQuery, fields: readonly Field[]): GuestSearchQuery =>
  Object.fromEntries(Object.entries(q).filter(([k]) => !fields.includes(k as Field)));

/** Options with exactly one address flag on. */
export const withOnlyFlag = (flag: keyof MapperOptions['features']): MapperOptions => ({
  ...FLAGS_OFF,
  features: { ...FLAGS_OFF.features, [flag]: true },
});

export interface EnvelopeCase {
  readonly name: string;
  readonly xml: string;
}

const envelope = (name: string, q: GuestSearchQuery, o: MapperOptions): EnvelopeCase => ({
  name,
  xml: buildSearchGuestRequest(q, REFERENCE_HEADER, o),
});

/**
 * Every schema-meaningful envelope the 4.3 tests generate, for XSD validation (Req 25.7).
 *
 * Deliberately excluded, because they are not requests the BFF can send:
 *   - the empty and all-blank queries: the shared schema rejects a query with no criterion
 *     (Req 4.4) before the mapper runs;
 *   - the escaping, illegal-character and reference-like-text cases: hostile values that test
 *     serialization, which real XSD facets (lengths, patterns) are expected to reject;
 *   - the purity case: it rebuilds COMBINED, which is already covered.
 */
export function requestEnvelopeCases(): EnvelopeCase[] {
  const flagLabel = (o: MapperOptions): string => (o === FLAGS_ON ? 'flags on' : 'flags off');
  return [
    ...FIELD_CASES.map(([label, q]) => envelope('field: ' + label, q, FLAGS_ON)),
    ...ORDER.searchCriteria.map((g) =>
      envelope('omission: all but ' + g, omit(COMBINED, GROUP_FIELDS[g]), FLAGS_ON),
    ),
    ...[FLAGS_OFF, FLAGS_ON].flatMap((o) => [
      envelope('combined, ' + flagLabel(o), COMBINED, o),
      envelope(
        'combined with Address Line 2, ' + flagLabel(o),
        { ...COMBINED, addressLine2: LINE2 },
        o,
      ),
    ]),
    ...FLAGGED.flatMap(([flag, field]) => [
      envelope('flag ' + flag + ' only, combined', COMBINED, withOnlyFlag(flag)),
      envelope(
        'flag ' + flag + ' only, field alone',
        { [field]: COMBINED[field as keyof typeof COMBINED] },
        withOnlyFlag(flag),
      ),
    ]),
    ...MAX_RESULTS_CASES.map((n) =>
      envelope(
        'maxResults ' + String(n),
        { lastName: 'Testguest' },
        { ...FLAGS_OFF, maxResults: n },
      ),
    ),
    ...(Object.keys(REFERENCE_REQUESTS) as ReferenceFixture[]).map((name) => ({
      name: 'reference ' + name,
      xml: buildReference(name),
    })),
  ];
}
