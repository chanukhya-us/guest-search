/**
 * Secure `searchGuestResponse` parser (Req 11, 12; design.md "responseParser.ts").
 *
 * Pure: a function of the response string only, no I/O (Req 11.10). Total: for ANY input it
 * returns `GuestSearchResult[]` or throws `SoapError`, never anything else (Req 11.11).
 *
 * Security:
 *   - `<!DOCTYPE` / `<!ENTITY` are rejected before parsing, so no entity is ever expanded or
 *     resolved (billion laughs, XXE). A parsed `doctype` is rejected again as a second net.
 *   - Every xmldom warning, error and fatal error throws; there is no recovery mode (Req 11.2).
 *   - Elements are matched by namespace URI + local name from `EL`, never by prefix (Req 11.4).
 *   - Only `ALLOW`-listed attributes and child elements are read. Unknown children such as
 *     `creditCard` are never read, mapped or returned (Req 12.10, 12.11).
 *   - `SoapError` messages are fixed per code and `detail` is a sanitized status/fault code,
 *     so neither ever carries payload text into logs.
 *
 * Decisions (documented here and in the task report):
 *   - Transaction success requires BOTH `@transactionSuccessful === SUCCESS.transactionSuccessful`
 *     AND `@overallStatusCode === SUCCESS.overallStatusCode` (copilot-instructions.md §7:
 *     "transactionSuccessful and the schema-defined status fields" are authoritative).
 *   - A missing `transactionStatus` is a structural break: `UPSTREAM_CONTRACT`.
 *     `interpretTransactionStatus(null)` still answers `{ ok: false, code: STATUS_MISSING }`
 *     so the interpreter itself is total.
 *   - A phone without `@number` or an email without `address` text is skipped: the domain type
 *     requires those values and inventing `''` would fabricate data (Req 12.9). Skipping an
 *     empty item is not deduplication (Req 12.12); every item that has a value is kept.
 *   - Attribute and text values are trimmed; an empty value becomes `undefined` (Req 12.9).
 */
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import type {
  ErrorCode,
  GuestAddress,
  GuestEmail,
  GuestMembership,
  GuestPhone,
  GuestSearchResult,
} from '@ihg-guest-search/shared';
import { ALLOW, EL, SUCCESS, nsUri, type El } from './contract.js';

/** Every upstream error code; shared with the transport and gateway (tasks 6.2, 6.3). */
export type UpstreamCode = Extract<ErrorCode, `UPSTREAM_${string}`>;

/** Fixed, payload-free log messages. */
const MESSAGES: Readonly<Record<UpstreamCode, string>> = {
  UPSTREAM_TIMEOUT: 'SOAP service timed out',
  UPSTREAM_UNAVAILABLE: 'SOAP service unavailable',
  UPSTREAM_HTTP_ERROR: 'SOAP service returned a non-success HTTP status without a Fault',
  UPSTREAM_FAULT: 'SOAP service returned a Fault',
  UPSTREAM_TXN_FAILED: 'SOAP transaction status reports failure',
  UPSTREAM_CONTRACT: 'SOAP response does not match the contract',
  UPSTREAM_MALFORMED: 'SOAP response is not acceptable XML',
};

/** `detail` is logged, so only short code-like tokens pass; anything else is replaced. */
const SAFE_DETAIL = /^[A-Za-z0-9_.:-]{1,64}$/;
export const DETAIL_REDACTED = 'REDACTED';

/** Reported by `interpretTransactionStatus` when there is no element or no status code. */
export const STATUS_MISSING = 'MISSING';

export class SoapError extends Error {
  override readonly name = 'SoapError';
  readonly code: UpstreamCode;
  /** The faultcode or overallStatusCode only (sanitized), never payload text. */
  readonly detail: string | undefined;

  constructor(code: UpstreamCode, detail?: string) {
    super(MESSAGES[code]);
    this.code = code;
    this.detail =
      detail === undefined ? undefined : SAFE_DETAIL.test(detail) ? detail : DETAIL_REDACTED;
  }
}

export type TransactionStatusResult = { ok: true } | { ok: false; code: string };

const ELEMENT_NODE = 1;
const FORBIDDEN_DECL = /<!DOCTYPE|<!ENTITY/i;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// ---------------------------------------------------------------------------------------
// Namespace-aware navigation (Req 11.4). Identities come only from `EL`.

