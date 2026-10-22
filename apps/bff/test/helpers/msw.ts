/**
 * MSW 3 helpers for the SOAP integration tests (task 6.4).
 *
 * Observed MSW 3.0.3 behaviour on Node (probed while writing these tests):
 *   - Only `globalThis.fetch` is intercepted, not undici's own `fetch`, so the transport gets
 *     `mswFetch` and no dispatcher.
 *   - A handler's `ReadableStream` body is drained by MSW before the client sees headers: an
 *     endless stream never resolves, and a client-side cancel never reaches the handler's
 *     stream. Body cancellation is therefore observed at the fetch boundary (`observeBody`).
 *   - `HttpResponse.error()` surfaces as `TypeError('fetch failed')` with no `code` anywhere
 *     in the cause chain; a handler that throws becomes a 500 response. Neither can simulate
 *     ECONNREFUSED. `passthrough()` to a closed local port gives a real one.
 *   - `delay('infinite')` keeps the fetch pending even after its signal aborts, so timeout
 *     handlers wait on `request.signal` instead (`untilAborted`).
 *   - Aborting while a response body is still open crashes undici's internal assertion
 *     (`assert(!this.aborted)`) under MSW, so the body-phase timeout stays a unit test.
 */
import type { AppConfig } from '../../src/config.js';
import type { SoapFetch, SoapFetchResponse } from '../../src/soap/transport.js';

export const MSW_ENDPOINT = 'https://soap.example.test/GuestService';
export const MSW_SOAP_ACTION = 'searchGuest';
export const MSW_CHANNEL_ID = 'TEST-CHANNEL-ID';

/** The transport's fetch, routed through the global fetch MSW patches. No dispatcher. */
export const mswFetch: SoapFetch = (url, init) =>
  globalThis.fetch(url, init as RequestInit) as Promise<SoapFetchResponse>;

export interface BodyStats {
  /** Bytes the transport pulled from the response body. */
  bytes: number;
  /** True once the transport cancelled the body. */
  cancelled: boolean;
}

/** `mswFetch` with the response body wrapped so reads and cancellation are recorded. */
export function observeBody(): { fetch: SoapFetch; stats: BodyStats } {
  const stats: BodyStats = { bytes: 0, cancelled: false };
  const fetch: SoapFetch = async (url, init) => {
    const res = await mswFetch(url, init);
    const source = res.body;
    if (source === null) return res;
    const reader = source.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) {
          c.close();
          return;
        }
        stats.bytes += value.byteLength;
        c.enqueue(value);
      },
      cancel(reason) {
        stats.cancelled = true;
        return reader.cancel(reason);
      },
    });
    return { status: res.status, headers: res.headers, body };
  };
  return { fetch, stats };
}

/** Resolves when `signal` aborts (the client gave up), or after `maxMs` as a safety net. */
export function untilAborted(signal: AbortSignal, maxMs = 2_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** SOAP config for the MSW tests: synthetic header values, MSW endpoint. */
export function mswSoapCfg(over: Partial<AppConfig['soap']> = {}): AppConfig['soap'] {
  return {
    endpoint: new URL(MSW_ENDPOINT),
    soapAction: MSW_SOAP_ACTION,
    channelId: MSW_CHANNEL_ID,
    connectTimeoutMs: 3_000,
    responseTimeoutMs: 2_000,
    maxResponseBytes: 5_000_000,
    maxResults: 50,
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
    ...over,
  };
}
