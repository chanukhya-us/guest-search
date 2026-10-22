// API client tests (task 12.2). Drives apiFetch against a mocked global fetch to prove:
//   - the CSRF header and same-origin credentials are sent on unsafe requests;
//   - success bodies are parsed; 204/empty resolve to undefined;
//   - each ErrorResponse code maps to a typed ApiError (status, code, fields, requestId);
//   - a non-JSON / garbage error body synthesizes a typed error from the status;
//   - a network failure becomes a typed UPSTREAM_UNAVAILABLE and an abort propagates.
import { ERROR_CATALOG, type ErrorCode, type ErrorResponse } from '@ihg-guest-search/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiFetch, CSRF_HEADER, CSRF_VALUE } from '../../src/api/client';
import { getConfig, getMe, logout } from '../../src/api/session';
import { revealGuest, searchGuests } from '../../src/api/guests';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function errorResponse(code: ErrorCode, extra: Partial<ErrorResponse['error']> = {}): Response {
  const body: ErrorResponse = {
    requestId: 'req-123',
    success: false,
    error: { code, message: ERROR_CATALOG[code].message, ...extra },
  };
  return new Response(JSON.stringify(body), {
    status: ERROR_CATALOG[code].http,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req-123' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('apiFetch request shaping', () => {
  it('sends same-origin credentials and no CSRF header on a GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/v1/config');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/config');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    const headers = init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBeUndefined();
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('sends the CSRF header and JSON content-type on a POST with a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/v1/guests/search', { method: 'POST', body: { criteria: {} } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe(CSRF_VALUE);
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe(JSON.stringify({ criteria: {} }));
  });

  it('threads the AbortSignal through to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await apiFetch('/api/v1/me', { signal: controller.signal });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe('apiFetch success parsing', () => {
  it('parses a JSON success body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ displayName: 'Dana' })));
    await expect(apiFetch('/api/v1/me')).resolves.toEqual({ displayName: 'Dana' });
  });

  it('resolves to undefined for 204 No Content (logout)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(logout()).resolves.toBeUndefined();
  });

  it('resolves to undefined for an empty 200 body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    await expect(apiFetch('/api/v1/me')).resolves.toBeUndefined();
  });

  it('throws INTERNAL_ERROR when a 2xx body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 })),
    );
    await expect(apiFetch('/api/v1/me')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('apiFetch error mapping', () => {
  const codes: ErrorCode[] = [
    'NO_CRITERIA',
    'VALIDATION_ERROR',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'REVEAL_EXPIRED',
    'RATE_LIMITED',
    'UPSTREAM_TIMEOUT',
    'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_HTTP_ERROR',
    'UPSTREAM_FAULT',
    'UPSTREAM_TXN_FAILED',
    'UPSTREAM_CONTRACT',
    'UPSTREAM_MALFORMED',
    'INTERNAL_ERROR',
  ];

  it.each(codes)('maps the %s error body to a typed ApiError', async (code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(code)));

    const error = await apiFetch('/api/v1/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe(code);
    expect(apiError.status).toBe(ERROR_CATALOG[code].http);
    expect(apiError.message).toBe(ERROR_CATALOG[code].message);
    expect(apiError.requestId).toBe('req-123');
  });

  it('carries field errors from a VALIDATION_ERROR body', async () => {
    const fields = [{ field: 'email' as const, message: 'Enter a valid email.' }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse('VALIDATION_ERROR', { fields })),
    );

    const error = (await apiFetch('/api/v1/guests/search', {
      method: 'POST',
      body: { criteria: {} },
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.fields).toEqual(fields);
  });

  it('synthesizes a typed error from the status when the error body is garbage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'X-Request-ID': 'req-garbage' },
        }),
      ),
    );

    const error = (await apiFetch('/api/v1/me').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    // 502 maps to one of the UPSTREAM_* codes in the catalog.
    expect(ERROR_CATALOG[error.code].http).toBe(502);
    expect(error.requestId).toBe('req-garbage');
  });

  it('synthesizes a typed error from an empty error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const error = (await apiFetch('/api/v1/me').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.status).toBe(500);
  });

  it('maps a network failure to UPSTREAM_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = (await apiFetch('/api/v1/me').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.status).toBe(0);
  });

  it('propagates an abort as an AbortError, not an ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    const error = (await apiFetch('/api/v1/me').catch((e: unknown) => e)) as Error;
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.name).toBe('AbortError');
  });
});

describe('endpoint helpers call the right paths and methods', () => {
  it('getConfig GETs /api/v1/config', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ scoreBands: { high: 90, medium: 70 } }));
    vi.stubGlobal('fetch', fetchMock);
    await getConfig();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/config');
  });

  it('getMe GETs /api/v1/me', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ displayName: 'Dana', roles: [], authMode: 'dev' }));
    vi.stubGlobal('fetch', fetchMock);
    await getMe();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/me');
  });

  it('searchGuests POSTs the criteria object directly to /api/v1/guests/search', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await searchGuests({ lastName: 'Testperson' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/guests/search');
    expect(init.method).toBe('POST');
    // The BFF search route treats the body AS the criteria object (routes/index.ts
    // `asInput`; every BFF integration test posts `{ lastName: … }`, not `{ criteria: … }`).
    // The client sends it unwrapped so the shared strictObject schema accepts it.
    expect(init.body).toBe(JSON.stringify({ lastName: 'Testperson' }));
  });

  it('revealGuest POSTs the token to /api/v1/guests/reveal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ phones: [], emails: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await revealGuest('rt_abc');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/guests/reveal');
    expect(init.body).toBe(JSON.stringify({ revealToken: 'rt_abc' }));
  });
});
