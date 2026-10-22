/**
 * Pure request-handling core of the local Node mock SOAP server (task 13.1).
 *
 * DEV TOOLING ONLY — never shipped, excluded from coverage. Zero runtime dependencies and
 * erasable TypeScript, so it runs under `node --experimental-strip-types`.
 *
 * Factoring (unit-testable, no I/O):
 *   parseCriteria(requestXml)  -> Criteria          read the searchGuestRequest criteria
 *   filterSeed(criteria)       -> SeedGuest[]        narrow + score-sort + cap at maxResults
 *   buildResponseXml(guests)   -> string            a searchGuestResponse the BFF parser accepts
 *   handleRequest(requestXml)  -> MockResult         orchestrates the above + magic demo inputs
 *
 * The response XML mirrors the EXACT namespace structure the committed fixtures use
 * (apps/bff/test/fixtures/soap/response-single.xml), so apps/bff's parseSearchGuestResponse
 * accepts it unchanged. Values are escaped (never hand-concatenated raw), so synthetic data
 * with `& < > " '` stays well-formed.
 *
 * Magic demo inputs (documented in tools/mock-soap/README.md), matched on the surname:
 *   lastName "nomatch"  -> 0 guests, successful (empty result)
 *   lastName "fault"    -> a SOAP Fault (UPSTREAM_FAULT in the BFF)
 *   lastName "boom"     -> every seed guest (SEED_SIZE), ignoring other criteria
 *   lastName "many"     -> same as "boom" (alias; matches the 60-guest E2E scenario)
 * Matching is case-insensitive and whole-value; ordinary searches are unaffected.
 */
import { SEED, type SeedGuest } from './seed.ts';

// Namespace URIs and prefixes, copied verbatim from the committed fixtures / contract.ts.
// This is dev tooling, so it keeps its own copy rather than importing the BFF source (which
// would drag xmlbuilder2 and the BFF module graph into a zero-dep script).
const NS_COMMON = 'http://atp.ihg.com/schema/common/ATPCommonServiceTypes/v1';
const NS_INITIATE = 'http://crm.ihg.com/schema/v1_0/initiate';
const NS_COMPLEX = 'http://common.crm.ihg.com/schema/v1_0/complex';
const NS_SVC = 'http://atp.ihg.com/schema/crs/initiate/servicetypes/v1';
const NS_BASIC = 'http://common.crm.ihg.com/schema/v1_0/basictypes';

/** Hard ceiling regardless of the request `maxResults` (the seed holds SEED.length). */
const ABSOLUTE_MAX = SEED.length;

// ---------------------------------------------------------------------------------------
// Criteria extraction (tolerant read).
//
// The request shape is fixed by apps/bff/src/soap/requestMapper.ts, so a tolerant regex read
// of the criteria values is enough for a mock: it never needs to validate the envelope. We
// read element text (given/surname) and attribute values (phone/@number, email address text,
// membership/@code, membership/@value, region1, country) regardless of namespace prefix.

export interface Criteria {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  loyaltyMemberId?: string;
  memberType?: string;
  stateOrRegion?: string;
  country?: string;
  maxResults: number;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
};

/** Decode the five predefined XML entities and numeric references in read values. */
function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(?:lt|gt|amp|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

const clean = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined;
  const t = decodeXml(s).trim();
  return t === '' ? undefined : t;
};

/** First text content of a `<prefix:local>...</local>` element, any prefix, non-greedy. */
function elementText(xml: string, local: string): string | undefined {
  const re = new RegExp(`<(?:[\\w.-]+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}>`);
  const m = re.exec(xml);
  return m === undefined || m === null ? undefined : clean(m[1]);
}

/** Value of attribute `name` on the first `<prefix:local ...>` element, any prefix. */
function elementAttr(xml: string, local: string, name: string): string | undefined {
  const tag = new RegExp(`<(?:[\\w.-]+:)?${local}\\b([^>]*)>`);
  const m = tag.exec(xml);
  if (m === null || m[1] === undefined) return undefined;
  const attr = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(m[1]);
  return attr === null ? undefined : clean(attr[1]);
}

