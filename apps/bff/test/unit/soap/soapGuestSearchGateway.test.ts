// Unit tests for SoapGuestSearchGateway (task 6.3, Req 6.8, 10.9). A fake SoapTransport
// returns fixture bodies with chosen statuses; a fake tracer records span attributes.
// MSW-based end-to-end gateway tests are task 6.4.
import type { Span, Tracer } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import type { GuestSearchQuery } from '@ihg-guest-search/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config.js';
import { AppError } from '../../../src/errors.js';
import { EL } from '../../../src/soap/contract.js';
import { SoapError, parseSearchGuestResponse } from '../../../src/soap/responseParser.js';
import {
  OTHER_ERROR,
  SPAN_NAME,
  SoapGuestSearchGateway,
  type GatewayLogger,
  type GatewayMetrics,
} from '../../../src/soap/soapGuestSearchGateway.js';
import type { SoapHttpResult, SoapTransport } from '../../../src/soap/transport.js';
import { readFixture } from '../../helpers/requestFixtures.js';
import { attr, findAll, parseXml } from '../../helpers/xmlRead.js';

const REQUEST_ID = '00000000-0000-4000-8000-0000000000a1';
const CTX = { requestId: REQUEST_ID };
const QUERY: GuestSearchQuery = { lastName: 'Single' };
const FIXED = new Date('2026-10-21T12:00:00.000Z');
const MAX_RESULTS = 50;

const cfg: AppConfig['soap'] = {
  endpoint: new URL('https://soap.example.test/GuestService'),
  soapAction: 'searchGuest',
  channelId: 'TEST-CHANNEL-ID',
  connectTimeoutMs: 3000,
  responseTimeoutMs: 10_000,
  maxResponseBytes: 5_000_000,
  maxResults: MAX_RESULTS,
  features: { addressLine1: false, city: false, postalCode: false },
  header: {
    languageCode: 'en',
    countryCode: 'US',
    channel: 'TEST-CHANNEL',
    subChannels: ['TEST-SUB'],
    environment: 'local',
    serviceUser: 'svc-test-user',
    sequence: 1,
  },
  breaker: { failureThreshold: 5, openMs: 30_000 },
};

