/**
 * SOAP contract for `searchGuestRequest` (Req 7). This is the ONLY module in the BFF that may
 * contain SOAP namespace URIs, fixed attribute values or status codes (Req 7.6). The request
 * mapper, header builder and response parser obtain every element identity from `EL` (Req 7.4).
 *
 * PARTLY VERIFIED CONTRACT (Req 7.5).
 *   - Request side: the project team's only real sample request, `docs/Request.txt` (a curl
 *     command), is the source of truth until B1 arrives. Every element that appears in it is
 *     `verified: true, xsd: 'sample:docs/Request.txt'`: envelope, body, the in-body `header`
 *     and its children, searchCriteria and its groups, allAttributes, allHistory, maxResults.
 *     `line1`, `locality1` and `postalCode` are NOT in the sample; their placement (complex,
 *     like `region1`/`country`) is inferred, so they stay `verified: false`.
 *   - Response side: there is no response sample. The `guest*` identities mirror the request
 *     sample (groups in initiate, their children in complex) and stay `verified: false`.
 *   - Still open: B1 (WSDL + XSDs: order, cardinality, types), B2 for the response
 *     (`transactionStatus` placement, guest children), B3 (request validity of `line1`,
 *     `locality1`, `postalCode`; Address Line 2 is never invented, Req 9.6) and B5/B6 (the
 *     credential has no location).
 * The namespace URIs and the alias table match copilot-instructions.md §5 and the sample.
 *
 * How to verify an element once B1 arrives:
 *   1. Find the global element (or the complexType holding it as a local element) in the
 *      XSD whose `targetNamespace` equals `NS[el.ns]`.
 *   2. Local elements are namespace-qualified only if the schema has
 *      `elementFormDefault="qualified"` (or `form="qualified"`); otherwise set `ns: null`.
 *   3. Check the request type and the response type separately: an element valid in a
 *      response type is not automatically valid in the request type (hence the separate
 *      `guest*` response entries below).
 *   4. Check the parent's `xs:sequence` and update `ORDER` to match it (Req 9.13).
 *   5. Set `verified: true` and `xsd: '<file>.xsd#<type or element>'` on the entry.
 *   6. Run the XSD validation tests (`apps/bff/test/xsd/`), which stop skipping once
 *      the schemas are present.
 */

/** Namespace URIs (Req 7.1, copilot-instructions.md §5). */
export const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  common: 'http://atp.ihg.com/schema/common/ATPCommonServiceTypes/v1',
  initiate: 'http://crm.ihg.com/schema/v1_0/initiate',
  complex: 'http://common.crm.ihg.com/schema/v1_0/complex',
  svc: 'http://atp.ihg.com/schema/crs/initiate/servicetypes/v1',
  basic: 'http://common.crm.ihg.com/schema/v1_0/basictypes',
} as const;

export type NsKey = keyof typeof NS;

/**
 * Prefixes used when BUILDING requests, matching the approved sample. They are aliases only:
 * the parser never matches on them (Req 11.4). `''` means the default namespace.
 */
export const PREFIX: Record<NsKey, string> = {
  soap: 'soap',
  common: '',
  initiate: 'ns2',
  complex: 'ns3',
  svc: 'ns4',
  basic: 'ns5',
};

/**
 * Element identity. `ns: null` means an unqualified (no-namespace) element, for example the
 * SOAP 1.1 `faultcode`. `verified` flips to true once checked against the XSD (Req 7.5).
 */
export interface El {
  readonly ns: NsKey | null;
  readonly local: string;
  readonly verified: boolean;
  readonly xsd?: string;
}

/** An identity whose placement is inferred, not yet confirmed by the XSD or a sample. */
const el = (ns: NsKey | null, local: string): El => ({ ns, local, verified: false });

/** Where the sample-confirmed identities come from (`El.xsd`). */
export const SAMPLE_SOURCE = 'sample:docs/Request.txt';

/** An identity confirmed by the team's sample request (docs/Request.txt). */
const sample = (ns: NsKey, local: string): El => ({
  ns,
  local,
  verified: true,
  xsd: SAMPLE_SOURCE,
});

/** Namespace URI of an element, or `null` when it is unqualified (as xmldom reports it). */
export const nsUri = (e: El): string | null => (e.ns === null ? null : NS[e.ns]);

