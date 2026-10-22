/**
 * Global error handler and not-found handler (design.md plugin order step 9; Req 19).
 *
 * This is the single place that turns any failure into the pinned `ErrorResponse` shape
 * (Req 19.2):
 *
 *   { requestId, success: false, error: { code, message, fields? } }
 *
 * Every branch resolves to one of the catalog `ErrorCode`s and sends the catalog's HTTP status
 * and user-facing `message` (Req 19.1). The body NEVER carries the thrown error's own message,
 * stack, cause, SOAP fault text, header values, URLs, infrastructure names or any user-supplied
 * value (Req 19.3) — only the fixed catalog text, plus per-field rule messages for validation.
 * The original error is logged server-side with the request id for diagnosis (Req 19.4); the
 * client sees only the safe projection.
 *
 * ## Mapping (first match wins)
 *   1. `AppError`   — already carries a catalog `code`. For `VALIDATION_ERROR` the per-field
 *      messages travel in `error.cause` as `FieldError[]` (built by the service / routes from a
 *      Zod error) and are copied into `error.fields`. No field value is ever present there.
 *   2. `ZodError`   — a validation failure that reached here unwrapped (e.g. a route that parsed
 *      directly). A root-only issue → `NO_CRITERIA`; otherwise `VALIDATION_ERROR` with per-field
 *      messages flattened the same way the service does, so both paths produce identical bodies.
 *   3. `SoapError`  — carries an `UPSTREAM_*` code from the parser/transport/gateway; mapped
 *      straight through the catalog. Its `detail` (already sanitized at the source) is logged,
 *      never sent.
 *   4. Fastify transport errors by status — 413 (body over `bodyLimit`) and 415 (non-JSON media
 *      type) → `VALIDATION_ERROR` with the generic catalog message (design.md); 429 (rate limit)
 *      → `RATE_LIMITED`. These are Fastify's built-in errors routed here so they share the shape.
 *   5. A 404 that reaches the error handler, and the dedicated not-found handler, both return a
 *      catalog-shaped body. Unknown API routes get `VALIDATION_ERROR` (there is no dedicated
 *      "route not found" catalog code; a 404 here means a bad client path, treated as a client
 *      error without leaking the route table).
 *   6. Anything else — an unexpected exception — becomes `INTERNAL_ERROR` (Req 19.4), logged at
 *      `error` with the request id.
 *
 * `requestId` is always `request.id` (set by the request-id plugin, step 1), so even a failure
 * in an early hook still yields a correlatable body.
 */
import {
  ERROR_CATALOG,
  type CriteriaField,
  type ErrorCode,
  type ErrorResponse,
} from '@ihg-guest-search/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodIssue } from 'zod';
import { AppError } from '../errors.js';
import { SoapError } from '../soap/responseParser.js';

/** Per-field validation message (mirrors the service's `FieldError`; never carries a value). */
export interface FieldError {
  field: CriteriaField | 'root';
  message: string;
}

/** Fastify's built-in error codes we recognise by code (status is the primary signal). */
const FST_BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE'; // 413
const FST_INVALID_MEDIA_TYPE = 'FST_ERR_CTP_INVALID_MEDIA_TYPE'; // 415
const FST_EMPTY_JSON_BODY = 'FST_ERR_CTP_EMPTY_JSON_BODY'; // 400-ish malformed JSON

/** Build the wire body from a resolved code, attaching fields only when present. */
function body(requestId: string, code: ErrorCode, fields?: FieldError[]): ErrorResponse {
  const { message } = ERROR_CATALOG[code];
  return {
    requestId,
    success: false,
    error: { code, message, ...(fields !== undefined && fields.length > 0 && { fields }) },
  };
}

/** Is this the schema's single root issue (no field path) → NO_CRITERIA vs VALIDATION_ERROR. */
function isRootOnly(issues: readonly ZodIssue[]): boolean {
  return issues.length > 0 && issues.every((i) => i.path.length === 0);
}

/**
 * Flatten a Zod error into per-field messages. A root issue maps to `'root'`; every other issue
 * uses its first path segment. De-duplicated, first message per (field,message) wins. Messages
 * are the schema's rule text and never echo the submitted value (Req 19.3).
 */
