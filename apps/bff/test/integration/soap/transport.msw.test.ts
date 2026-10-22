// SOAP transport over MSW 3 (task 6.4, Req 10.1–10.7). The real transport and breaker send
// through `globalThis.fetch`, which MSW intercepts; handlers check what goes on the wire.
// Unit-level edge cases (AggregateError causes, TLS codes, body-phase timeout, UTF-8 chunk
// splits) stay in test/unit/soap/transport.test.ts. See test/helpers/msw.ts for the MSW
// behaviours these tests work around.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CIRCUIT_OPEN, CircuitBreaker } from '../../../src/soap/circuitBreaker.js';
import { SoapError } from '../../../src/soap/responseParser.js';
import { CONTENT_TYPE, DETAIL, createSoapTransport } from '../../../src/soap/transport.js';
import {
  MSW_CHANNEL_ID,
  MSW_ENDPOINT,
  MSW_SOAP_ACTION,
  mswFetch,
  mswSoapCfg,
  observeBody,
  untilAborted,
} from '../../helpers/msw.js';
import { buildReference, REFERENCE_HEADER } from '../../helpers/requestFixtures.js';

const server = setupServer();
// MSW 3 renamed `onUnhandledRequest` to `onUnhandledFrame`.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ENVELOPE = buildReference('request-name-phone.xml');
const TRANSACTION_ID = REFERENCE_HEADER.transactionId;
const CTX = { requestId: 'req-msw-0001' };

const breaker = (failureThreshold = 5) => new CircuitBreaker({ failureThreshold, openMs: 30_000 });

async function sendError(p: Promise<unknown>): Promise<SoapError> {
  const e: unknown = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SoapError);
  return e as SoapError;
}

