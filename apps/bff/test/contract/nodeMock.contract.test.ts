/**
 * Docker-free SOAP contract test (task 13.2).
 *
 * design.md ("Testing strategy" row "Contract stub") asks for a real over-the-wire check of
 * the gateway against a SOAP stub, originally via testcontainers + WireMock. The local MVP is
 * NO-Docker by default (task 13.1), so this is the default-CI contract test: it honours the
 * same intent — the REAL `SoapGuestSearchGateway` exercised end to end over a real socket —
 * but boots the zero-Docker Node mock SOAP server (`tools/mock-soap`) instead of a container.
 * The Docker-gated WireMock variant lives in `wiremock.contract.test.ts` and skips when Docker
 * is unavailable.
 *
 * What "real" means here (no fakes):
 *   - A real `http.Server` binds an ephemeral TCP port and answers real HTTP POSTs using the
 *     mock's own listener (`createMockListener`), wrapped only to tap the request bytes.
 *   - The gateway runs the REAL header builder, request mapper, undici transport (through the
 *     circuit breaker) and response parser — no injected `fetch`, no `fastify.inject`.
 *   - The transport's own undici Agent connects to the mock over the loopback socket.
 *
 * Coverage of the design.md scenarios, mapped onto the Node mock's behaviour:
 *   - happy path: a criteria-driven search returns parsed, domain-mapped guests, and the
 *     envelope the mock received is a well-formed `searchGuestRequest` carrying the criteria;
 *     a surname narrows the result set (filtering really happened over the wire);
 *   - `nomatch`     -> empty results (successful, zero guests);
 *   - `fault`       -> SoapError UPSTREAM_FAULT (the parser + gateway error mapping over the wire);
 *   - `boom`/`many` -> the capped seed set (maxResults cap honoured end to end).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../src/soap/circuitBreaker.js';
import { SoapError } from '../../src/soap/responseParser.js';
import { SoapGuestSearchGateway } from '../../src/soap/soapGuestSearchGateway.js';
import { createSoapTransport } from '../../src/soap/transport.js';
import { loadMockListenerFactory, loadMockSeed, type MockSeedGuest } from '../helpers/mockSoap.js';
import { mswSoapCfg } from '../helpers/msw.js';
import { readMappedRequest } from '../helpers/xmlRead.js';

const REQUEST_ID = '00000000-0000-4000-8000-00000000d132';
const CTX = { requestId: REQUEST_ID };
const FIXED = new Date('2026-10-21T12:00:00.000Z');
const MOCK_PATH = '/InitiateService';
/** Honoured end to end: the mock caps at this and the gateway reports it as `limit`. */
const MAX_RESULTS = 50;
/** A surname present in the seed, used for the narrowing check (its exact count comes from SEED). */
const SEED_SURNAME = 'Garcia';

let server: Server;
let endpoint: URL;
let seed: readonly MockSeedGuest[];
let seedSurnameCount: number;
/** The raw body of the most recent request the mock received (the real envelope on the wire). */
let lastRequestBody = '';

/**
 * Wrap the real Node-mock listener so each incoming POST body is captured into
 * `lastRequestBody` before the mock handles it. The mock's response behaviour is unchanged —
 * we only tap the request bytes so a test can read the envelope back by namespace + local name.
 * Node delivers `data` chunks to every listener, so this tap and the mock's own body reader
 * both see the same bytes.
 */
function capturingListener(
  inner: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastRequestBody = Buffer.concat(chunks).toString('utf8');
      });
    }
    inner(req, res);
  };
}

/** A gateway whose transport points at the live mock over a real loopback socket. */
function gateway(): SoapGuestSearchGateway {
  const cfg = mswSoapCfg({ endpoint, maxResults: MAX_RESULTS });
  const breaker = new CircuitBreaker(cfg.breaker);
  // No `fetch` injected: the transport uses undici's own fetch + Agent over the real socket.
  const transport = createSoapTransport(cfg, { breaker });
  return new SoapGuestSearchGateway({ cfg, transport, now: () => FIXED });
}

