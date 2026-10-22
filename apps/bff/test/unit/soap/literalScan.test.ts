// Contract literal scan (task 3.4, Req 7.6): no SOAP namespace URI, fixed attribute value or
// status code literal may appear in apps/bff/src/** outside src/soap/contract.ts.
//
// The scanner tokenizes each source file, drops comments, and checks string and template
// literals only, so prose in comments never trips it and line numbers stay exact.
import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NS } from '../../../src/soap/contract.js';

interface Literal {
  value: string;
  line: number;
}

interface Finding {
  file: string;
  line: number;
  rule: string;
  literal: string;
}

/** Characters after which `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);

/**
 * Extract string and template literals with their starting line. Comments are skipped;
 * regex literals are skipped so quotes inside them do not open a string.
 */
function extractLiterals(source: string): { literals: Literal[]; code: string[] } {
  const literals: Literal[] = [];
  let code = ''; // source with comments and regex bodies removed, newlines kept
  let line = 1;
  let prev = ''; // last significant code character
  let i = 0;
  const n = source.length;

  const advance = (ch: string): void => {
    if (ch === '\n') line += 1;
  };

  while (i < n) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);

    if (ch === '/' && next === '/') {
      while (i < n && source.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) {
        if (source.charAt(i) === '\n') code += '\n';
        advance(source.charAt(i));
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '/' && REGEX_PRECEDERS.has(prev)) {
      let inClass = false;
      i += 1;
      while (i < n) {
        const c = source.charAt(i);
        if (c === '\\') i += 1;
        else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break; // not a regex after all; stop at the line end
        i += 1;
      }
      i += 1;
      code += '/re/';
      prev = '/';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = line;
      let value = '';
      i += 1;
      while (i < n && source.charAt(i) !== ch) {
        const c = source.charAt(i);
        if (c === '\\') {
          value += source.charAt(i + 1);
          advance(source.charAt(i + 1));
          i += 2;
          continue;
        }
        if (ch !== '`' && c === '\n') break; // unterminated; stop at the line end
        value += c;
        advance(c);
        i += 1;
      }
      i += 1;
      literals.push({ value, line: start });
      code += ch + value + ch; // value keeps its newlines, so line numbers stay aligned
      prev = ch;
      continue;
    }

    code += ch;
    advance(ch);
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return { literals, code: code.split('\n') };
}