function fieldsFromZod(error: ZodError): FieldError[] {
  const seen = new Set<string>();
  const out: FieldError[] = [];
  for (const issue of error.issues) {
    const field = (issue.path.length === 0 ? 'root' : String(issue.path[0])) as
      CriteriaField | 'root';
    const key = `${field}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field, message: issue.message });
  }
  return out;
}

/** Narrow an `AppError.cause` to `FieldError[]` (the service stores validation fields there). */
function fieldsFromCause(cause: unknown): FieldError[] | undefined {
  if (!Array.isArray(cause)) return undefined;
  const ok = cause.every(
    (c): c is FieldError =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as FieldError).field === 'string' &&
      typeof (c as FieldError).message === 'string',
  );
  return ok ? (cause as FieldError[]) : undefined;
}

/**
 * Resolve any thrown value to a catalog code, optional field messages, and an optional HTTP
 * status override. The override exists because Fastify's transport errors carry a semantically
 * correct status (413 body-too-large, 415 unsupported-media-type) that we preserve, even though
 * the body `code` is the generic `VALIDATION_ERROR` (design.md: "413 and 415 use VALIDATION_ERROR
 * with a generic message"; task 10.2 asserts the 413/415 statuses). For every other branch the
 * status comes straight from the catalog, so no override is returned.
 */
function classify(error: unknown): {
  code: ErrorCode;
  fields?: FieldError[];
  httpOverride?: number;
} {
  if (error instanceof AppError) {
    if (error.code === 'VALIDATION_ERROR') {
      const fields = fieldsFromCause(error.cause);
      return { code: 'VALIDATION_ERROR', ...(fields !== undefined && { fields }) };
    }
    return { code: error.code };
  }

  if (error instanceof ZodError) {
    if (isRootOnly(error.issues)) return { code: 'NO_CRITERIA' };
    return { code: 'VALIDATION_ERROR', fields: fieldsFromZod(error) };
  }

  if (error instanceof SoapError) return { code: error.code };

  // Fastify built-in transport errors: recognise by code, then by statusCode. 413/415 keep their
  // own status; the body code is VALIDATION_ERROR.
  const fe = error as Partial<FastifyError> & { statusCode?: number; code?: string };
  if (fe.code === FST_BODY_TOO_LARGE) return { code: 'VALIDATION_ERROR', httpOverride: 413 };
  if (fe.code === FST_INVALID_MEDIA_TYPE) return { code: 'VALIDATION_ERROR', httpOverride: 415 };
  if (fe.code === FST_EMPTY_JSON_BODY) return { code: 'VALIDATION_ERROR', httpOverride: 400 };

  switch (fe.statusCode) {
    case 413:
    case 415:
      return { code: 'VALIDATION_ERROR', httpOverride: fe.statusCode };
    case 400:
      return { code: 'VALIDATION_ERROR' };
    case 429:
      return { code: 'RATE_LIMITED' };
    case 404:
      return { code: 'VALIDATION_ERROR', httpOverride: 404 };
    default:
      return { code: 'INTERNAL_ERROR' };
  }
}

/** Options for {@link createErrorHandler}. */
export interface ErrorHandlerOptions {
  /**
   * Metrics hook (task 9.2): called with the resolved catalog `code` for every mapped failure, so
   * the `gs.errors{code}` counter is incremented exactly where the code is known. The code is a
   * fixed non-PII catalog identifier (never the thrown message). Optional; omitted under test when
   * metrics are not asserted. Must not throw.
   */
  readonly onError?: (code: ErrorCode) => void;
}

/**
 * The Fastify error handler. Install with `fastify.setErrorHandler(createErrorHandler())`.
 * Logs the real error server-side (with the request id) and sends only the safe catalog body.
 */
export function createErrorHandler(options: ErrorHandlerOptions = {}) {
  return function errorHandler(
    error: unknown,
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply {
    const { code, fields, httpOverride } = classify(error);
    const http = httpOverride ?? ERROR_CATALOG[code].http;

    // Count the error by its catalog code (task 9.2, Req 22.7); non-PII, before the body is sent.
    options.onError?.(code);

    // Diagnostic log only. `INTERNAL_ERROR` and anything unexpected goes to `error`; mapped,
    // expected failures (validation, upstream, rate limit) are `warn`. The pino logger redaction
    // (task 9.1) is the secondary safeguard; the body itself already carries no detail.
    const level = code === 'INTERNAL_ERROR' ? 'error' : 'warn';
    request.log[level]({ err: error, code }, 'request failed');

    return reply.code(http).send(body(request.id, code, fields));
  };
}

/**
 * The not-found handler. Install with `fastify.setNotFoundHandler(createNotFoundHandler())`.
 * An unknown route yields the catalog-shaped body (HTTP 404 via the VALIDATION_ERROR... note:
 * we keep the 404 status but the catalog code for an unknown path is a client error). We send
 * 404 with a generic body and the request id, revealing nothing about which routes exist.
 */
export function createNotFoundHandler() {
  return function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    // Use VALIDATION_ERROR's generic message but keep the semantically correct 404 status.
    return reply.code(404).send(body(request.id, 'VALIDATION_ERROR'));
  };
}
