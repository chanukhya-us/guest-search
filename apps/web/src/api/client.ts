// Typed fetch wrapper for the BFF (design.md "apps/web" → api/client.ts).
//
// Contract honoured here (locked by checkpoint 11):
//   - Same-origin only: paths are relative (e.g. "/api/v1/config"), so the browser
//     calls its own origin. No CORS, no cross-origin cookie handling (Req 21.5).
//   - Credentials: same-origin cookies are sent automatically with
//     `credentials: 'same-origin'` so the session cookie rides along (Req 20).
//   - CSRF: every UNSAFE request (anything other than GET/HEAD) carries
//     `X-Requested-With: guest-search`; without it the BFF answers 403 (Req 21.3).
//   - JSON only: `Content-Type: application/json` on requests with a body; the BFF
//     is JSON-only and answers 415 otherwise.
//
// On a non-2xx the server returns an `ErrorResponse { requestId, success:false,
// error:{ code, message, fields? } }`. We parse that and throw a typed `ApiError`
// carrying { status, code, message, fields?, requestId }. If the body is not the
// expected shape (HTML proxy page, truncated JSON, empty), we synthesize an
// INTERNAL_ERROR-ish client error so callers always get a typed failure.
import type { ErrorCode, ErrorResponse } from '@ihg-guest-search/shared';
import { ERROR_CATALOG } from '@ihg-guest-search/shared';

/** The exact CSRF marker the BFF requires on unsafe methods (Req 21.3). */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'guest-search';

/** Per-field error carried by VALIDATION_ERROR / NO_CRITERIA responses. */
export type ApiFieldError = NonNullable<ErrorResponse['error']['fields']>[number];

/**
 * Typed client error for any non-2xx (or unreadable) BFF response.
 *
 * `code` is always a catalog `ErrorCode`, so callers can switch on it exhaustively
 * (e.g. UNAUTHENTICATED → sign-in banner, REVEAL_EXPIRED → inline message). `message`
 * is the server's user-safe text (design.md: "the server message is used as is");
 * when the body is unreadable we fall back to the catalog message for the code.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly requestId?: string;
  readonly fields?: ApiFieldError[];

  constructor(args: {
    status: number;
    code: ErrorCode;
    message: string;
    requestId?: string;
    fields?: ApiFieldError[];
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
    this.fields = args.fields;
  }
}

/** Request options for {@link apiFetch}. `body`, when present, is JSON-encoded. */
export interface ApiRequest {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

/** The fields that make up a well-formed {@link ErrorResponse} error object. */
function isErrorResponse(value: unknown): value is ErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.success !== false) return false;
  const error = v.error;
  if (typeof error !== 'object' || error === null) return false;
  const e = error as Record<string, unknown>;
  return typeof e.code === 'string' && typeof e.message === 'string';
}

/** Choose a catalog code when the server body is unreadable, based on the status. */
function fallbackCodeForStatus(status: number): ErrorCode {
  for (const code of Object.keys(ERROR_CATALOG) as ErrorCode[]) {
    if (ERROR_CATALOG[code].http === status) return code;
  }
  return 'INTERNAL_ERROR';
}

/**
 * Perform a same-origin JSON request to the BFF and return the parsed success body.
 *
 * Throws {@link ApiError} on any non-2xx, on a non-JSON/garbage error body, and on a
 * network/abort failure (classified as UPSTREAM_UNAVAILABLE so callers can render a
 * generic "try again" message). 2xx bodies are parsed as JSON; `204 No Content` and
 * empty bodies resolve to `undefined`.
 */
export async function apiFetch<T>(path: string, req: ApiRequest = {}): Promise<T> {
  const method = req.method ?? 'GET';
  const isUnsafe = method !== 'GET';
  const hasBody = req.body !== undefined;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (isUnsafe) headers[CSRF_HEADER] = CSRF_VALUE;
  if (hasBody) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: req.signal,
    });
  } catch (cause) {
    // Network failure or abort: surface a typed, generic upstream error. An abort
    // keeps its name so React Query / callers can distinguish cancellation.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      status: 0,
      code: 'UPSTREAM_UNAVAILABLE',
      message: ERROR_CATALOG.UPSTREAM_UNAVAILABLE.message,
    });
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  // Success. 204 and empty bodies carry no JSON (e.g. logout).
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text.length === 0) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 2xx with a non-JSON body is a contract violation; treat it as internal.
    throw new ApiError({
      status: response.status,
      code: 'INTERNAL_ERROR',
      message: ERROR_CATALOG.INTERNAL_ERROR.message,
      requestId: response.headers.get('X-Request-ID') ?? undefined,
    });
  }
}

/** Build the typed error for a non-2xx response, parsing the ErrorResponse body. */
async function toApiError(response: Response): Promise<ApiError> {
  const headerRequestId = response.headers.get('X-Request-ID') ?? undefined;
  let parsed: unknown;
  try {
    const text = await response.text();
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (isErrorResponse(parsed)) {
    return new ApiError({
      status: response.status,
      code: parsed.error.code,
      message: parsed.error.message,
      requestId: parsed.requestId ?? headerRequestId,
      fields: parsed.error.fields,
    });
  }

  // Body missing or not the expected shape (HTML proxy page, truncated JSON, …):
  // synthesize a typed error from the status, falling back to INTERNAL_ERROR.
  const code = fallbackCodeForStatus(response.status);
  return new ApiError({
    status: response.status,
    code,
    message: ERROR_CATALOG[code].message,
    requestId: headerRequestId,
  });
}