async function soapRejection(p: Promise<unknown>): Promise<SoapError> {
  const e: unknown = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SoapError);
  return e as SoapError;
}

beforeAll(async () => {
  const createMockListener = await loadMockListenerFactory();
  seed = await loadMockSeed();
  seedSurnameCount = seed.filter((g) => g.lastName === SEED_SURNAME).length;

  const inner = createMockListener({ path: MOCK_PATH, log: () => undefined });
  server = createServer(capturingListener(inner));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  endpoint = new URL(`http://127.0.0.1:${port}${MOCK_PATH}`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('SoapGuestSearchGateway over the live Node mock SOAP server (task 13.2, no Docker)', () => {
  it('happy path: a surname search returns parsed, domain-mapped guests and narrows the set', async () => {
    const query: GuestSearchQuery = { lastName: SEED_SURNAME };
    const out = await gateway().search(query, CTX);

    // Parsed, domain-mapped guests came back, and the capped limit is reported.
    expect(out.limit).toBe(MAX_RESULTS);
    expect(out.results.length).toBeGreaterThan(0);
    // Filtering really happened over the wire: the surname narrows the 60 seed guests to a subset.
    expect(out.results.length).toBe(seedSurnameCount);
    expect(out.results.length).toBeLessThan(seed.length);
    // Every returned guest actually matches the criterion (the mock filtered, the parser mapped).
    for (const g of out.results) {
      expect(g.lastName).toBe(SEED_SURNAME);
      // A domain-mapped guest, not raw XML: it carries an enterprise id and mapped collections.
      expect(typeof g.enterpriseId).toBe('string');
      expect(g.enterpriseId.length).toBeGreaterThan(0);
      expect(Array.isArray(g.emails)).toBe(true);
      expect(Array.isArray(g.phones)).toBe(true);
    }
    // Default score-descending order is preserved through the parser.
    const scores = out.results.map((g) => g.score ?? Number.NEGATIVE_INFINITY);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('combined criteria narrow further and the mock echoes them in a valid envelope', async () => {
    const query: GuestSearchQuery = { firstName: 'Avery', lastName: SEED_SURNAME };
    const out = await gateway().search(query, CTX);

    expect(out.results.length).toBeGreaterThan(0);
    for (const g of out.results) {
      expect(g.firstName).toBe('Avery');
      expect(g.lastName).toBe(SEED_SURNAME);
    }

    // The bytes the mock received parse as a searchGuestRequest and carry both criteria,
    // read back by namespace URI + local name (never by prefix). This is the real envelope
    // the gateway's mapper + transport put on the socket, not a reconstruction.
    const mapped = readMappedRequest(lastRequestBody);
    expect(mapped.firstName).toBe('Avery');
    expect(mapped.lastName).toBe(SEED_SURNAME);
  });

  it('nomatch -> successful empty result (zero guests, no error)', async () => {
    const out = await gateway().search({ lastName: 'nomatch' }, CTX);
    expect(out.results).toEqual([]);
    expect(out.limit).toBe(MAX_RESULTS);
  });

  it('fault -> SoapError UPSTREAM_FAULT mapped by the real parser over the wire', async () => {
    const e = await soapRejection(gateway().search({ lastName: 'fault' }, CTX));
    expect(e.code).toBe('UPSTREAM_FAULT');
    // The parser surfaces the faultcode only (never the fault text); the mock sends soap:Server.
    expect(e.detail).toBe('soap:Server');
  });

  it('boom/many -> the capped seed set (maxResults honoured end to end)', async () => {
    const boom = await gateway().search({ lastName: 'boom' }, CTX);
    const many = await gateway().search({ lastName: 'many' }, CTX);

    // The seed has 60 guests; maxResults caps the response at 50.
    expect(boom.results.length).toBe(Math.min(seed.length, MAX_RESULTS));
    expect(boom.results.length).toBe(MAX_RESULTS);
    // "many" is an alias of "boom": identical capped set.
    expect(many.results.length).toBe(boom.results.length);
  });
});
