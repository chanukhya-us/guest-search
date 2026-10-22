// Unit tests for the SOAP transport (task 6.2, Req 10.1–10.6, 10.8). An injected fake fetch
// returns real `Response` objects with `ReadableStream` bodies; a local node:http server
// covers the default undici fetch + Agent path. MSW-based tests are task 6.4.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config.js';
import { StartupError } from '../../../src/errors.js';
import { CIRCUIT_OPEN, CircuitBreaker } from '../../../src/soap/circuitBreaker.js';
import { SoapError } from '../../../src/soap/responseParser.js';
import {
  CONTENT_TYPE,
  DETAIL,
  createSoapAgent,
  createSoapTransport,
  type SoapFetch,
  type SoapFetchInit,
} from '../../../src/soap/transport.js';

const ENVELOPE = '<soap:Envelope>synthetic</soap:Envelope>';
const CTX = { requestId: 'req-0001' };

function soapCfg(over: Partial<AppConfig['soap']> = {}): AppConfig['soap'] {
  return {
    endpoint: new URL('https://soap.example.test/GuestService'),
    soapAction: 'searchGuest',
    channelId: 'TEST-CHANNEL-ID',
    connectTimeoutMs: 3000,
    responseTimeoutMs: 1000,
    maxResponseBytes: 64,
    maxResults: 50,
    features: { addressLine1: false, city: false, postalCode: false },
    header: {
      languageCode: 'en',
      countryCode: 'US',
      channel: 'C',
      subChannels: ['S'],
      environment: 'test',
      serviceUser: 'svc',
      sequence: 1,
    },
    breaker: { failureThreshold: 5, openMs: 30_000 },
    ...over,
  };
}

const breaker = (failureThreshold = 5) => new CircuitBreaker({ failureThreshold, openMs: 30_000 });

/** A fetch failure shaped like undici's: TypeError('fetch failed') with a coded cause. */
function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

const bytes = (s: string) => new TextEncoder().encode(s);

/** A body stream that emits `chunks` and records cancellation. */
function streamOf(chunks: Uint8Array[], onCancel: () => void = () => undefined) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks[i++];
      if (next === undefined) c.close();
      else c.enqueue(next);
    },
    cancel: onCancel,
  });
}

/** Fake fetch whose calls are recorded; each call gets the next scripted outcome. */
function scripted(...outcomes: ((init: SoapFetchInit) => Promise<Response>)[]) {
  const calls: { url: string; init: SoapFetchInit }[] = [];
  const fetch: SoapFetch = (url, init) => {
    calls.push({ url, init });
    const next = outcomes[Math.min(calls.length, outcomes.length) - 1];
    if (next === undefined) throw new Error('no outcome scripted');
    return next(init);
  };
  return { fetch, calls };
}

const ok =
  (body = '<ok/>', status = 200) =>
  () =>
    Promise.resolve(new Response(body, { status }));
const reject = (e: unknown) => () => Promise.reject(e);
/** Never settles until the request signal fires, then rejects with its reason. */
const hang = () => (init: SoapFetchInit) =>
  new Promise<Response>((_, rej) => {
    init.signal.addEventListener('abort', () => rej(init.signal.reason));
  });

async function sendError(p: Promise<unknown>): Promise<SoapError> {
  const e: unknown = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SoapError);
  return e as SoapError;
}

