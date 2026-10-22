// Unit tests for the in-house Exc-C14N-style canonicalizer (task 4.2, Req 25.2).
import { describe, expect, it } from 'vitest';
import { canonicalize, formatForSnapshot } from '../../helpers/c14n.js';
import { buildReference } from '../../helpers/requestFixtures.js';

describe('canonicalize', () => {
  it('places each namespace declaration where it is first visibly used, sorted', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<a:root xmlns:a="urn:a" xmlns:b="urn:b" xmlns:z="urn:z" xmlns:unused="urn:u" xmlns="urn:d">' +
      '<b:x z:at="1" a:at="2"><b:y/></b:x><b:x/><plain/></a:root>';
    expect(canonicalize(xml)).toBe(
      '<a:root xmlns:a="urn:a">' +
        '<b:x xmlns:b="urn:b" xmlns:z="urn:z" a:at="2" z:at="1"><b:y></b:y></b:x>' +
        '<b:x xmlns:b="urn:b"></b:x>' +
        '<plain xmlns="urn:d"></plain>' +
        '</a:root>',
    );
  });

  it('undeclares the default namespace for an unqualified child', () => {
    expect(canonicalize('<r xmlns="urn:d"><c xmlns=""/></r>')).toBe(
      '<r xmlns="urn:d"><c xmlns=""></c></r>',
    );
  });

  it('keeps the original prefix, even when it differs for the same URI', () => {
    expect(canonicalize('<p:r xmlns:p="urn:x"><q:c xmlns:q="urn:x"/></p:r>')).toBe(
      '<p:r xmlns:p="urn:x"><q:c xmlns:q="urn:x"></q:c></p:r>',
    );
  });

  it('sorts attributes by namespace URI then local name, unqualified first', () => {
    expect(canonicalize('<r xmlns:m="urn:m" xmlns:k="urn:k" m:a="1" z="2" k:b="3" a="4"/>')).toBe(
      '<r xmlns:k="urn:k" xmlns:m="urn:m" a="4" z="2" k:b="3" m:a="1"></r>',
    );
  });

  it('escapes text and attribute values per C14N', () => {
    const xml =
      '<r a="&amp;&lt;&gt;&quot;\'&#9;&#10;&#13;">&amp;&lt;&gt;&quot;\'&#13;<![CDATA[<&]]></r>';
    expect(canonicalize(xml)).toBe(
      '<r a="&amp;&lt;>&quot;\'&#x9;&#xA;&#xD;">&amp;&lt;&gt;"\'&#xD;&lt;&amp;</r>',
    );
  });

  it('drops comments and the XML declaration and writes empty elements as start+end tags', () => {
    expect(canonicalize('<?xml version="1.0"?><!--top--><r><!--in--><e/><?pi data?></r>')).toBe(
      '<r><e></e><?pi data?></r>',
    );
  });

  it('is idempotent on reparsed output', () => {
    for (const xml of [
      buildReference('request-name-phone.xml'),
      buildReference('request-loyalty.xml'),
      '<a:r xmlns:a="urn:a" xmlns="urn:d" x="&#9;&quot;"><c>t &amp; &#13;</c><a:c xmlns=""/></a:r>',
    ]) {
      const once = canonicalize(xml);
      expect(canonicalize(once)).toBe(once);
    }
  });

  it('rejects malformed XML', () => {
    expect(() => canonicalize('<r><unclosed></r>')).toThrow();
  });
});

describe('formatForSnapshot', () => {
  it('indents element-only content and leaves text content untouched', () => {
    const canonical = canonicalize('<r><a><b> x </b><c></c></a><m>t<i>u</i></m></r>');
    expect(formatForSnapshot(canonical)).toBe(
      [
        '<r>',
        '  <a>',
        '    <b> x </b>',
        '    <c></c>',
        '  </a>',
        '  <m>t<i>u</i></m>',
        '</r>',
      ].join('\n'),
    );
  });

  it('round-trips to the same canonical form when formatting is ignored', () => {
    const canonical = canonicalize(buildReference('request-name-phone.xml'));
    const formatted = formatForSnapshot(canonical);
    expect(formatted).not.toBe(canonical);
    expect(canonicalize(formatted, { ignoreFormatting: true })).toBe(canonical);
    // Existing indentation is text, so formatting is stable on its own output.
    expect(formatForSnapshot(formatted)).toBe(formatted);
  });
});