const isEl = (node: Node, e: El): node is Element =>
  node.nodeType === ELEMENT_NODE && node.namespaceURI === nsUri(e) && node.localName === e.local;

/** Direct element children of `parent` with identity `e`, in document order. */
function children(parent: Node, e: El): Element[] {
  const out: Element[] = [];
  for (const n of Array.from(parent.childNodes)) if (isEl(n, e)) out.push(n);
  return out;
}

/** First direct element child of `parent` with identity `e`. */
const child = (parent: Node, e: El): Element | undefined => children(parent, e)[0];

/**
 * First descendant of `root` with identity `e`, depth-first in document order. Subtrees with
 * identity `skip` are not entered, so guest content (and any card data) is never walked.
 */
function descendant(root: Node, e: El, skip: El): Element | null {
  const stack: Node[] = Array.from(root.childNodes).reverse();
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (n.nodeType !== ELEMENT_NODE || isEl(n, skip)) continue;
    if (isEl(n, e)) return n;
    for (const c of Array.from(n.childNodes).reverse()) stack.push(c);
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Value readers. Trimmed; empty becomes undefined (Req 12.9).

const clean = (v: string | null | undefined): string | undefined => {
  const t = v?.trim();
  return t === undefined || t === '' ? undefined : t;
};

const text = (el: Element | undefined): string | undefined => clean(el?.textContent);

/** Unqualified attribute `name`, restricted at compile time to an `ALLOW` list (Req 12.10). */
const attr = <const A extends readonly string[]>(
  el: Element,
  _allowed: A,
  name: A[number],
): string | undefined => clean(el.getAttributeNS(null, name));

/** `Number(v)` for a decimal literal that is finite, else undefined (Req 12.8). */
const parseScore = (v: string | undefined): number | undefined => {
  if (v === undefined || !DECIMAL.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const parseBool = (v: string | undefined): boolean | undefined =>
  v === 'true' ? true : v === 'false' ? false : undefined;

/** Drop keys whose value is undefined, so absent fields are absent (Req 12.9). */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------------------
// Transaction status (Req 11.8, 11.9): the single centralized interpreter.

const statusAttr = (el: Element, name: keyof typeof SUCCESS): string | undefined =>
  clean(el.getAttributeNS(null, name));

export function interpretTransactionStatus(el: Element | null): TransactionStatusResult {
  if (el === null) return { ok: false, code: STATUS_MISSING };
  const successful = statusAttr(el, 'transactionSuccessful');
  const code = statusAttr(el, 'overallStatusCode');
  if (successful === SUCCESS.transactionSuccessful && code === SUCCESS.overallStatusCode) {
    return { ok: true };
  }
  return { ok: false, code: code ?? STATUS_MISSING };
}

// ---------------------------------------------------------------------------------------
// Domain mapping (Req 12). Children of initiateGuest are reachable only via ALLOW.childElements.

type GuestChild = (typeof ALLOW.childElements)[number];

const GUEST_CHILD: Readonly<Record<GuestChild, El>> = {
  enterpriseId: EL.enterpriseId,
  name: EL.guestName,
  address: EL.guestAddress,
  phone: EL.guestPhone,
  email: EL.guestEmail,
  membership: EL.guestMembership,
};

const guestChildren = (guest: Element, key: GuestChild): Element[] =>
  children(guest, GUEST_CHILD[key]);

function mapAddress(a: Element): GuestAddress {
  const src = child(a, EL.guestAddressSource);
  const part = (e: El): string | undefined => (src === undefined ? undefined : text(child(src, e)));
  return compact({
    line1: part(EL.guestLine1),
    city: part(EL.guestLocality1),
    stateOrRegion: part(EL.guestRegion1),
    postalCode: part(EL.guestPostalCode),
    country: part(EL.guestCountry),
    locationCode: attr(a, ALLOW.addressAttrs, 'locationCode'),
    profileDefault: parseBool(attr(a, ALLOW.addressAttrs, 'profileDefault')),
  });
}

function mapPhone(p: Element): GuestPhone[] {
  const number = attr(p, ALLOW.phoneAttrs, 'number');
  if (number === undefined) return [];
  return [
    compact({
      number,
      type: attr(p, ALLOW.phoneAttrs, 'type'),
      location: attr(p, ALLOW.phoneAttrs, 'location'),
      profileDefault: parseBool(attr(p, ALLOW.phoneAttrs, 'profileDefault')),
    }),
  ];
}

function mapEmail(e: Element): GuestEmail[] {
  const address = text(child(e, EL.guestEmailAddress));
  if (address === undefined) return [];
  return [
    compact({ address, profileDefault: parseBool(attr(e, ALLOW.emailAttrs, 'profileDefault')) }),
  ];
}

const mapMembership = (m: Element): GuestMembership =>
  compact({
    memberType: attr(m, ALLOW.membershipAttrs, 'code'),
    memberId: attr(m, ALLOW.membershipAttrs, 'value'),
    status: attr(m, ALLOW.membershipAttrs, 'status'),
  });

function mapGuest(g: Element): GuestSearchResult {
  // Multiple names are not modelled (design.md open question): the first one is used.
  const name = guestChildren(g, 'name')[0];
  return compact({
    enterpriseId: text(guestChildren(g, 'enterpriseId')[0]) ?? '',
    score: parseScore(attr(g, ALLOW.guestAttrs, 'score')),
    status: attr(g, ALLOW.guestAttrs, 'status'),
    gender: attr(g, ALLOW.guestAttrs, 'gender'),
    firstName: name === undefined ? undefined : text(child(name, EL.guestGiven)),
    lastName: name === undefined ? undefined : text(child(name, EL.guestSurname)),
    addresses: guestChildren(g, 'address').map(mapAddress),
    phones: guestChildren(g, 'phone').flatMap(mapPhone),
    emails: guestChildren(g, 'email').flatMap(mapEmail),
    memberships: guestChildren(g, 'membership').map(mapMembership),
  });
}

// ---------------------------------------------------------------------------------------
// Entry point.

/** Faultcode is unqualified per SOAP 1.1; a SOAP-qualified one is accepted defensively. */
const FAULTCODE_QUALIFIED: El = { ...EL.faultcode, ns: EL.fault.ns };

function parseStrict(xml: string): Node {
  const doc = new DOMParser({
    onError: (level) => {
      throw new SoapError('UPSTREAM_MALFORMED', level);
    },
  }).parseFromString(xml, 'text/xml');
  // Second net behind the pre-check, which already rejects every DOCTYPE.
  /* v8 ignore next */
  if (doc.doctype !== null) throw new SoapError('UPSTREAM_MALFORMED');
  return doc;
}

function parseUnchecked(xml: string): GuestSearchResult[] {
  if (FORBIDDEN_DECL.test(xml)) throw new SoapError('UPSTREAM_MALFORMED');
  const doc = parseStrict(xml);

  const envelope = child(doc, EL.envelope);
  const body = envelope === undefined ? undefined : child(envelope, EL.body);
  if (body === undefined) throw new SoapError('UPSTREAM_CONTRACT');

  const fault = child(body, EL.fault);
  if (fault !== undefined) {
    const code = child(fault, EL.faultcode) ?? child(fault, FAULTCODE_QUALIFIED);
    throw new SoapError('UPSTREAM_FAULT', text(code));
  }

  const response = child(body, EL.searchGuestResponse);
  if (response === undefined) throw new SoapError('UPSTREAM_CONTRACT');

  const status = descendant(response, EL.transactionStatus, EL.initiateGuest);
  if (status === null) throw new SoapError('UPSTREAM_CONTRACT');
  const result = interpretTransactionStatus(status);
  if (!result.ok) throw new SoapError('UPSTREAM_TXN_FAILED', result.code);

  return children(response, EL.initiateGuest).map(mapGuest);
}

/**
 * Parse a `searchGuestResponse` SOAP envelope into domain results (Req 11, 12).
 * @throws {SoapError} with `UPSTREAM_MALFORMED`, `UPSTREAM_CONTRACT`, `UPSTREAM_FAULT` or
 * `UPSTREAM_TXN_FAILED`. Nothing else escapes (Req 11.11).
 */
export function parseSearchGuestResponse(xml: string): GuestSearchResult[] {
  try {
    if (typeof xml !== 'string') throw new SoapError('UPSTREAM_MALFORMED');
    return parseUnchecked(xml);
  } catch (e) {
    if (e instanceof SoapError) throw e;
    // xmldom ParseError (including our onError throw, which it rewraps), TypeError, RangeError
    // from pathological nesting: all MALFORMED. The cause is dropped: it may quote payload text.
    throw new SoapError('UPSTREAM_MALFORMED');
  }
}
