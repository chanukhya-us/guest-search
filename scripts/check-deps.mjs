#!/usr/bin/env node
// Supply-chain gate for XML libraries (Req 26.4, design.md "Vulnerable XML libraries").
//
// Fails (exit 1) when, anywhere in the installed dependency tree (`npm ls --all --json`):
//   - @xmldom/xmldom resolves below 0.9.12 (older lines carry known parser CVEs), or
//   - libxmljs2 is present at all (banned: native libxml2 binding with XXE history).
//
// Fails closed: an unparseable xmldom version counts as a violation.
// The pure helpers are exported so the gate itself is unit-tested (scripts/check-deps.test.mjs).
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const XMLDOM = '@xmldom/xmldom';
export const XMLDOM_MIN = '0.9.12';
export const BANNED = ['libxmljs2'];

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses a semver string; returns null when it is not a plain x.y.z[-pre][+build] version. */
export function parseVersion(version) {
  const match = SEMVER.exec(String(version).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Compares two semver strings: negative if a < b, 0 if equal, positive if a > b.
 * A prerelease sorts before its release (0.9.12-beta < 0.9.12). Throws on invalid input.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Invalid version: ${!pa ? a : b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function comparePrerelease(a, b) {
  const ia = a.split('.');
  const ib = b.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb && Number(ia[i]) !== Number(ib[i])) return Number(ia[i]) - Number(ib[i]);
    if (na !== nb) return na ? -1 : 1;
    if (!na && ia[i] !== ib[i]) return ia[i] < ib[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Walks an `npm ls --json` tree and yields every resolved package as
 * { name, version, path }. Entries without a version (missing/unmet) are skipped.
 */
export function collectPackages(tree) {
  const found = [];
  const walk = (deps, trail) => {
    if (!deps || typeof deps !== 'object') return;
    for (const [name, node] of Object.entries(deps)) {
      if (!node || typeof node !== 'object') continue;
      const path = [...trail, name];
      if (typeof node.version === 'string') {
        found.push({ name, version: node.version, path: path.join(' > ') });
      }
      walk(node.dependencies, path);
    }
  };
  walk(tree?.dependencies, []);
  return found;
}

/** Returns human-readable violations for an `npm ls --json` tree; empty array means pass. */
export function findViolations(tree) {
  const violations = [];
  for (const pkg of collectPackages(tree)) {
    if (BANNED.includes(pkg.name)) {
      violations.push(`${pkg.name}@${pkg.version} is banned (${pkg.path})`);
    } else if (pkg.name === XMLDOM) {
      const ok = parseVersion(pkg.version) && compareVersions(pkg.version, XMLDOM_MIN) >= 0;
      if (!ok) {
        violations.push(`${XMLDOM}@${pkg.version} is below ${XMLDOM_MIN} (${pkg.path})`);
      }
    }
  }
  return violations;
}

/** Runs `npm ls --all --json` and returns the parsed tree. */
function readNpmTree() {
  let stdout;
  try {
    // Fixed literal command (no user input), run through the shell so the npm .cmd shim
    // resolves on Windows too.
    stdout = execSync('npm ls --all --json', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // npm ls exits non-zero for tree problems (e.g. extraneous packages) but still prints JSON.
    stdout = error.stdout;
    if (!stdout) throw error;
  }
  return JSON.parse(stdout);
}

function main() {
  const violations = findViolations(readNpmTree());
  if (violations.length > 0) {
    console.error('check-deps: FAILED');
    for (const v of violations) console.error(`  - ${v}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `check-deps: OK (${XMLDOM} >= ${XMLDOM_MIN} everywhere; ${BANNED.join(', ')} absent)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