export const EL = {
  // SOAP 1.1 envelope. The sample has no soap:Header. Per SOAP 1.1, Fault children are
  // unqualified.
  envelope: sample('soap', 'Envelope'),
  body: sample('soap', 'Body'),
  fault: el('soap', 'Fault'),
  faultcode: el(null, 'faultcode'),

  // Request: searchGuestRequest (all from the sample except line1, locality1, postalCode).
  searchGuestRequest: sample('svc', 'searchGuestRequest'),
  searchCriteria: sample('svc', 'searchCriteria'),
  name: sample('initiate', 'name'),
  given: sample('complex', 'given'),
  surname: sample('complex', 'surname'),
  phone: sample('initiate', 'phone'),
  email: sample('initiate', 'email'),
  // Same identity as `address` (both initiate:address); told apart by their parent.
  emailAddress: sample('initiate', 'address'),
  address: sample('initiate', 'address'),
  source: sample('complex', 'source'),
  line1: el('complex', 'line1'),
  locality1: el('complex', 'locality1'),
  region1: sample('complex', 'region1'),
  postalCode: el('complex', 'postalCode'),
  country: sample('complex', 'country'),
  membership: sample('initiate', 'membership'),
  allAttributes: sample('svc', 'allAttributes'),
  allHistory: sample('svc', 'allHistory'),
  maxResults: sample('svc', 'maxResults'),

  // Request header: the FIRST child of searchGuestRequest, in common (the default
  // namespace). Every value is an attribute except sendTimeStamp, which is text.
  // No credential element exists until B5/B6 define one (see HEADER_CREDENTIAL_LOCATION).
  header: sample('common', 'header'),
  headerLanguage: sample('common', 'language'),
  headerChannel: sample('common', 'channel'),
  // Nested: channel > subChannel > subChannel ... (one per configured subchannel).
  headerSubChannel: sample('common', 'subChannel'),
  headerVersion: sample('common', 'headerVersion'),
  headerEnvironment: sample('common', 'environment'),
  // The configured service user (not a personal ID), in user/@id.
  headerUser: sample('common', 'user'),
  headerTransactionId: sample('common', 'transactionId'),
  headerTransactionSequence: sample('common', 'transactionSequence'),
  headerSendTimeStamp: sample('common', 'sendTimeStamp'),

  // Response: searchGuestResponse. No response sample exists: every entry is unverified.
  searchGuestResponse: el('svc', 'searchGuestResponse'),
  transactionStatus: el('common', 'transactionStatus'),
  initiateGuest: el('initiate', 'initiateGuest'),
  enterpriseId: el('initiate', 'enterpriseId'),
  // Children of initiateGuest: mirrors request sample; confirm with response sample.
  // Kept separate from the request entries because the response type may differ.
  guestName: el('initiate', 'name'),
  guestGiven: el('complex', 'given'),
  guestSurname: el('complex', 'surname'),
  guestAddress: el('initiate', 'address'),
  guestAddressSource: el('complex', 'source'),
  guestLine1: el('complex', 'line1'),
  guestLocality1: el('complex', 'locality1'),
  guestRegion1: el('complex', 'region1'),
  guestPostalCode: el('complex', 'postalCode'),
  guestCountry: el('complex', 'country'),
  guestPhone: el('initiate', 'phone'),
  guestEmail: el('initiate', 'email'),
  guestEmailAddress: el('initiate', 'address'),
  guestMembership: el('initiate', 'membership'),
} as const satisfies Record<string, El>;

export type ElKey = keyof typeof EL;

/** Child order (Req 9.13), as in the sample request. */
export const ORDER = {
  searchCriteria: ['name', 'phone', 'email', 'address', 'membership'],
  searchGuestRequest: ['header', 'searchCriteria', 'allAttributes', 'allHistory', 'maxResults'],
  // headerSubChannel is nested inside headerChannel, so it is not a direct header child.
  header: [
    'headerLanguage',
    'headerChannel',
    'headerVersion',
    'headerEnvironment',
    'headerUser',
    'headerTransactionId',
    'headerTransactionSequence',
    'headerSendTimeStamp',
  ],
} as const satisfies Record<string, readonly ElKey[]>;

/**
 * Where the service credential goes in the request (Blockers B5/B6: WS-Security, Basic or
 * mTLS is undecided). `null` means the contract defines no location, so the header builder
 * never emits the credential. Set an `El` here only once the contract defines it.
 */
export const HEADER_CREDENTIAL_LOCATION: El | null = null;

/** Qualified name for building: `prefix:local`, or `local` for the default/no namespace. */
export const qname = (e: El): string => {
  const prefix = e.ns === null ? '' : PREFIX[e.ns];
  return prefix === '' ? e.local : prefix + ':' + e.local;
};

/** Request defaults from the approved sample (Req 7.2). `maxResults` comes from config (default 50). */
export const DEFAULTS = {
  criteriaStatus: 'O',
  phoneLocation: 'H',
  phoneProfileDefault: 'true',
  emailProfileDefault: 'true',
  addressLocationCode: 'H',
  addressProfileDefault: 'true',
  allAttributes: 'true',
  allHistory: 'false',
  // header/headerVersion/@major and @minor (sample: 1.0).
  headerVersionMajor: '1',
  headerVersionMinor: '0',
} as const;

/** Application-level success indicators on transactionStatus (Req 7.3). */
export const SUCCESS = { transactionSuccessful: 'true', overallStatusCode: '0000' } as const;

/** Domain allowlist: response attributes/elements the parser may read (Req 12.10). */
export const ALLOW = {
  guestAttrs: ['score', 'status', 'gender'],
  phoneAttrs: ['number', 'type', 'location', 'profileDefault'],
  emailAttrs: ['profileDefault'],
  addressAttrs: ['locationCode', 'profileDefault'],
  membershipAttrs: ['code', 'value', 'status'],
  childElements: ['enterpriseId', 'name', 'address', 'phone', 'email', 'membership'],
} as const;
