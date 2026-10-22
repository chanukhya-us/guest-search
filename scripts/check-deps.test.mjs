// Unit tests for the supply-chain gate in check-deps.mjs (Req 26.4).
import { describe, expect, it } from 'vitest';
import { collectPackages, compareVersions, findViolations, parseVersion } from './check-deps.mjs';

/** Builds a minimal `npm ls --json` tree. */
const tree = (dependencies) => ({ name: 'root', version: '0.0.0', dependencies });

describe('compareVersions', () => {
  it.each([
    ['0.9.12', '0.9.12', 0],
    ['0.9.13', '0.9.12', 1],
    ['0.10.0', '0.9.12', 1],
    ['1.0.0', '0.9.12', 1],
    ['0.9.11', '0.9.12', -1],
    ['0.8.15', '0.9.12', -1],
    ['0.9.2', '0.9.12', -1], // numeric, not lexical
    ['0.9.12-beta.1', '0.9.12', -1], // prerelease sorts before release
    ['0.9.12-beta.2', '0.9.12-beta.10', -1],
    ['0.9.12-alpha', '0.9.12-beta', -1],
    ['0.9.12+build.5', '0.9.12', 0], // build metadata ignored
  ])('compare(%s, %s) has sign %i', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
    expect(Math.sign(compareVersions(b, a))).toBe(-sign || 0);
  });

  it('throws on invalid versions', () => {
    expect(() => compareVersions('latest', '0.9.12')).toThrow(/Invalid version/);
    expect(parseVersion('0.9')).toBeNull();
  });
});

describe('collectPackages', () => {
  it('walks nested and workspace dependencies and skips missing entries', () => {
    const pkgs = collectPackages(
      tree({
        bff: {
          version: '0.0.0',
          dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } } },
        },
        gone: { required: '^1.0.0', missing: true },
      }),
    );
    expect(pkgs.map((p) => p.path)).toEqual(['bff', 'bff > a', 'bff > a > b']);
  });
});

describe('findViolations', () => {
  it('passes when xmldom is at or above 0.9.12 everywhere', () => {
    const result = findViolations(
      tree({
        '@xmldom/xmldom': { version: '0.9.12' },
        x: { version: '1.0.0', dependencies: { '@xmldom/xmldom': { version: '0.10.1' } } },
      }),
    );
    expect(result).toEqual([]);
  });

  it('fails when a transitive xmldom resolves below 0.9.12', () => {
    const result = findViolations(
      tree({
        '@xmldom/xmldom': { version: '0.9.12' },
        'xml-crypto': {
          version: '6.4.0',
          dependencies: { '@xmldom/xmldom': { version: '0.8.15' } },
        },
      }),
    );
    expect(result).toEqual(['@xmldom/xmldom@0.8.15 is below 0.9.12 (xml-crypto > @xmldom/xmldom)']);
  });

  it('fails closed on an unparseable xmldom version', () => {
    expect(findViolations(tree({ '@xmldom/xmldom': { version: 'git+https://x' } }))).toHaveLength(
      1,
    );
  });

  it('fails when libxmljs2 is present at any depth', () => {
    const result = findViolations(
      tree({ a: { version: '1.0.0', dependencies: { libxmljs2: { version: '0.37.0' } } } }),
    );
    expect(result).toEqual(['libxmljs2@0.37.0 is banned (a > libxmljs2)']);
  });
});