const NS_URIS: readonly string[] = Object.values(NS);
const GENERIC_NS = /schemas\.xmlsoap\.org|ihg\.com\/schema/i;
/** Fixed single-letter attribute values from DEFAULTS (Req 7.2). */
const SOAP_CODE_LETTERS = new Set(['O', 'H']);
/** A `'true'` / `'false'` literal passed straight to xmlbuilder2 `.att(...)`. */
const ATT_BOOLEAN = /\.att\([^)]*(['"`])(?:true|false)\1/;

/**
 * Scan one file. `file` is a POSIX path relative to `src/`; files under `soap/` get the
 * stricter attribute-value rules.
 */
function scanSource(source: string, file: string): Finding[] {
  const { literals, code } = extractLiterals(source);
  const inSoap = file.startsWith('soap/');
  const findings: Finding[] = [];
  const flag = (line: number, rule: string, literal: string): void => {
    findings.push({ file, line, rule, literal });
  };

  for (const { value, line } of literals) {
    if (NS_URIS.some((uri) => value.includes(uri))) flag(line, 'namespace URI', value);
    else if (GENERIC_NS.test(value)) flag(line, 'namespace-like URI', value);
    if (value === '0000') flag(line, 'status code', value);
    if (inSoap && SOAP_CODE_LETTERS.has(value)) flag(line, 'attribute value', value);
  }
  if (inSoap) {
    code.forEach((text, idx) => {
      if (ATT_BOOLEAN.test(text)) flag(idx + 1, 'boolean attribute default', text.trim());
    });
  }
  return findings;
}

const SRC_DIR = fileURLToPath(new URL('../../../src/', import.meta.url));
const CONTRACT = 'soap/contract.ts';
const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;

/** Every source file under src/, as POSIX paths relative to src/ (Windows-safe). */
function listSources(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .map((p) => p.split(sep).join('/'))
    .filter((p) => SOURCE_FILE.test(p) && !p.endsWith('.d.ts'))
    .sort();
}

const read = (rel: string): string => readFileSync(SRC_DIR + rel, 'utf8');
const format = (f: Finding): string => `src/${f.file}:${f.line} ${f.rule}: ${f.literal}`;

describe('contract literal scan of apps/bff/src (Req 7.6)', () => {
  it('finds the source tree, including the SOAP modules', () => {
    const files = listSources();
    expect(files).toContain(CONTRACT);
    expect(files).toContain('soap/headerBuilder.ts');
    expect(files.every((f) => !f.includes('\\'))).toBe(true);
  });

  it('flags nothing outside contract.ts', () => {
    const findings = listSources()
      .filter((f) => f !== CONTRACT)
      .flatMap((f) => scanSource(read(f), f));
    expect(findings.map(format)).toEqual([]);
  });

  it('flags contract.ts itself (positive control: the rules see real literals)', () => {
    const rules = new Set(scanSource(read(CONTRACT), CONTRACT).map((f) => f.rule));
    expect(rules).toEqual(new Set(['namespace URI', 'status code', 'attribute value']));
  });
});

describe('scanSource self-test', () => {
  it('flags every contract namespace URI with its line number', () => {
    for (const uri of NS_URIS) {
      const src = `const a = 1;\nconst b = '${uri}';\n`;
      expect(scanSource(src, 'x.ts')).toEqual([
        { file: 'x.ts', line: 2, rule: 'namespace URI', literal: uri },
      ]);
    }
  });

  it('flags namespace-like URIs in double-quoted and template literals', () => {
    const src = [
      'const a = "https://schemas.xmlsoap.org/wsdl/";',
      'const b = `http://foo.ihg.com/schema/${version}`;',
    ].join('\n');
    expect(scanSource(src, 'routes/x.ts').map((f) => [f.line, f.rule])).toEqual([
      [1, 'namespace-like URI'],
      [2, 'namespace-like URI'],
    ]);
  });

  it("flags '0000' anywhere and 'O' / 'H' only in soap/ files", () => {
    const src = "if (code === '0000') x = 'O';\nconst loc = \"H\";\n";
    expect(scanSource(src, 'domain/x.ts').map((f) => f.rule)).toEqual(['status code']);
    expect(scanSource(src, 'soap/requestMapper.ts').map((f) => [f.line, f.literal])).toEqual([
      [1, '0000'],
      [1, 'O'],
      [2, 'H'],
    ]);
  });

  it("flags 'true' / 'false' passed directly to .att() in soap/ files", () => {
    const src =
      "phone.att('profileDefault', 'true');\nok.att('allHistory', DEFAULTS.allHistory);\n";
    expect(scanSource(src, 'soap/requestMapper.ts')).toEqual([
      {
        file: 'soap/requestMapper.ts',
        line: 1,
        rule: 'boolean attribute default',
        literal: "phone.att('profileDefault', 'true');",
      },
    ]);
    expect(scanSource(src, 'domain/x.ts')).toEqual([]);
  });

  it('ignores comments and keeps line numbers across block comments', () => {
    const src = [
      `// see ${NS.soap}`,
      `/* ${NS.common}`,
      `   '0000' 'O' */`,
      `const ok = 'fine'; // ${NS.svc}`,
      `const bad = '${NS.basic}';`,
    ].join('\n');
    expect(scanSource(src, 'soap/x.ts').map((f) => [f.line, f.rule])).toEqual([
      [5, 'namespace URI'],
    ]);
  });

  it('is not confused by regex literals, escaped quotes or URL-like division', () => {
    const src = [
      String.raw`const re = /['"]/g; const s = 'it\'s';`,
      'const half = total / 2 / 1;',
      String.raw`const url = 'http:\/\/schemas.xmlsoap.org/x';`,
    ].join('\n');
    expect(extractLiterals(src).literals.map((l) => l.value)).toEqual([
      "it's",
      'http://schemas.xmlsoap.org/x',
    ]);
    expect(scanSource(src, 'x.ts').map((f) => [f.line, f.rule])).toEqual([
      [3, 'namespace-like URI'],
    ]);
  });

  it('handles Windows line endings', () => {
    const src = `const a = 1;\r\nconst b = '${NS.initiate}';\r\n`;
    expect(scanSource(src, 'x.ts').map((f) => f.line)).toEqual([2]);
  });
});
