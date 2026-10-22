/**
 * In-house canonicalizer for request snapshots and fixtures (task 4.2, Req 25.2).
 *
 * A practical subset of Exclusive XML Canonicalization 1.0 (without comments) over an xmldom
 * Document. xml-crypto is not used: it depends on @xmldom/xmldom 0.8.x.
 *
 *   - No XML declaration; only the document element is rendered (document-level comments,
 *     PIs and whitespace are dropped). Comments are dropped everywhere.
 *   - Elements are written as `prefix:local` with their original prefix.
 *   - A namespace declaration is emitted on the element that first visibly uses it (its own
 *     prefix or an attribute prefix) unless an output ancestor already rendered the same
 *     binding. Declarations are sorted by prefix, default namespace first. Unused
 *     declarations disappear; `xmlns=""` is emitted when an unqualified element sits under
 *     a rendered default namespace.
 *   - Attributes are sorted by (namespace URI, local name); unqualified attributes first.
 *   - Text escapes `& < > CR`; attribute values escape `& < " TAB LF CR`. CDATA becomes text.
 *   - Empty elements are written as a start tag plus an end tag.
 *
 * Not covered (not needed for SOAP requests): InclusiveNamespaces PrefixList, document
 * subsets, xml:* attribute inheritance rules.
 */
import type { Attr, Document, Element, Node } from '@xmldom/xmldom';
import { parseXml } from './xmlRead.js';

const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;

export interface CanonicalizeOptions {
  /**
   * Drop whitespace-only text nodes in elements that have element children (the indentation
   * `formatForSnapshot` adds), so a formatted fixture canonicalizes to the same string as
   * the compact envelope. Off by default: canonicalization keeps all text.
   */
  ignoreFormatting?: boolean;
}

const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');

const escapeAttr = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const qualified = (prefix: string | null, local: string): string =>
  prefix === null || prefix === '' ? local : prefix + ':' + local;

/** Prefix → URI bindings rendered by output ancestors ('' is the default namespace). */
type Rendered = ReadonlyMap<string, string>;

interface Writer {
  ignoreFormatting: boolean;
  /** Indentation unit, or `null` for compact canonical output. */
  indent: string | null;
}

const isWhitespace = (s: string): boolean => /^[ \t\n\r]*$/.test(s);

function regularAttributes(el: Element): Attr[] {
  return Array.from(el.attributes).filter((a) => a.namespaceURI !== XMLNS_URI);
}

/** Children to render: elements, text, CDATA and PIs; comments are dropped. */
function renderedChildren(el: Element, w: Writer): Node[] {
  const kids = Array.from(el.childNodes).filter(
    (n) =>
      n.nodeType === ELEMENT_NODE ||
      n.nodeType === TEXT_NODE ||
      n.nodeType === CDATA_SECTION_NODE ||
      n.nodeType === PROCESSING_INSTRUCTION_NODE,
  );
  const elementContent = kids.some((n) => n.nodeType === ELEMENT_NODE);
  if (!w.ignoreFormatting || !elementContent) return kids;
  return kids.filter((n) => n.nodeType !== TEXT_NODE || !isWhitespace(n.nodeValue ?? ''));
}

function writeElement(el: Element, rendered: Rendered, w: Writer, depth: number): string {
  const attrs = regularAttributes(el);

  // Namespaces visibly utilized by this element and its attributes.
  const used = new Map<string, string>();
  used.set(el.prefix ?? '', el.namespaceURI ?? '');
  for (const a of attrs) {
    if (a.prefix !== null && a.prefix !== '' && a.prefix !== 'xml') {
      used.set(a.prefix, a.namespaceURI ?? '');
    }
  }
  const scope = new Map(rendered);
  const decls: [string, string][] = [];
  for (const [prefix, uri] of used) {
    if ((rendered.get(prefix) ?? '') === uri) continue; // already in scope (or both empty)
    decls.push([prefix, uri]);
    scope.set(prefix, uri);
  }
  decls.sort((a, b) => compare(a[0], b[0]));

  const sortedAttrs = [...attrs].sort(
    (a, b) =>
      compare(a.namespaceURI ?? '', b.namespaceURI ?? '') ||
      compare(a.localName ?? a.name, b.localName ?? b.name),
  );

  const name = qualified(el.prefix, el.localName ?? el.tagName);
  let out = '<' + name;
  for (const [prefix, uri] of decls) {
    out += ' ' + (prefix === '' ? 'xmlns' : 'xmlns:' + prefix) + '="' + escapeAttr(uri) + '"';
  }
  for (const a of sortedAttrs) {
    out += ' ' + qualified(a.prefix, a.localName ?? a.name) + '="' + escapeAttr(a.value) + '"';
  }
  out += '>';

  const kids = renderedChildren(el, w);
  const pretty =
    w.indent !== null && kids.length > 0 && kids.every((n) => n.nodeType === ELEMENT_NODE);
  for (const kid of kids) {
    if (pretty) out += '\n' + (w.indent ?? '').repeat(depth + 1);
    out += writeNode(kid, scope, w, depth + 1);
  }
  if (pretty) out += '\n' + (w.indent ?? '').repeat(depth);
  return out + '</' + name + '>';
}

function writeNode(node: Node, rendered: Rendered, w: Writer, depth: number): string {
  switch (node.nodeType) {
    case ELEMENT_NODE:
      return writeElement(node as Element, rendered, w, depth);
    case TEXT_NODE:
    case CDATA_SECTION_NODE:
      return escapeText(node.nodeValue ?? '');
    case PROCESSING_INSTRUCTION_NODE: {
      const data = node.nodeValue ?? '';
      return '<?' + node.nodeName + (data === '' ? '' : ' ' + data) + '?>';
    }
    default:
      return '';
  }
}

function serialize(input: string | Document, w: Writer): string {
  const doc = typeof input === 'string' ? parseXml(input) : input;
  const root = doc.documentElement;
  if (root === null) throw new Error('XML error: no document element');
  return writeElement(root, new Map(), w, 0);
}

/** Canonicalize an XML string or xmldom Document (see the module comment for the rules). */
export function canonicalize(input: string | Document, options: CanonicalizeOptions = {}): string {
  return serialize(input, { ignoreFormatting: options.ignoreFormatting ?? false, indent: null });
}

/**
 * Pretty-print canonical XML for readable file snapshots and fixtures. Only elements whose
 * rendered children are all elements get a newline and two-space indentation per child; any
 * element containing text keeps its content byte-for-byte. Namespace placement, attribute
 * order and escaping are those of `canonicalize`. Ends without a trailing newline.
 */
export function formatForSnapshot(canonicalXml: string): string {
  return serialize(canonicalXml, { ignoreFormatting: false, indent: '  ' });
}