describe('request (Req 10.1)', () => {
  it('POSTs the envelope to the configured endpoint with SOAP 1.1 headers only', async () => {
    const { fetch, calls } = scripted(ok());
    const t = createSoapTransport(soapCfg(), { breaker: breaker(), fetch });
    await t.send(ENVELOPE, CTX);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://soap.example.test/GuestService');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(ENVELOPE);
    expect(init.redirect).toBe('manual');
    // As in docs/Request.txt: SOAPAction verbatim (unquoted), IHG-ChannelId, Accept */*.
    expect(init.headers).toEqual({
      'content-type': CONTENT_TYPE,
      soapaction: 'searchGuest',
      'ihg-channelid': 'TEST-CHANNEL-ID',
      accept: '*/*',
    });
    expect(CONTENT_TYPE).toBe('text/xml; charset=utf-8');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // requestId is for logs only; injected fetch without a dispatcher gets none (MSW-safe).
    expect(JSON.stringify({ url, headers: init.headers })).not.toContain(CTX.requestId);
    expect('dispatcher' in init).toBe(false);
  });

  it('passes an explicitly injected dispatcher through', async () => {
    const dispatcher = createSoapAgent(soapCfg());
    const { fetch, calls } = scripted(ok());
    await createSoapTransport(soapCfg(), { breaker: breaker(), fetch, dispatcher }).send(
      ENVELOPE,
      CTX,
    );
    expect(calls[0]!.init.dispatcher).toBe(dispatcher);
    await dispatcher.close();
  });

  it('returns non-2xx status and body to the gateway without throwing', async () => {
    const { fetch } = scripted(ok('<Fault/>', 500));
    const res = await createSoapTransport(soapCfg(), { breaker: breaker(), fetch }).send(
      ENVELOPE,
      CTX,
    );
    expect(res).toMatchObject({ status: 500, body: '<Fault/>' });
  });

  it('reports durationMs from the injected clock', async () => {
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(350);
    const { fetch } = scripted(ok());
    const res = await createSoapTransport(soapCfg(), { breaker: breaker(), fetch, now }).send(
      ENVELOPE,
      CTX,
    );
    expect(res.durationMs).toBe(250);
  });
});

describe('timeouts (Req 10.2, 10.3)', () => {
  it('aborts a request with no response and reports UPSTREAM_TIMEOUT without retry', async () => {
    const { fetch, calls } = scripted(hang());
    const t = createSoapTransport(soapCfg({ responseTimeoutMs: 20 }), {
      breaker: breaker(),
      fetch,
    });
    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e.code).toBe('UPSTREAM_TIMEOUT');
    expect(calls).toHaveLength(1);
  });

  it('treats a timeout during the body read as UPSTREAM_TIMEOUT', async () => {
    const { fetch, calls } = scripted((init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes('<partial'));
          init.signal.addEventListener('abort', () => c.error(init.signal.reason));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const t = createSoapTransport(soapCfg({ responseTimeoutMs: 20 }), {
      breaker: breaker(),
      fetch,
    });
    expect((await sendError(t.send(ENVELOPE, CTX))).code).toBe('UPSTREAM_TIMEOUT');
    expect(calls).toHaveLength(1);
  });

  it('classifies an AbortError thrown before the signal fires as UPSTREAM_TIMEOUT', async () => {
    const { fetch } = scripted(reject(new DOMException('aborted', 'AbortError')));
    const t = createSoapTransport(soapCfg(), { breaker: breaker(), fetch });
    expect((await sendError(t.send(ENVELOPE, CTX))).code).toBe('UPSTREAM_TIMEOUT');
  });
});

