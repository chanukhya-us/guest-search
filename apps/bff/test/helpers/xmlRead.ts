/**
 * Namespace-aware XML reader for tests (task 4.2, Req 25.2).
 *
 * Every lookup matches by namespace URI + local name taken from an `El` identity in
 * `contract.ts`; document prefixes are never consulted (Req 11.4). XPath is available through
 * `select`, whose prefixes are the `NS` keys (`soap:`, `svc:`, `complex:` ...), bound to the
 * contract URIs, so it is independent of the prefixes used in the document as well.
 */
import { DOMParser, type Document, type Element, type Node } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { EL, NS, nsUri, type El } from '../../src/soap/contract.js';

const ELEMENT_NODE = 1;

/**
 * xmldom warns when it sees U+FFFD (an encoding-problem heuristic). U+FFFD is a legal XML
 * character and valid user text, so that one warning is tolerated (found by property P2).
 */
const REPLACEMENT_CHAR_WARNING = /Unicode replacement character detected/;

/** Parse strictly: any other xmldom warning or error throws, and DTDs are rejected. */
export function parseXml(xml: string): Document {
  const doc = new DOMParser({
    onError: (level, msg) => {
      if (level === 'warning' && REPLACEMENT_CHAR_WARNING.test(msg)) return;
      throw new Error('XML ' + level + ': ' + msg);
    },
  }).parseFromString(xml, 'text/xml');
  if (doc.doctype !== null) throw new Error('XML error: DOCTYPE is not allowed');
  if (doc.documentElement === null) throw new Error('XML error: no document element');
  return doc;
}

/** Element children of a node (a Document yields its document element). */
export function childElements(parent: Node): Element[] {
  return Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === ELEMENT_NODE);
}

/** True when `node` has the identity `e` (namespace URI + local name). */
export const isEl = (node: Element, e: El): boolean =>
  node.namespaceURI === nsUri(e) && node.localName === e.local;

/** All elements reached by following `path` child by child from `root`. */
export function findAll(root: Node, path: readonly El[]): Element[] {
  let level: Node[] = [root];
  for (const step of path) {
    level = level.flatMap((n) => childElements(n).filter((c) => isEl(c, step)));
  }
  return level as Element[];
}

/** The first element reached by `path`, or `undefined`. */
export const find = (root: Node, path: readonly El[]): Element | undefined =>
  findAll(root, path)[0];

/** True when at least one element exists at `path`. */
export const has = (root: Node, path: readonly El[]): boolean => findAll(root, path).length > 0;

/** Every descendant of `root` (excluding `root`) with identity `e`, in document order. */
export function descendants(root: Node, e: El): Element[] {
  return childElements(root).flatMap((c) => [...(isEl(c, e) ? [c] : []), ...descendants(c, e)]);
}

/** Text content of an element, or `undefined` when the element is absent. */
export const text = (el: Element | undefined): string | undefined => el?.textContent ?? undefined;

/** Value of an unqualified attribute, or `undefined` when the element or attribute is absent. */
export const attr = (el: Element | undefined, name: string): string | undefined =>
  el?.hasAttributeNS(null, name) === true
    ? (el.getAttributeNS(null, name) ?? undefined)
    : undefined;

/** Namespace map for XPath: `NS` keys as prefixes, contract URIs as values. */
const selectNs = xpath.useNamespaces({ ...NS });

/**
 * Evaluate an XPath expression whose prefixes are `NS` keys, e.g.
 * `select(doc, '//svc:searchCriteria/complex:name/basic:surname')`. Returns matched nodes.
 */
export function select(root: Node, expression: string): Node[] {
  // xpath's typings use lib.dom's Node; xmldom nodes implement the same interface.
  const result = selectNs(expression, root as unknown as globalThis.Node);
  if (!xpath.isArrayOfNodes(result)) throw new Error('XPath did not select nodes: ' + expression);
  return result as unknown as Node[];
}

/** The mapped criteria fields, read back from a request envelope. */
export interface MappedRequest {
  firstName: string | undefined;
  lastName: string | undefined;
  phone: string | undefined;
  email: string | undefined;
  stateOrRegion: string | undefined;
  country: string | undefined;
  addressLine1: string | undefined;
  city: string | undefined;
  postalCode: string | undefined;
  memberType: string | undefined;
  loyaltyMemberId: string | undefined;
}

/** The single element at `path`, `undefined` when absent; throws when it repeats. */
function single(root: Node, path: readonly El[]): Element | undefined {
  const found = findAll(root, path);
  if (found.length > 1) {
    throw new Error('Expected at most one ' + path.map((e) => e.local).join('/'));
  }
  return found[0];
}

/**
 * Parse a `searchGuestRequest` envelope and read back every mapped criteria field by
 * namespace URI + local name (used by the round-trip property P1, Req 9.15). Absent elements
 * and attributes read as `undefined`; a repeated group or field throws.
 */
export function readMappedRequest(xml: string): MappedRequest {
  const doc = parseXml(xml);
  const criteria = single(doc, [EL.envelope, EL.body, EL.searchGuestRequest, EL.searchCriteria]);
  if (criteria === undefined) throw new Error('searchCriteria not found');
  const source = (e: El): string | undefined => text(single(criteria, [EL.address, EL.source, e]));
  const membership = single(criteria, [EL.membership]);
  return {
    firstName: text(single(criteria, [EL.name, EL.given])),
    lastName: text(single(criteria, [EL.name, EL.surname])),
    phone: attr(single(criteria, [EL.phone]), 'number'),
    email: text(single(criteria, [EL.email, EL.emailAddress])),
    stateOrRegion: source(EL.region1),
    country: source(EL.country),
    addressLine1: source(EL.line1),
    city: source(EL.locality1),
    postalCode: source(EL.postalCode),
    memberType: attr(membership, 'code'),
    loyaltyMemberId: attr(membership, 'value'),
  };
}