/** A transport that records envelopes and answers with `reply`. */
function fakeTransport(reply: SoapHttpResult | Error) {
  const sent: { envelope: string; ctx: { requestId: string } }[] = [];
  const transport: SoapTransport = {
    send(envelope, ctx) {
      sent.push({ envelope, ctx });
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
  return { transport, sent };
}

const ok = (fixture: string, status = 200): SoapHttpResult => ({
  status,
  body: readFixture(fixture),
  durationMs: 42,
});

/** A tracer whose single span records attributes, status and end. */
function fakeTracer() {
  const rec = {
    name: '',
    attrs: {} as Record<string, unknown>,
    status: undefined as { code: SpanStatusCode; message?: string } | undefined,
    ended: false,
    exceptions: 0,
  };
  const span = {
    setAttribute(k: string, v: unknown) {
      rec.attrs[k] = v;
      return span;
    },
    setStatus(s: { code: SpanStatusCode; message?: string }) {
      rec.status = s;
      return span;
    },
    recordException() {
      rec.exceptions += 1;
    },
    end() {
      rec.ended = true;
    },
  };
  const tracer = {
    startActiveSpan(name: string, fn: (s: Span) => unknown) {
      rec.name = name;
      return fn(span as unknown as Span);
    },
  } as unknown as Tracer;
  return { tracer, rec };
}

function setup(reply: SoapHttpResult | Error) {
  const { transport, sent } = fakeTransport(reply);
  const { tracer, rec } = fakeTracer();
  const logger = { info: vi.fn(), warn: vi.fn() } satisfies GatewayLogger;
  const metrics = { soapCall: vi.fn() } satisfies GatewayMetrics;
  const gateway = new SoapGuestSearchGateway({
    cfg,
    transport,
    now: () => FIXED,
    logger,
    metrics,
    tracer,
  });
  return { gateway, sent, rec, logger, metrics };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

async function soapRejection(p: Promise<unknown>): Promise<SoapError> {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(SoapError);
  return e as SoapError;
}

describe('SoapGuestSearchGateway success', () => {
  it('returns the parsed fixture results and limit = maxResults', async () => {
    const { gateway, metrics } = setup(ok('response-multiple.xml'));
    const out = await gateway.search(QUERY, CTX);
    expect(out.results).toEqual(parseSearchGuestResponse(readFixture('response-multiple.xml')));
    expect(out.results).toHaveLength(3);
    expect(out.limit).toBe(MAX_RESULTS);
    expect(metrics.soapCall).toHaveBeenCalledWith(42, { status: 200 });
  });

  it('sends an envelope whose header transaction id and timestamp come from ctx and now', async () => {
    const { gateway, sent } = setup(ok('response-empty.xml'));
    await gateway.search(QUERY, CTX);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ctx).toEqual({ requestId: REQUEST_ID });
    const doc = parseXml(sent[0]?.envelope ?? '');
    const header = [EL.envelope, EL.body, EL.searchGuestRequest, EL.header];
    expect(findAll(doc, [...header, EL.headerTransactionId]).map((e) => attr(e, 'id'))).toEqual([
      REQUEST_ID,
    ]);
    expect(findAll(doc, [...header, EL.headerSendTimeStamp]).map((e) => e.textContent)).toEqual([
      FIXED.toISOString(),
    ]);
  });

  it('records non-PII span attributes and logs no payload', async () => {
    const { gateway, rec, logger } = setup(ok('response-single.xml'));
    await gateway.search(QUERY, CTX);
    expect(rec.name).toBe(SPAN_NAME);
    expect(rec.attrs).toEqual({
      'request.id': REQUEST_ID,
      'http.response.status_code': 200,
      'soap.duration_ms': 42,
      'soap.result_count': 1,
    });
    expect(rec.status).toBeUndefined();
    expect(rec.ended).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { requestId: REQUEST_ID, status: 200, durationMs: 42, resultCount: 1 },
      expect.any(String),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('Single');
  });

  it('works with the default no-op logger, metrics and global (no-op) tracer', async () => {
    const { transport } = fakeTransport(ok('response-single.xml'));
    const gateway = new SoapGuestSearchGateway({ cfg, transport, now: () => FIXED });
    await expect(gateway.search(QUERY, CTX)).resolves.toMatchObject({ limit: MAX_RESULTS });
    const failing = new SoapGuestSearchGateway({
      cfg,
      transport: fakeTransport(new SoapError('UPSTREAM_TIMEOUT')).transport,
      now: () => FIXED,
    });
    expect((await soapRejection(failing.search(QUERY, CTX))).code).toBe('UPSTREAM_TIMEOUT');
  });
});

describe('SoapGuestSearchGateway HTTP status rule (Req 10.9)', () => {
  it('500 with a Fault body gives UPSTREAM_FAULT', async () => {
    const { gateway, rec } = setup(ok('fault-server.xml', 500));
    const e = await soapRejection(gateway.search(QUERY, CTX));
    expect(e.code).toBe('UPSTREAM_FAULT');
    expect(e.detail).toBe('soap:Server');
    expect(rec.attrs['error.type']).toBe('UPSTREAM_FAULT');
    expect(rec.attrs['http.response.status_code']).toBe(500);
  });

  it('502 with an HTML proxy page gives UPSTREAM_HTTP_ERROR with the status as detail', async () => {
    const { gateway, rec, logger } = setup(ok('malformed-proxy-502.html', 502));
    const e = await soapRejection(gateway.search(QUERY, CTX));
    expect(e.code).toBe('UPSTREAM_HTTP_ERROR');
    expect(e.detail).toBe('502');
    expect(rec.attrs['error.type']).toBe('UPSTREAM_HTTP_ERROR');
    expect(rec.status).toEqual({ code: SpanStatusCode.ERROR, message: 'UPSTREAM_HTTP_ERROR' });
    expect(rec.exceptions).toBe(0);
    expect(rec.ended).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        requestId: REQUEST_ID,
        status: 502,
        durationMs: 42,
        errorCode: 'UPSTREAM_HTTP_ERROR',
        detail: '502',
      },
      expect.any(String),
    );
  });

  it('500 with a valid success body gives UPSTREAM_HTTP_ERROR', async () => {
    const { gateway } = setup(ok('response-single.xml', 500));
    const e = await soapRejection(gateway.search(QUERY, CTX));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_HTTP_ERROR', '500']);
  });

  it('non-2xx with a failed transaction status gives UPSTREAM_HTTP_ERROR', async () => {
    const { gateway } = setup(ok('response-failure-status.xml', 503));
    const e = await soapRejection(gateway.search(QUERY, CTX));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_HTTP_ERROR', '503']);
  });

  it('3xx is non-2xx (redirects are never followed)', async () => {
    const { gateway } = setup({ status: 302, body: '', durationMs: 1 });
    const e = await soapRejection(gateway.search(QUERY, CTX));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_HTTP_ERROR', '302']);
  });

  it('2xx with a Fault body still gives UPSTREAM_FAULT', async () => {
    const { gateway } = setup(ok('fault-client.xml', 200));
    const e = await soapRejection(gateway.search(QUERY, CTX));
    expect([e.code, e.detail]).toEqual(['UPSTREAM_FAULT', 'soap:Client']);
  });

  it('2xx parse errors propagate unchanged', async () => {
    const { gateway } = setup(ok('malformed-truncated.xml', 200));
    expect((await soapRejection(gateway.search(QUERY, CTX))).code).toBe('UPSTREAM_MALFORMED');
  });
});

describe('SoapGuestSearchGateway error propagation', () => {
  it.each(['UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_MALFORMED'] as const)(
    'transport %s propagates unchanged, with no status on the span',
    async (code) => {
      const err = new SoapError(code, 'ECONNREFUSED');
      const { gateway, rec, logger, metrics } = setup(err);
      expect(await rejection(gateway.search(QUERY, CTX))).toBe(err);
      expect(rec.attrs).toEqual({ 'request.id': REQUEST_ID, 'error.type': code });
      expect(metrics.soapCall).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { requestId: REQUEST_ID, errorCode: code, detail: 'ECONNREFUSED' },
        expect.any(String),
      );
    },
  );

  it("the mapper's INTERNAL_ERROR propagates and nothing is sent", async () => {
    const { gateway, sent, rec } = setup(ok('response-single.xml'));
    const e = await rejection(gateway.search({ lastName: 'Bad\u0001Name' }, CTX));
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe('INTERNAL_ERROR');
    expect(sent).toHaveLength(0);
    expect(rec.attrs['error.type']).toBe('INTERNAL_ERROR');
  });

  it('an untyped error is reported as _OTHER and never by message', async () => {
    const err = new Error('secret-ish text');
    const { gateway, rec, logger } = setup(err);
    expect(await rejection(gateway.search(QUERY, CTX))).toBe(err);
    expect(rec.attrs['error.type']).toBe(OTHER_ERROR);
    expect(rec.status?.message).toBe(OTHER_ERROR);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-ish');
  });
});