/** A URL on a local port that was just closed: connecting to it is refused. */
async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}/soap`;
}

describe('MSW setup', () => {
  it('rejects requests no handler matches (onUnhandledFrame: error), so nothing leaks out', async () => {
    const t = createSoapTransport(mswSoapCfg(), { breaker: breaker(), fetch: mswFetch });
    // MSW's own uncoded error, not a DNS failure (ENOTFOUND) from a request that went out.
    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: DETAIL.fetchFailed });
  });
});

describe('request on the wire (Req 10.1)', () => {
  it('POSTs the envelope with the sample HTTP headers (content-type, SOAPAction, channel id, accept)', async () => {
    const seen: { method: string; url: string; headers: Headers; body: string }[] = [];
    server.use(
      http.post(MSW_ENDPOINT, async ({ request }) => {
        seen.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: await request.text(),
        });
        return new HttpResponse('<ok/>', { headers: { 'content-type': CONTENT_TYPE } });
      }),
    );
    const t = createSoapTransport(mswSoapCfg(), { breaker: breaker(), fetch: mswFetch });
    await expect(t.send(ENVELOPE, CTX)).resolves.toMatchObject({ status: 200, body: '<ok/>' });

    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect([req.method, req.url]).toEqual(['POST', MSW_ENDPOINT]);
    expect(req.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(req.headers.get('soapaction')).toBe(MSW_SOAP_ACTION);
    expect(req.headers.get('ihg-channelid')).toBe(MSW_CHANNEL_ID);
    expect(req.headers.get('accept')).toBe('*/*');
    expect(req.body).toBe(ENVELOPE);
    expect(req.body).toContain(TRANSACTION_ID);
    // requestId is for logs only: never in the URL or any header.
    const headerText = JSON.stringify([...req.headers]);
    expect(req.url + headerText).not.toContain(CTX.requestId);
  });
});

describe('timeout (Req 10.3)', () => {
  it('a response slower than responseTimeoutMs gives UPSTREAM_TIMEOUT with no retry', async () => {
    let hits = 0;
    server.use(
      http.post(MSW_ENDPOINT, async ({ request }) => {
        hits += 1;
        await untilAborted(request.signal);
        return new HttpResponse('<late/>');
      }),
    );
    const t = createSoapTransport(mswSoapCfg({ responseTimeoutMs: 50 }), {
      breaker: breaker(),
      fetch: mswFetch,
    });
    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e.code).toBe('UPSTREAM_TIMEOUT');
    expect(hits).toBe(1);
  });
});

describe('connection failures and retry (Req 10.4, 10.5)', () => {
  // MSW cannot fabricate a coded socket error, so passthrough() lets the intercepted request
  // reach a closed local port: a real ECONNREFUSED, seen by MSW on both attempts.
  it('a refused connection is retried once, then gives UPSTREAM_UNAVAILABLE', async () => {
    const dead = await closedPortUrl();
    let hits = 0;
    server.use(
      http.post(dead, () => {
        hits += 1;
        return passthrough();
      }),
    );
    const t = createSoapTransport(mswSoapCfg({ endpoint: new URL(dead) }), {
      breaker: breaker(),
      fetch: mswFetch,
    });
    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: 'ECONNREFUSED' });
    expect(hits).toBe(2);
  });

  it('an uncoded network error (HttpResponse.error) is UNAVAILABLE / FETCH_FAILED, no retry', async () => {
    let hits = 0;
    server.use(
      http.post(MSW_ENDPOINT, () => {
        hits += 1;
        return HttpResponse.error();
      }),
    );
    const t = createSoapTransport(mswSoapCfg(), { breaker: breaker(), fetch: mswFetch });
    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: DETAIL.fetchFailed });
    expect(hits).toBe(1);
  });

  it('never retries once a response arrived (503 is returned to the caller as-is)', async () => {
    let hits = 0;
    server.use(
      http.post(MSW_ENDPOINT, () => {
        hits += 1;
        return new HttpResponse('<busy/>', { status: 503 });
      }),
    );
    const t = createSoapTransport(mswSoapCfg(), { breaker: breaker(), fetch: mswFetch });
    await expect(t.send(ENVELOPE, CTX)).resolves.toMatchObject({ status: 503, body: '<busy/>' });
    expect(hits).toBe(1);
  });
});

describe('body size cap (Req 10.6)', () => {
  const CAP = 1_024;

  it('a streamed body over maxResponseBytes gives UPSTREAM_MALFORMED and is cancelled', async () => {
    const chunk = new Uint8Array(256).fill(0x78);
    server.use(
      http.post(MSW_ENDPOINT, () => {
        let sent = 0;
        // Finite: MSW drains handler streams before the client sees headers.
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent >= 64) c.close();
            else c.enqueue(chunk);
            sent += 1;
          },
        });
        return new HttpResponse(body, { headers: { 'content-type': CONTENT_TYPE } });
      }),
    );
    const { fetch, stats } = observeBody();
    const t = createSoapTransport(mswSoapCfg({ maxResponseBytes: CAP }), {
      breaker: breaker(),
      fetch,
    });
    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e).toMatchObject({ code: 'UPSTREAM_MALFORMED', detail: DETAIL.bodyTooLarge });
    expect(stats.cancelled).toBe(true);
    expect(stats.bytes).toBeGreaterThan(CAP);
  });

  it('a Content-Length over maxResponseBytes is rejected before any body byte is read', async () => {
    const big = 'x'.repeat(CAP + 1);
    server.use(
      http.post(
        MSW_ENDPOINT,
        () => new HttpResponse(big, { headers: { 'content-length': String(big.length) } }),
      ),
    );
    const { fetch, stats } = observeBody();
    const t = createSoapTransport(mswSoapCfg({ maxResponseBytes: CAP }), {
      breaker: breaker(),
      fetch,
    });
    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e).toMatchObject({ code: 'UPSTREAM_MALFORMED', detail: DETAIL.bodyTooLarge });
    expect(stats.cancelled).toBe(true);
    expect(stats.bytes).toBe(0);
  });
});

describe('circuit breaker (Req 10.7)', () => {
  it('an open circuit fails fast and sends no request', async () => {
    let hits = 0;
    server.use(
      http.post(MSW_ENDPOINT, () => {
        hits += 1;
        return HttpResponse.error();
      }),
    );
    const b = breaker(1);
    const t = createSoapTransport(mswSoapCfg(), { breaker: b, fetch: mswFetch });
    expect((await sendError(t.send(ENVELOPE, CTX))).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(b.state).toBe('open');
    expect(hits).toBe(1);

    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: CIRCUIT_OPEN });
    expect(hits).toBe(1);
  });
});
