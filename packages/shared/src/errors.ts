// Error catalog (Req 19.1). Statuses and user messages are copied from requirements.md.
// Messages are safe to show to colleagues: no internal detail ever goes here (Req 19.3).
import { NO_CRITERIA_MESSAGE } from './schema.js';

export type ErrorCode =
  | 'NO_CRITERIA'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'REVEAL_EXPIRED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_HTTP_ERROR'
  | 'UPSTREAM_FAULT'
  | 'UPSTREAM_TXN_FAILED'
  | 'UPSTREAM_CONTRACT'
  | 'UPSTREAM_MALFORMED'
  | 'INTERNAL_ERROR';

export interface ErrorCatalogEntry {
  readonly http: number;
  readonly message: string;
}

const GENERIC_FAILURE = 'Unable to complete the guest search. Please try again.';

export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCatalogEntry>> = {
  NO_CRITERIA: { http: 400, message: NO_CRITERIA_MESSAGE },
  // Req 19.1 says "Field messages": per-field text travels in error.fields. This top-level
  // message is the generic fallback, also used for 413/415 (design.md, HTTP layer).
  VALIDATION_ERROR: { http: 400, message: 'Please correct the highlighted fields and try again.' },
  UNAUTHENTICATED: { http: 401, message: 'Your session has expired. Please sign in again.' },
  FORBIDDEN: { http: 403, message: 'You do not have access to this action.' },
  REVEAL_EXPIRED: { http: 404, message: 'Details expired. Please search again.' },
  RATE_LIMITED: { http: 429, message: 'Too many requests. Please wait a moment and try again.' },
  UPSTREAM_TIMEOUT: {
    http: 504,
    message: 'The guest search service did not respond in time. Please try again.',
  },
  UPSTREAM_UNAVAILABLE: { http: 502, message: GENERIC_FAILURE },
  UPSTREAM_HTTP_ERROR: { http: 502, message: GENERIC_FAILURE },
  UPSTREAM_FAULT: { http: 502, message: GENERIC_FAILURE },
  UPSTREAM_TXN_FAILED: { http: 502, message: GENERIC_FAILURE },
  UPSTREAM_CONTRACT: { http: 502, message: GENERIC_FAILURE },
  UPSTREAM_MALFORMED: { http: 502, message: GENERIC_FAILURE },
  INTERNAL_ERROR: { http: 500, message: GENERIC_FAILURE },
};

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as readonly ErrorCode[];
