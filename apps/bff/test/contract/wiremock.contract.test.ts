/**
 * OPTIONAL Docker-gated WireMock contract test (task 13.2; design.md "Contract stub" row:
 * testcontainers + WireMock 3.13.2, "Gateway against real HTTP + fixtures, delay → timeout,
 * 502 HTML").
 *
 * The default CI path is Docker-free — `nodeMock.contract.test.ts` covers the same intent
 * against the zero-Docker Node mock. This file is the faithful, container-based variant and is
 * SKIPPED cleanly when no container runtime is present (`probeDocker`), so CI without Docker
 * stays green and never hangs. Run it explicitly with `RUN_CONTAINER_TESTS=true` on a host with
 * Docker, or let auto-detect pick it up when a Docker socket/pipe exists.
 *
 * It starts `wiremock/wiremock:3.13.2` via testcontainers, mounting the SAME artefacts the
 * local stack uses (so the fixtures remain the single source of response bytes):
 *   - `tools/wiremock/mappings`            -> /home/wiremock/mappings  (surname → scenario)
 *   - `apps/bff/test/fixtures/soap`        -> /home/wiremock/__files   (response bodies)
 * Then it points the REAL `SoapGuestSearchGateway` (header builder, mapper, undici transport,
 * breaker, parser) at the mapped port over real HTTP, and asserts each surname scenario maps
 * to the right domain result or `SoapError` code.
 *
 * Scenario coverage (design.md WireMock table):
 *   Single → 1 guest · Many → 60 · Nobody → empty · Fault → UPSTREAM_FAULT ·
 *   Broken → UPSTREAM_TXN_FAILED · Slow → UPSTREAM_TIMEOUT · Proxy → UPSTREAM_HTTP_ERROR.
 */
import { fileURLToPath } from 'node:url';
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../src/soap/circuitBreaker.js';
import { SoapError } from '../../src/soap/responseParser.js';
import { SoapGuestSearchGateway } from '../../src/soap/soapGuestSearchGateway.js';
import { createSoapTransport } from '../../src/soap/transport.js';
import { probeDocker } from '../helpers/docker.js';
import { mswSoapCfg } from '../helpers/msw.js';

const probe = probeDocker();
// Dev tooling: a console note is the intended way to tell the operator WHY the test ran or not.
// (The BFF `no-console` rule applies to `src/`, not tests.)
// eslint-disable-next-line no-console
console.info(
  probe.available
    ? `[wiremock.contract] Docker detected (${probe.reason}); running the container contract test.`
    : `[wiremock.contract] SKIPPED — ${probe.reason}. The Docker-free Node-mock contract test ` +
        `(nodeMock.contract.test.ts) covers this intent; set RUN_CONTAINER_TESTS=true on a host ` +
        `with Docker to run the container variant.`,
);

const REQUEST_ID = '00000000-0000-4000-8000-00000000d132';
const CTX = { requestId: REQUEST_ID };
const FIXED = new Date('2026-10-21T12:00:00.000Z');
const WIREMOCK_IMAGE = 'wiremock/wiremock:3.13.2';
const WIREMOCK_PORT = 8080;
const MOCK_PATH = '/InitiateService';

const MAPPINGS_DIR = fileURLToPath(new URL('../../../../tools/wiremock/mappings', import.meta.url));
const FILES_DIR = fileURLToPath(new URL('../fixtures/soap', import.meta.url));

// testcontainers can be slow to pull the image on a cold cache; give the suite room.
const STARTUP_TIMEOUT_MS = 180_000;

// `StartedTestContainer` is typed loosely here so the file never imports testcontainers at the
// top level — the dynamic import below only runs when Docker is available.
let container: { stop: () => Promise<unknown>; getMappedPort: (p: number) => number } | undefined;
let endpoint: URL;

/** Gateway pointed at the running WireMock over real HTTP. `responseTimeoutMs` forces the Slow case. */
function gateway(responseTimeoutMs = 10_000): SoapGuestSearchGateway {
  const cfg = mswSoapCfg({ endpoint, maxResults: 60, responseTimeoutMs });
  const breaker = new CircuitBreaker(cfg.breaker);
  const transport = createSoapTransport(cfg, { breaker });
  return new SoapGuestSearchGateway({ cfg, transport, now: () => FIXED });
}

async function soapRejection(p: Promise<unknown>): Promise<SoapError> {
  const e: unknown = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SoapError);
  return e as SoapError;
}

describe.skipIf(!probe.available)('SoapGuestSearchGateway over WireMock (testcontainers)', () => {
  beforeAll(async () => {
    // Import testcontainers only when Docker is available, so the skip path never touches it.
    const { GenericContainer, Wait } = await import('testcontainers');
    const started = await new GenericContainer(WIREMOCK_IMAGE)
      .withExposedPorts(WIREMOCK_PORT)
      .withCommand(['--port', String(WIREMOCK_PORT), '--global-response-templating'])
      .withCopyDirectoriesToContainer([
        { source: MAPPINGS_DIR, target: '/home/wiremock/mappings' },
        { source: FILES_DIR, target: '/home/wiremock/__files' },
      ])
      // WireMock serves /__admin/health once the stub is ready.
      .withWaitStrategy(Wait.forHttp('/__admin/health', WIREMOCK_PORT).forStatusCode(200))
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start();
    container = started;
    endpoint = new URL(
      `http://${started.getHost()}:${started.getMappedPort(WIREMOCK_PORT)}${MOCK_PATH}`,
    );
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await container?.stop();
  });

  const search = (lastName: string): Promise<{ results: unknown[]; limit: number }> => {
    const query: GuestSearchQuery = { lastName };
    return gateway().search(query, CTX);
  };

  it('Single -> one parsed guest', async () => {
    const out = await search('Single');
    expect(out.results).toHaveLength(1);
  });

  it('Many -> the full 60-guest set', async () => {
    const out = await search('Many');
    expect(out.results).toHaveLength(60);
    expect(out.limit).toBe(60);
  });

  it('Nobody -> empty results (successful)', async () => {
    const out = await search('Nobody');
    expect(out.results).toHaveLength(0);
  });

  it('Fault -> UPSTREAM_FAULT with the fault code only', async () => {
    const e = await soapRejection(search('Fault'));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_FAULT', 'soap:Server']);
  });

  it('Broken -> UPSTREAM_TXN_FAILED with the status code', async () => {
    const e = await soapRejection(search('Broken'));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_TXN_FAILED', '1001']);
  });

  it('Slow -> UPSTREAM_TIMEOUT (the 15s stub delay exceeds the response timeout)', async () => {
    // A short response timeout turns the stub's fixed delay into a clean timeout quickly.
    const e = await soapRejection(gateway(1_000).search({ lastName: 'Slow' }, CTX));
    expect(e.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('Proxy -> UPSTREAM_HTTP_ERROR with the 502 status', async () => {
    const e = await soapRejection(search('Proxy'));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_HTTP_ERROR', '502']);
  });
});