describe('connection failures and retry (Req 10.4, 10.5)', () => {
  it('retries a refused connection once, then reports UPSTREAM_UNAVAILABLE', async () => {
    const { fetch, calls } = scripted(reject(fetchFailed('ECONNREFUSED')));
    const t = createSoapTransport(soapCfg(), { breaker: breaker(), fetch });
    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: 'ECONNREFUSED' });
    expect(calls).toHaveLength(2);
  });

  it('returns the retry result when the second attempt succeeds', async () => {
    const { fetch, calls } = scripted(reject(fetchFailed('ECONNRESET')), ok('<second/>'));
    const res = await createSoapTransport(soapCfg(), { breaker: breaker(), fetch }).send(
      ENVELOPE,
      CTX,
    );
    expect(res.body).toBe('<second/>');
    expect(calls).toHaveLength(2);
  });

  it('reports the retry outcome when the retry fails differently', async () => {
    const { fetch } = scripted(reject(fetchFailed('ENOTFOUND')), hang());
    const t = createSoapTransport(soapCfg({ responseTimeoutMs: 20 }), {
      breaker: breaker(),
      fetch,
    });
    expect((await sendError(t.send(ENVELOPE, CTX))).code).toBe('UPSTREAM_TIMEOUT');
  });

  it('finds connection codes inside an AggregateError cause', async () => {
    const agg = new AggregateError([Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })]);
    const { fetch, calls } = scripted(reject(new TypeError('fetch failed', { cause: agg })));
    const e = await sendError(
      createSoapTransport(soapCfg(), { breaker: breaker(), fetch }).send(ENVELOPE, CTX),
    );
    expect(e.detail).toBe('EHOSTUNREACH');
    expect(calls).toHaveLength(2);
  });

  it.each(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
    'does not retry a TLS failure (%s)',
    async (code) => {
      const { fetch, calls } = scripted(reject(fetchFailed(code)));
      const e = await sendError(
        createSoapTransport(soapCfg(), { breaker: breaker(), fetch }).send(ENVELOPE, CTX),
      );
      expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: DETAIL.tls });
      expect(calls).toHaveLength(1);
    },
  );

  it('does not retry an unrecognised pre-response failure', async () => {
    const { fetch, calls } = scripted(reject(new TypeError('fetch failed')));
    const e = await sendError(
      createSoapTransport(soapCfg(), { breaker: breaker(), fetch }).send(ENVELOPE, CTX),
    );
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: DETAIL.fetchFailed });
    expect(calls).toHaveLength(1);
  });

  it('does not retry once a response has started (body stream error)', async () => {
    const { fetch, calls } = scripted(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes('<partial'));
          c.error(fetchFailed('ECONNRESET'));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const e = await sendError(
      createSoapTransport(soapCfg(), { breaker: breaker(), fetch }).send(ENVELOPE, CTX),
    );
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: DETAIL.bodyStream });
    expect(calls).toHaveLength(1);
  });
});

describe('body size cap (Req 10.6)', () => {
  it('stops reading a streamed body that passes maxResponseBytes', async () => {
    const onCancel = vi.fn();
    const chunk = bytes('x'.repeat(30));
    const { fetch, calls } = scripted(() =>
      Promise.resolve(new Response(streamOf([chunk, chunk, chunk, chunk], onCancel))),
    );
    const e = await sendError(
      createSoapTransport(soapCfg({ maxResponseBytes: 64 }), { breaker: breaker(), fetch }).send(
        ENVELOPE,
        CTX,
      ),
    );
    expect(e).toMatchObject({ code: 'UPSTREAM_MALFORMED', detail: DETAIL.bodyTooLarge });
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const onCancel = vi.fn();
    const { fetch } = scripted(() =>
      Promise.resolve(
        new Response(streamOf([bytes('<ok/>')], onCancel), { headers: { 'content-length': '65' } }),
      ),
    );
    const e = await sendError(
      createSoapTransport(soapCfg({ maxResponseBytes: 64 }), { breaker: breaker(), fetch }).send(
        ENVELOPE,
        CTX,
      ),
    );
    expect(e).toMatchObject({ code: 'UPSTREAM_MALFORMED', detail: DETAIL.bodyTooLarge });
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it('accepts exactly maxResponseBytes and decodes UTF-8 split across chunks', async () => {
    const all = bytes(`${'a'.repeat(60)}é€`); // 60 + 2 + 3 = 65 bytes
    const parts = [all.slice(0, 61), all.slice(61, 63), all.slice(63)]; // splits é and €
    const { fetch } = scripted(() => Promise.resolve(new Response(streamOf(parts))));
    const res = await createSoapTransport(soapCfg({ maxResponseBytes: 65 }), {
      breaker: breaker(),
      fetch,
    }).send(ENVELOPE, CTX);
    expect(res.body).toBe(`${'a'.repeat(60)}é€`);
  });

  it('returns an empty body when the response has none', async () => {
    const { fetch } = scripted(() => Promise.resolve(new Response(null, { status: 204 })));
    const res = await createSoapTransport(soapCfg(), { breaker: breaker(), fetch }).send(
      ENVELOPE,
      CTX,
    );
    expect(res).toMatchObject({ status: 204, body: '' });
  });
});

describe('circuit breaker (Req 10.7)', () => {
  it('counts one send with a retry as a single breaker failure', async () => {
    const b = breaker(2);
    const { fetch } = scripted(reject(fetchFailed('ECONNREFUSED')));
    const t = createSoapTransport(soapCfg(), { breaker: b, fetch });
    await sendError(t.send(ENVELOPE, CTX));
    expect(b.state).toBe('closed');
    await sendError(t.send(ENVELOPE, CTX));
    expect(b.state).toBe('open');
  });

  it('fails fast without calling fetch while the circuit is open', async () => {
    const b = breaker(1);
    const { fetch, calls } = scripted(reject(fetchFailed('ECONNREFUSED')));
    const t = createSoapTransport(soapCfg(), { breaker: b, fetch });
    await sendError(t.send(ENVELOPE, CTX));
    expect(calls).toHaveLength(2);

    const e = await sendError(t.send(ENVELOPE, CTX));
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: CIRCUIT_OPEN });
    expect(calls).toHaveLength(2);
  });
});

