/**
 * DOM-based namespace-prefix rewriter for the prefix-invariance property P4 (task 5.4,
 * Req 11.12). No regex over XML: the input is parsed with xmldom and re-serialized from the
 * DOM with a caller-chosen prefix per namespace URI.
 *
 *   - `prefixes[i]` is the prefix for the i-th distinct namespace URI (document order).
 *     `''` means the default namespace. The URI → prefix map is kept injective, so at most
 *     one namespace is the default in any scope; a displaced URI gets a fresh `_rN` prefix.
 *   - `rebind` re-declares a namespace mid-tree: at element `at` (document order, modulo the
 *     element count) URI `ns` (modulo the URI count) switches to `prefix` for that subtree.
 *     The declaration is written there eagerly, even when that element does not use it.
 *   - A declaration is written wherever the in-scope binding differs from the one needed,
 *     so unqualified elements under a default namespace get `xmlns=""`.
 *   - Unqualified attributes stay unprefixed. A namespaced attribute never uses the default
 *     namespace (attributes cannot); it gets a fresh prefix when its URI is the default.
 *   - Original `xmlns*` attributes are dropped; text, CDATA, comments and PIs are kept.
 */
import type { Element, Node } from '@xmldom/xmldom';
import { parseXml } from './xmlRead.js';

const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';
const XML_URI = 'http://www.w3.org/XML/1998/namespace';
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;

export interface Rebinding {
  readonly at: number;
  readonly ns: number;
  readonly prefix: string;
}

export interface PrefixPlan {
  readonly prefixes: readonly string[];
  readonly rebind: readonly Rebinding[];
}

/** URI → prefix ('' = default namespace); always injective. */
type Assignment = ReadonlyMap<string, string>;

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

const qname = (prefix: string, local: string): string =>
  prefix === '' ? local : prefix + ':' + local;

function fresh(taken: ReadonlySet<string>): string {
  for (let i = 0; ; i++) if (!taken.has('_r' + i)) return '_r' + i;
}

const elementChildren = (n: Node): Element[] =>
  Array.from(n.childNodes).filter((c): c is Element => c.nodeType === ELEMENT_NODE);

function allElements(root: Element): Element[] {
  return [root, ...elementChildren(root).flatMap(allElements)];
}

/** Distinct element and attribute namespace URIs, in document order (xml/xmlns excluded). */
export function namespaceUris(root: Element): string[] {
  const out = new Set<string>();
  for (const el of allElements(root)) {
    if (el.namespaceURI !== null) out.add(el.namespaceURI);
    for (const a of Array.from(el.attributes)) {
      const u = a.namespaceURI;
      if (u !== null && u !== XMLNS_URI && u !== XML_URI) out.add(u);
    }
  }
  return [...out];
}

/** Bind `uri` to `prefix`; any other URI holding `prefix` moves to a fresh one. */
function bind(assign: Assignment, uri: string, prefix: string): Assignment {
  const next = new Map(assign);
  next.delete(uri);
  const taken = new Set([...next.values(), prefix]);
  for (const [u, p] of next) {
    if (p !== prefix) continue;
    const f = fresh(taken);
    taken.add(f);
    next.set(u, f);
  }
  next.set(uri, prefix);
  return next;
}

interface Ctx {
  readonly order: ReadonlyMap<Element, number>;
  readonly rebinds: readonly { at: number; uri: string; prefix: string }[];
}

function writeNode(
  n: Node,
  assign: Assignment,
  scope: ReadonlyMap<string, string>,
  ctx: Ctx,
): string {
  switch (n.nodeType) {
    case ELEMENT_NODE:
      return writeElement(n as Element, assign, scope, ctx);
    case TEXT_NODE:
      return escapeText(n.nodeValue ?? '');
    case CDATA_SECTION_NODE:
      return '<![CDATA[' + (n.nodeValue ?? '') + ']]>';
    case COMMENT_NODE:
      return '<!--' + (n.nodeValue ?? '') + '-->';
    case PROCESSING_INSTRUCTION_NODE: {
      const data = n.nodeValue ?? '';
      return '<?' + n.nodeName + (data === '' ? '' : ' ' + data) + '?>';
    }
    default:
      return '';
  }
}

