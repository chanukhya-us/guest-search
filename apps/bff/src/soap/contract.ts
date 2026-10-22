/**
 * SOAP contract for `searchGuestRequest` (Req 7). This is the ONLY module in the BFF that may
 * contain SOAP namespace URIs, fixed attribute values or status codes (Req 7.6). The request
 * mapper, header builder and response parser obtain every element identity from `EL` (Req 7.4).
 *
 * PROVISIONAL CONTRACT. Every `EL` entry has `verified: false` (Req 7.5) because the
 * source-of-truth artifacts are not supplied yet:
 *   - B1: WSDL + XSDs (`/schemas`). Element names, namespaces, order, cardinality, types.
 *   - B2: sanitized request/response samples (`/samples`). Namespace aliases, header shape,
 *         `transactionStatus` examples. Header child elements (`header*` entries) are
 *         provisional names; the credential has no location until B5/B6 define one.
 *   - B3: approved mapping doc (`/docs`). Request validity of `line1`, `locality1` and
 *         `postalCode`; the Address Line 2 element (never invented, see Req 9.6).
 * The namespace URIs and the alias table come from copilot-instructions.md §5 (approved
 * sample); the placement of each element in a namespace is inferred and unconfirmed.
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

const el = (ns: NsKey | null, local: string): El => ({ ns, local, verified: false });

/** Namespace URI of an element, or `null` when it is unqualified (as xmldom reports it). */
export const nsUri = (e: El): string | null => (e.ns === null ? null : NS[e.ns]);

export const EL = {
  // SOAP 1.1 envelope. Per SOAP 1.1, Fault children are unqualified.
  envelope: el('soap', 'Envelope'),
  soapHeader: el('soap', 'Header'),
  body: el('soap', 'Body'),
  fault: el('soap', 'Fault'),
  faultcode: el(null, 'faultcode'),

  // Request: searchGuestRequest
  searchGuestRequest: el('svc', 'searchGuestRequest'),
  searchCriteria: el('svc', 'searchCriteria'),
  name: el('complex', 'name'),
  given: el('basic', 'given'),
  surname: el('basic', 'surname'),
  phone: el('complex', 'phone'),
  email: el('complex', 'email'),
  emailAddress: el('basic', 'address'),
  address: el('complex', 'address'),
  source: el('complex', 'source'),
  line1: el('basic', 'line1'),
  locality1: el('basic', 'locality1'),
  region1: el('basic', 'region1'),
  postalCode: el('basic', 'postalCode'),
  country: el('basic', 'country'),
  membership: el('complex', 'membership'),
  allAttributes: el('svc', 'allAttributes'),
  allHistory: el('svc', 'allHistory'),
  maxResults: el('svc', 'maxResults'),

  // Response: searchGuestResponse
  searchGuestResponse: el('svc', 'searchGuestResponse'),
  transactionStatus: el('common', 'transactionStatus'),
  initiateGuest: el('initiate', 'initiateGuest'),
  enterpriseId: el('initiate', 'enterpriseId'),
  // Children of initiateGuest. Kept separate from the request entries because the response
  // type may place them differently; placement mirrors the request until B1/B2.
  guestName: el('complex', 'name'),
  guestGiven: el('basic', 'given'),
  guestSurname: el('basic', 'surname'),
  guestAddress: el('complex', 'address'),
  guestAddressSource: el('complex', 'source'),
  guestLine1: el('basic', 'line1'),
  guestLocality1: el('basic', 'locality1'),
  guestRegion1: el('basic', 'region1'),
  guestPostalCode: el('basic', 'postalCode'),
  guestCountry: el('basic', 'country'),
  guestPhone: el('complex', 'phone'),
  guestEmail: el('complex', 'email'),
  guestEmailAddress: el('basic', 'address'),
  guestMembership: el('complex', 'membership'),

  // Header container (name provisional until sample/XSD; Blocker B2).
  header: el('common', 'header'),
  // Header children. Blocker B2: provisional, replace from sample.
  // copilot-instructions.md §6 lists the header VALUES (language and country code, channel,
  // subchannel, environment, service user, transaction ID, sequence, send timestamp) but not
  // their element names, structure or namespace. The local names below mirror the
  // HeaderContext fields; namespace `common` is assumed. No credential element exists until
  // B5/B6 define one (see HEADER_CREDENTIAL_LOCATION).
  headerTransactionId: el('common', 'transactionId'),
  headerSequence: el('common', 'sequence'),
  headerTimestamp: el('common', 'timestamp'),
  headerLanguageCode: el('common', 'languageCode'),
  headerCountryCode: el('common', 'countryCode'),
  headerChannel: el('common', 'channel'),
  headerSubChannel: el('common', 'subChannel'),
  headerEnvironment: el('common', 'environment'),
  headerServiceUser: el('common', 'serviceUser'),
} as const satisfies Record<string, El>;

export type ElKey = keyof typeof EL;

/** Child order within searchCriteria and searchGuestRequest (Req 9.13). */
export const ORDER = {
  searchCriteria: ['name', 'phone', 'email', 'address', 'membership'],
  searchGuestRequest: ['searchCriteria', 'allAttributes', 'allHistory', 'maxResults'],
  // Blocker B2: provisional, replace from sample/XSD.
  header: [
    'headerTransactionId',
    'headerSequence',
    'headerTimestamp',
    'headerLanguageCode',
    'headerCountryCode',
    'headerChannel',
    'headerSubChannel',
    'headerEnvironment',
    'headerServiceUser',
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
