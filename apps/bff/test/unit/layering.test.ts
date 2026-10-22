// Layer-rule import scan (task 6.3, Req 6.8; design.md "Layer rules"): src/ports/** depends
// only on @ihg-guest-search/shared and other port modules, never on soap/ or any adapter.
import { readFileSync, readdirSync } from 'node:fs';
import { posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));
const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;

/** Module specifiers of static imports/exports, side-effect imports and dynamic `import()`. */
const SPECIFIER =
  /(?:\bimport\s*(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s*)?|\bexport\s*(?:type\s+)?[\w*{}\s,$]+\s+from\s*|\bimport\s*\(\s*)(['"])([^'"]+)\1/g;

function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return Array.from(code.matchAll(SPECIFIER), (m) => m[2] as string);
}

/** Violations for one ports/ file (`file` is POSIX, relative to src/). */
function portViolations(file: string, source: string): string[] {
  return importSpecifiers(source)
    .filter((spec) => {
      if (spec === '@ihg-guest-search/shared') return false;
      if (!spec.startsWith('.')) return true; // any other package (fastify, undici, ...)
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      return !target.startsWith('ports/');
    })
    .map((spec) => `src/${file} imports '${spec}'`);
}

function listSources(dir: string): string[] {
  return readdirSync(SRC_DIR + dir, { recursive: true, encoding: 'utf8' })
    .map((p) => posix.join(dir, p.split(sep).join('/')))
    .filter((p) => SOURCE_FILE.test(p) && !p.endsWith('.d.ts'))
    .sort();
}

describe('layer rules (Req 6.8)', () => {
  it('src/ports/** imports only @ihg-guest-search/shared and other ports', () => {
    const files = listSources('ports');
    expect(files).toContain('ports/GuestSearchGateway.ts');
    const violations = files.flatMap((f) => portViolations(f, readFileSync(SRC_DIR + f, 'utf8')));
    expect(violations).toEqual([]);
  });
});

describe('import scan self-test', () => {
  it('finds every import form and ignores comments', () => {
    const src = [
      "import type { A } from '../soap/contract.js';",
      'import { b,',
      '  c } from "fastify";',
      "import './side-effect.js';",
      "export * from '../soap/transport.js';",
      "export type { D } from './Other.js';",
      "const m = await import('../soap/x.js');",
      "// import x from '../soap/commented.js';",
      "/* import y from '../soap/block.js'; */",
      "const url = 'https://example.test'; // trailing",
    ].join('\n');
    expect(importSpecifiers(src)).toEqual([
      '../soap/contract.js',
      'fastify',
      './side-effect.js',
      '../soap/transport.js',
      './Other.js',
      '../soap/x.js',
    ]);
  });

  it('flags soap/, adapter and package imports from ports, allows shared and sibling ports', () => {
    const src = [
      "import type { Q } from '@ihg-guest-search/shared';",
      "import type { P } from './Other.js';",
      "import { SoapError } from '../soap/responseParser.js';",
      "import type { AppConfig } from '../config.js';",
      "import { Agent } from 'undici';",
    ].join('\n');
    expect(portViolations('ports/X.ts', src)).toEqual([
      "src/ports/X.ts imports '../soap/responseParser.js'",
      "src/ports/X.ts imports '../config.js'",
      "src/ports/X.ts imports 'undici'",
    ]);
  });
});
