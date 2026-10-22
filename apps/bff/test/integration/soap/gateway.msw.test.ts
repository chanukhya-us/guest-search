// SoapGuestSearchGateway end to end over MSW 3 (task 6.4, Req 10.1, 10.9): real header
// builder, request mapper, transport, breaker and response parser; MSW answers with fixtures.
// Span, log and metric details are covered by test/unit/soap/soapGuestSearchGateway.test.ts.
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../../src/soap/circuitBreaker.js';
import { EL } from '../../../src/soap/contract.js';
import { SoapError, parseSearchGuestResponse } from '../../../src/soap/responseParser.js';
import { SoapGuestSearchGateway } from '../../../src/soap/soapGuestSearchGateway.js';
import { createSoapTransport } from '../../../src/soap/transport.js';
import { MSW_ENDPOINT, MSW_SOAP_ACTION, mswFetch, mswSoapCfg } from '../../helpers/msw.js';
import { readFixture } from '../../helpers/requestFixtures.js';
import { attr, findAll, parseXml } from '../../helpers/xmlRead.js';

const server = setupServer();
// MSW 3 renamed `onUnhandledRequest` to `onUnhandledFrame`.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REQUEST_ID = '00000000-0000-4000-8000-0000000000b1';
const CTX = { requestId: REQUEST_ID };
const QUERY: GuestSearchQuery = { lastName: 'Testguest' };
const FIXED = new Date('2026-10-21T12:00:00.000Z');

interface Seen {
  soapAction: string | null;
  contentType: string | null;
  transactionIds: (string | null)[];
}

/** Serve `fixture` with `status`, recording the SOAP headers and the envelope's transaction id. */
function serve(fixture: string, status: number, contentType = 'text/xml; charset=utf-8'): Seen[] {
  const seen: Seen[] = [];
  server.use(
    http.post(MSW_ENDPOINT, async ({ request }) => {
      const doc = parseXml(await request.text());
      seen.push({
        soapAction: request.headers.get('soapaction'),
        contentType: request.headers.get('content-type'),
        transactionIds: findAll(doc, [
          EL.envelope,
          EL.body,
          EL.searchGuestRequest,
          EL.header,
          EL.headerTransactionId,
        ]).map((e) => attr(e, 'id') ?? null),
      });
      return new HttpResponse(readFixture(fixture), {
        status,
        headers: { 'content-type': contentType },
      });
    }),
  );
  return seen;
}

function gateway(): SoapGuestSearchGateway {
  const cfg = mswSoapCfg();
  const breaker = new CircuitBreaker(cfg.breaker);
  const transport = createSoapTransport(cfg, { breaker, fetch: mswFetch });
  return new SoapGuestSearchGateway({ cfg, transport, now: () => FIXED });
}

async function soapRejection(p: Promise<unknown>): Promise<SoapError> {
  const e: unknown = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SoapError);
  return e as SoapError;
}

describe('SoapGuestSearchGateway over MSW (Req 10.9)', () => {
  it('200 with a success fixture gives the parsed results', async () => {
    const seen = serve('response-multiple.xml', 200);
    const out = await gateway().search(QUERY, CTX);

    expect(out.limit).toBe(50);
    expect(out.results).toHaveLength(3);
    expect(out.results).toEqual(parseSearchGuestResponse(readFixture('response-multiple.xml')));
    expect(seen).toEqual([
      {
        soapAction: MSW_SOAP_ACTION,
        contentType: 'text/xml; charset=utf-8',
        transactionIds: [REQUEST_ID],
      },
    ]);
  });

  it('500 with a SOAP Fault gives UPSTREAM_FAULT with the fault code only', async () => {
    serve('fault-server.xml', 500);
    const e = await soapRejection(gateway().search(QUERY, CTX));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_FAULT', 'soap:Server']);
  });

  it('502 with an HTML proxy page gives UPSTREAM_HTTP_ERROR with the status', async () => {
    const seen = serve('malformed-proxy-502.html', 502, 'text/html; charset=utf-8');
    const e = await soapRejection(gateway().search(QUERY, CTX));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_HTTP_ERROR', '502']);
    expect(seen).toHaveLength(1); // a response arrived: no retry
  });
});