/** Slice out the first `<...searchCriteria ...>...</searchCriteria>` body, else the whole doc. */
function criteriaBody(xml: string): string {
  const m = /<(?:[\w.-]+:)?searchCriteria\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?searchCriteria>/.exec(
    xml,
  );
  return m === null || m[1] === undefined ? xml : m[1];
}

/** Read the email address, which sits in initiate:email > initiate:address (text). */
function readEmail(body: string): string | undefined {
  const m = /<(?:[\w.-]+:)?email\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?email>/.exec(body);
  if (m === null || m[1] === undefined) return undefined;
  return elementText(m[1], 'address');
}

/** Parse the criteria from a searchGuestRequest envelope. Never throws for bad XML: a mock. */
export function parseCriteria(requestXml: string): Criteria {
  const xml = typeof requestXml === 'string' ? requestXml : '';
  const body = criteriaBody(xml);
  const maxText = elementText(xml, 'maxResults');
  const parsedMax = maxText === undefined ? NaN : Number.parseInt(maxText, 10);
  const maxResults =
    Number.isFinite(parsedMax) && parsedMax > 0 ? Math.min(parsedMax, ABSOLUTE_MAX) : ABSOLUTE_MAX;

  return {
    firstName: elementText(body, 'given'),
    lastName: elementText(body, 'surname'),
    phone: elementAttr(body, 'phone', 'number'),
    email: readEmail(body),
    memberType: elementAttr(body, 'membership', 'code'),
    loyaltyMemberId: elementAttr(body, 'membership', 'value'),
    stateOrRegion: elementText(body, 'region1'),
    country: elementText(body, 'country'),
    maxResults,
  };
}

// ---------------------------------------------------------------------------------------
// Filtering + scoring.

const includesCI = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/** Loyalty ID comparison ignores spaces and hyphens (mirrors the schema's normalization). */
const normalizeId = (s: string): string => s.replace(/[\s-]/g, '').toLowerCase();

/** True when `g` satisfies every supplied criterion (unsupplied criteria are ignored). */
function matches(g: SeedGuest, c: Criteria): boolean {
  if (c.firstName !== undefined && !includesCI(g.firstName, c.firstName)) return false;
  if (c.lastName !== undefined && !includesCI(g.lastName, c.lastName)) return false;
  if (c.email !== undefined && !includesCI(g.email, c.email)) return false;
  if (c.phone !== undefined && !normalizeId(g.phone).includes(normalizeId(c.phone))) return false;
  if (c.loyaltyMemberId !== undefined && normalizeId(g.memberId) !== normalizeId(c.loyaltyMemberId))
    return false;
  if (c.memberType !== undefined && g.memberType.toLowerCase() !== c.memberType.toLowerCase())
    return false;
  if (
    c.stateOrRegion !== undefined &&
    g.stateOrRegion.toLowerCase() !== c.stateOrRegion.toLowerCase()
  )
    return false;
  if (c.country !== undefined && g.country.toLowerCase() !== c.country.toLowerCase()) return false;
  return true;
}

/** Filter the seed by criteria, sort by score descending, and cap at `maxResults`. */
export function filterSeed(c: Criteria): SeedGuest[] {
  return SEED.filter((g) => matches(g, c))
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, c.maxResults);
}

// ---------------------------------------------------------------------------------------
// Response + fault XML. Values are escaped; the structure mirrors the fixtures exactly.