function writeElement(
  el: Element,
  inherited: Assignment,
  scope: ReadonlyMap<string, string>,
  ctx: Ctx,
): string {
  const idx = ctx.order.get(el) ?? -1;
  let assign = inherited;
  const eager: string[] = [];
  for (const r of ctx.rebinds) {
    if (r.at !== idx) continue;
    assign = bind(assign, r.uri, r.prefix);
    eager.push(r.uri);
  }

  const local = new Map(scope); // prefix → URI in scope ('' → '' means no default)
  const decls = new Map<string, string>();
  const need = (prefix: string, uri: string): void => {
    if ((local.get(prefix) ?? '') === uri) return;
    decls.set(prefix, uri);
    local.set(prefix, uri);
  };
  const prefixOf = (uri: string): string => assign.get(uri) ?? '';

  // The element itself: its prefix, or no default namespace when it is unqualified.
  const own = el.namespaceURI;
  const ownPrefix = own === null ? '' : prefixOf(own);
  need(ownPrefix, own ?? '');

  const attrs: string[] = [];
  for (const a of Array.from(el.attributes)) {
    const u = a.namespaceURI;
    const name = a.localName ?? a.name;
    if (u === XMLNS_URI) continue;
    if (u === null) {
      attrs.push(name + '="' + escapeAttr(a.value) + '"');
      continue;
    }
    if (u === XML_URI) {
      attrs.push('xml:' + name + '="' + escapeAttr(a.value) + '"');
      continue;
    }
    let p = prefixOf(u);
    if (p === '' || (decls.has(p) && decls.get(p) !== u)) {
      p = fresh(new Set([...assign.values(), ...decls.keys(), ...local.keys()]));
    }
    need(p, u);
    attrs.push(p + ':' + name + '="' + escapeAttr(a.value) + '"');
  }

  // Mid-tree redeclarations, written even when unused here (skipped only on a clash).
  for (const uri of eager) {
    const p = prefixOf(uri);
    if (decls.has(p) && decls.get(p) !== uri) continue;
    decls.set(p, uri);
    local.set(p, uri);
  }

  const tag = qname(ownPrefix, el.localName ?? el.tagName);
  let out = '<' + tag;
  for (const [p, u] of decls) {
    out += ' ' + (p === '' ? 'xmlns' : 'xmlns:' + p) + '="' + escapeAttr(u) + '"';
  }
  for (const a of attrs) out += ' ' + a;
  out += '>';
  for (const c of Array.from(el.childNodes)) out += writeNode(c, assign, local, ctx);
  return out + '</' + tag + '>';
}

/** Re-serialize `xml` with the prefixes of `plan` (see the module comment). */
export function rewritePrefixes(xml: string, plan: PrefixPlan): string {
  const root = parseXml(xml).documentElement;
  if (root === null) throw new Error('XML error: no document element');
  const uris = namespaceUris(root);
  const elements = allElements(root);

  const initial = new Map<string, string>();
  uris.forEach((uri, i) => {
    const want = plan.prefixes[i];
    const taken = new Set(initial.values());
    initial.set(uri, want !== undefined && !taken.has(want) ? want : fresh(taken));
  });

  const ctx: Ctx = {
    order: new Map(elements.map((e, i) => [e, i])),
    rebinds:
      uris.length === 0
        ? []
        : plan.rebind.map((r) => ({
            at: r.at % elements.length,
            uri: uris[r.ns % uris.length] as string,
            prefix: r.prefix,
          })),
  };
  return '<?xml version="1.0" encoding="UTF-8"?>' + writeElement(root, initial, new Map(), ctx);
}

/**
 * Prefix-free structure of a document: (namespace URI, local name, sorted non-xmlns
 * attributes by URI + local name, children). Two documents with equal signatures are the same
 * namespace-level infoset, which is what P4 needs the rewriter to preserve.
 */
export function namespaceSignature(xml: string): unknown {
  const sig = (n: Node): unknown => {
    if (n.nodeType !== ELEMENT_NODE) return [n.nodeType, n.nodeValue];
    const el = n as Element;
    const attrs = Array.from(el.attributes)
      .filter((a) => a.namespaceURI !== XMLNS_URI)
      .map((a) => [a.namespaceURI, a.localName ?? a.name, a.value])
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    return [el.namespaceURI, el.localName, attrs, Array.from(el.childNodes).map(sig)];
  };
  const root = parseXml(xml).documentElement;
  if (root === null) throw new Error('XML error: no document element');
  return sig(root);
}
