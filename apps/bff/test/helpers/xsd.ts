/**
 * XSD validation harness for generated request envelopes (task 4.5, Req 25.7).
 *
 * Validation scope (decision): only the SOAP Body payload, `searchGuestRequest`, is validated
 * against the IHG XSDs. The SOAP 1.1 envelope schema is not part of IHG's supplied set, and
 * vendoring it would make the test depend on a third-party schema rather than the contract.
 * The envelope structure (Envelope > Header, Body) is already asserted by the 4.3 unit tests
 * by namespace URI + local name. The payload is extracted with the namespace-aware reader and
 * re-serialized standalone with every in-scope namespace declaration copied onto it.
 * The Header is not validated here: its shape is provisional until Blocker B2.
 *
 * xmllint-wasm runs entirely in memory with `--nonet`: the entry schema is the one file whose
 * `targetNamespace` declares the payload element globally, and every other `schemas/*.xsd` file
 * is preloaded under its original name, so relative `xs:import`/`xs:include` locations resolve.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { XMLSerializer, type Element } from '@xmldom/xmldom';
import { validateXML, type XMLFileInfo } from 'xmllint-wasm';
import { EL, nsUri, type El } from '../../src/soap/contract.js';
import { childElements, find, parseXml } from './xmlRead.js';

const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export interface SchemaFile {
  readonly fileName: string;
  readonly contents: string;
}

/** Every `*.xsd` file directly in `dir`, sorted by name; empty when the directory is absent. */
export function listXsdFiles(dir: URL): SchemaFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xsd'))
    .sort()
    .map((fileName) => ({ fileName, contents: readFileSync(new URL(fileName, dir), 'utf8') }));
}

/** True when the schema declares a global element with the identity `e`. */
function declaresGlobal(file: SchemaFile, e: El): boolean {
  const schema = parseXml(file.contents).documentElement;
  if (schema === null || schema.namespaceURI !== XSD_NS || schema.localName !== 'schema') {
    return false;
  }
  if ((schema.getAttribute('targetNamespace') ?? '') !== (nsUri(e) ?? '')) return false;
  return childElements(schema).some(
    (c) =>
      c.namespaceURI === XSD_NS && c.localName === 'element' && c.getAttribute('name') === e.local,
  );
}

export interface SchemaSet {
  /** The schema passed to xmllint as `--schema`. */
  readonly entry: SchemaFile;
  /** Every other file, preloaded into xmllint's in-memory file system. */
  readonly preload: readonly SchemaFile[];
}

/** Pick the single schema that declares `root` globally; throws when there is not exactly one. */
export function schemaSetFor(files: readonly SchemaFile[], root: El): SchemaSet {
  const entries = files.filter((f) => declaresGlobal(f, root));
  if (entries.length !== 1) {
    throw new Error(
      'Expected exactly one XSD declaring global element {' +
        String(nsUri(root)) +
        '}' +
        root.local +
        ', found ' +
        String(entries.length) +
        (entries.length > 0 ? ': ' + entries.map((f) => f.fileName).join(', ') : ''),
    );
  }
  const entry = entries[0] as SchemaFile;
  return { entry, preload: files.filter((f) => f !== entry) };
}

export interface XsdResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** Validate `xml` against the schema set with xmllint-wasm (no network access). */
export async function validateAgainst(xml: string, set: SchemaSet): Promise<XsdResult> {
  const toInfo = (f: SchemaFile): XMLFileInfo => ({ fileName: f.fileName, contents: f.contents });
  const result = await validateXML({
    xml: { fileName: 'payload.xml', contents: xml },
    schema: toInfo(set.entry),
    preload: set.preload.map(toInfo),
    modifyArguments: (args) => ['--nonet', ...args],
  });
  // `valid` is null for an unknown xmllint exit code (e.g. a schema that fails to compile).
  return { valid: result.valid === true, errors: result.errors.map((e) => e.rawMessage) };
}

/**
 * Extract `soap:Body/searchGuestRequest` from a request envelope as a standalone document.
 * Lookup is by namespace URI + local name. Namespace declarations in scope on the payload
 * (from Body and Envelope, nearest wins) are copied onto its root, so QName-valued content
 * keeps resolving after extraction.
 */
export function extractBodyPayload(envelopeXml: string): string {
  const payload = find(parseXml(envelopeXml), [EL.envelope, EL.body, EL.searchGuestRequest]);
  if (payload === undefined) throw new Error('soap:Body/searchGuestRequest not found');

  const declared = new Set(
    Array.from(payload.attributes)
      .filter((a) => a.namespaceURI === XMLNS_NS)
      .map((a) => a.name),
  );
  const clone = payload.cloneNode(true) as Element;
  for (let n = payload.parentNode; n !== null && n.nodeType === 1; n = n.parentNode) {
    for (const a of Array.from((n as Element).attributes)) {
      if (a.namespaceURI !== XMLNS_NS || declared.has(a.name)) continue;
      declared.add(a.name);
      clone.setAttributeNS(XMLNS_NS, a.name, a.value);
    }
  }
  return new XMLSerializer().serializeToString(clone);
}