/** Escape text content and attribute values for XML 1.0. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function guestXml(g: SeedGuest): string {
  const lines = [
    `      <ns2:initiateGuest score="${esc(g.score.toFixed(1))}" status="${esc(g.status)}" gender="${esc(g.gender)}">`,
    `        <ns2:enterpriseId>${esc(g.enterpriseId)}</ns2:enterpriseId>`,
    `        <ns2:name>`,
    `          <ns3:given>${esc(g.firstName)}</ns3:given>`,
    `          <ns3:surname>${esc(g.lastName)}</ns3:surname>`,
    `        </ns2:name>`,
    `        <ns2:address locationCode="H" profileDefault="true">`,
    `          <ns3:source>`,
    `            <ns3:locality1>${esc(g.city)}</ns3:locality1>`,
    `            <ns3:region1>${esc(g.stateOrRegion)}</ns3:region1>`,
    `            <ns3:country>${esc(g.country)}</ns3:country>`,
    `          </ns3:source>`,
    `        </ns2:address>`,
    `        <ns2:phone number="${esc(g.phone)}" type="MOBILE" location="H" profileDefault="true"/>`,
    `        <ns2:email profileDefault="true">`,
    `          <ns2:address>${esc(g.email)}</ns2:address>`,
    `        </ns2:email>`,
    `        <ns2:membership code="${esc(g.memberType)}" value="${esc(g.memberId)}" status="${esc(g.membershipStatus)}"/>`,
    `      </ns2:initiateGuest>`,
  ];
  return lines.join('\n');
}

/** Build a valid `searchGuestResponse` the BFF responseParser accepts, for `guests`. */
export function buildResponseXml(guests: readonly SeedGuest[]): string {
  const open = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`,
    `  <soap:Body>`,
    `    <ns4:searchGuestResponse xmlns="${NS_COMMON}" xmlns:ns2="${NS_INITIATE}" xmlns:ns3="${NS_COMPLEX}" xmlns:ns4="${NS_SVC}" xmlns:ns5="${NS_BASIC}">`,
    `      <header>`,
    `        <transactionStatus overallStatusCode="0000" overallStatusDescription="Success" transactionSuccessful="true"/>`,
    `      </header>`,
  ];
  const close = [`    </ns4:searchGuestResponse>`, `  </soap:Body>`, `</soap:Envelope>`];
  const body = guests.map(guestXml);
  return [...open, ...body, ...close].join('\n') + '\n';
}

/** Build a SOAP 1.1 server Fault (the mock's "fault" magic input). */
export function buildFaultXml(): string {
  return (
    [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`,
      `  <soap:Body>`,
      `    <soap:Fault>`,
      `      <faultcode>soap:Server</faultcode>`,
      `      <faultstring>Synthetic mock fault requested via lastName "fault"</faultstring>`,
      `    </soap:Fault>`,
      `  </soap:Body>`,
      `</soap:Envelope>`,
    ].join('\n') + '\n'
  );
}

// ---------------------------------------------------------------------------------------
// Orchestration + magic demo inputs.

/** HTTP-level outcome the server should send. */
export interface MockResult {
  /** HTTP status: 200 for a normal response, 500 for a SOAP Fault. */
  status: number;
  /** The XML body. */
  xml: string;
  /** How many guests the response carries (0 for a fault). */
  count: number;
  /** The matched magic input, if any (for logging). */
  magic?: 'nomatch' | 'fault' | 'boom';
}

/** Recognize a magic surname (case-insensitive, whole value). */
function magicInput(lastName: string | undefined): MockResult['magic'] | undefined {
  if (lastName === undefined) return undefined;
  const v = lastName.trim().toLowerCase();
  if (v === 'nomatch') return 'nomatch';
  if (v === 'fault') return 'fault';
  if (v === 'boom' || v === 'many') return 'boom';
  return undefined;
}

/** Parse → (magic?) → filter → build. Pure: a function of the request string only. */
export function handleRequest(requestXml: string): MockResult {
  const criteria = parseCriteria(requestXml);
  const magic = magicInput(criteria.lastName);

  if (magic === 'fault') return { status: 500, xml: buildFaultXml(), count: 0, magic };
  if (magic === 'nomatch') return { status: 200, xml: buildResponseXml([]), count: 0, magic };
  if (magic === 'boom') {
    const all = SEED.slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, criteria.maxResults);
    return { status: 200, xml: buildResponseXml(all), count: all.length, magic };
  }

  const guests = filterSeed(criteria);
  return { status: 200, xml: buildResponseXml(guests), count: guests.length };
}