describe('createSoapAgent (Req 10.2, 10.8)', () => {
  it('builds an Agent without TLS files', async () => {
    const agent = createSoapAgent(soapCfg());
    expect(typeof agent.dispatch).toBe('function');
    await agent.close();
  });

  it('reads CA, cert and key once at creation', async () => {
    const readFile = vi.fn((p: string) => Buffer.from(`pem:${p}`));
    const cfg = soapCfg({ tls: { caFile: '/ca.pem', certFile: '/c.pem', keyFile: '/k.pem' } });
    const agent = createSoapAgent(cfg, readFile);
    expect(readFile.mock.calls.map((c) => c[0])).toEqual(['/ca.pem', '/c.pem', '/k.pem']);
    await agent.close();
  });

  it('rejects a client certificate without a key (and vice versa)', () => {
    const readFile = vi.fn(() => Buffer.from('pem'));
    for (const tls of [{ certFile: '/c.pem' }, { keyFile: '/k.pem' }]) {
      expect(() => createSoapAgent(soapCfg({ tls }), readFile)).toThrow(StartupError);
    }
    expect(readFile).not.toHaveBeenCalled();
  });

  it('names the config key, never file content, when a file cannot be read', () => {
    const readFile = () => {
      throw new Error('ENOENT secret-ish detail');
    };
    const cfg = soapCfg({ tls: { caFile: '/missing.pem' } });
    let err: unknown;
    try {
      createSoapAgent(cfg, readFile);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StartupError);
    expect((err as StartupError).message).toBe('Cannot read SOAP_TLS_CA_FILE');
    expect((err as StartupError).invalidKeys).toEqual(['SOAP_TLS_CA_FILE']);
  });
});

describe('default undici fetch + Agent against a local server', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r) ?? r(undefined));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<URL> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/soap`);
  }

  it('sends the headers and reads the body through undici', async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const endpoint = await listen((req, res) => {
      seen.push(req.headers);
      req.resume();
      res.writeHead(200, { 'content-type': CONTENT_TYPE }).end('<ok/>');
    });
    const res = await createSoapTransport(soapCfg({ endpoint }), { breaker: breaker() }).send(
      ENVELOPE,
      CTX,
    );
    expect(res).toMatchObject({ status: 200, body: '<ok/>' });
    expect(seen[0]).toMatchObject({
      'content-type': CONTENT_TYPE,
      soapaction: 'searchGuest',
      'ihg-channelid': 'TEST-CHANNEL-ID',
      accept: '*/*',
    });
  });

  it('classifies a refused connection on a closed port and retries once', async () => {
    const endpoint = await listen(() => undefined);
    await new Promise((r) => server!.close(r));
    server = undefined;
    const dispatcher = createSoapAgent(soapCfg());
    const fetchSpy = vi.fn<SoapFetch>();
    const { fetch: undiciFetch } = await import('undici');
    fetchSpy.mockImplementation((u, i) => undiciFetch(u, i) as unknown as ReturnType<SoapFetch>);
    const e = await sendError(
      createSoapTransport(soapCfg({ endpoint }), {
        breaker: breaker(),
        fetch: fetchSpy,
        dispatcher,
      }).send(ENVELOPE, CTX),
    );
    expect(e).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', detail: 'ECONNREFUSED' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await dispatcher.close();
  });
});
