/**
 * Markers and expected outcomes for the response fixtures in `test/fixtures/soap/`
 * (task 5.2, design.md "Fixtures"). The same files are mounted by WireMock as `__files`
 * (Req 2.2), so tests and the stub always serve identical bytes.
 */
import type { UpstreamCode } from '../../src/soap/responseParser.js';

/** Synthetic card token in `response-with-cc-token.xml` (text and attribute). Not a card number. */
export const CC_TOKEN_MARKER = 'SYNTH-CC-TOKEN-Q7X4K9M2P5W8';

/** Unique synthetic PII in `response-with-cc-token.xml`, for the log-leak test (Req 25.6). */
export const CC_TOKEN_FIXTURE_PII = {
  enterpriseId: '900000077',
  firstName: 'Leakcheck',
  lastName: 'Markerguest',
  line1: '177 Leakmarker Way',
  phone: '+1 404 555 0177',
  email: 'leakcheck.markerguest@example.test',
  memberId: '900000078',
} as const;

export type FixtureOutcome =
  { readonly guests: number } | { readonly error: UpstreamCode; readonly detail?: string };

/** Every response-side fixture and what `parseSearchGuestResponse` must do with it. */
export const RESPONSE_FIXTURES = {
  'response-single.xml': { guests: 1 },
  'response-multiple.xml': { guests: 3 },
  'response-empty.xml': { guests: 0 },
  'response-repeated-contacts.xml': { guests: 1 },
  'response-no-default.xml': { guests: 1 },
  'response-multiple-defaults.xml': { guests: 1 },
  'response-missing-optional.xml': { guests: 3 },
  'response-odd-prefixes.xml': { guests: 3 },
  'response-default-namespace.xml': { guests: 3 },
  'response-with-cc-token.xml': { guests: 1 },
  'response-60-guests.xml': { guests: 60 },
  'response-failure-status.xml': { error: 'UPSTREAM_TXN_FAILED', detail: '1001' },
  'fault-client.xml': { error: 'UPSTREAM_FAULT', detail: 'soap:Client' },
  'fault-server.xml': { error: 'UPSTREAM_FAULT', detail: 'soap:Server' },
  'malformed-truncated.xml': { error: 'UPSTREAM_MALFORMED' },
  'malformed-proxy-502.html': { error: 'UPSTREAM_MALFORMED' },
  'malformed-dtd.xml': { error: 'UPSTREAM_MALFORMED' },
} as const satisfies Record<string, FixtureOutcome>;

export type ResponseFixture = keyof typeof RESPONSE_FIXTURES;
