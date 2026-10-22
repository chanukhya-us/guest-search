/**
 * Runtime bridge to the zero-Docker Node mock SOAP server (`tools/mock-soap`), for the
 * Docker-free contract test (task 13.2).
 *
 * Why a bridge rather than a direct import: `tools/` is dev tooling with its own tsconfig and
 * `allowImportingTsExtensions`. The BFF test program (`apps/bff/tsconfig.test.json`, `rootDir:
 * "."`) cannot pull those `.ts` files into its type graph without TS6059/TS5097. We therefore
 * load the mock through a runtime-computed specifier that `tsc` does not follow, and declare
 * the small surface the contract test uses here. Vitest/Vite resolves the specifier at run time
 * (the `.js` → `.ts` source condition is the same one the repo already uses), so the test still
 * exercises the REAL mock handler, seed and listener — no fakes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** One synthetic seed guest (the fields the contract test reads). Mirrors `tools/mock-soap/seed.ts`. */
export interface MockSeedGuest {
  readonly enterpriseId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly country: string;
  readonly score: number;
}

export interface MockListenerOptions {
  path?: string;
  log?: (line: string) => void;
}

type ServerModule = {
  createMockListener: (
    options?: MockListenerOptions,
  ) => (req: IncomingMessage, res: ServerResponse) => void;
};

type SeedModule = { SEED: readonly MockSeedGuest[] };

/** Absolute URLs to the mock modules, resolved from this file. Not literals, so `tsc` stops here. */
const serverUrl = new URL('../../../../tools/mock-soap/server.ts', import.meta.url).href;
const seedUrl = new URL('../../../../tools/mock-soap/seed.ts', import.meta.url).href;

/** Load the real mock listener factory (identical behaviour to `npm run mock:soap`). */
export async function loadMockListenerFactory(): Promise<ServerModule['createMockListener']> {
  const mod = (await import(/* @vite-ignore */ serverUrl)) as ServerModule;
  return mod.createMockListener;
}

/** Load the real synthetic seed (60 guests). */
export async function loadMockSeed(): Promise<readonly MockSeedGuest[]> {
  const mod = (await import(/* @vite-ignore */ seedUrl)) as SeedModule;
  return mod.SEED;
}
