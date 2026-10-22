// Guest search / reveal BFF calls (design.md "apps/web" → api/guests.ts).
//
// The search and reveal mutations are wired into the UI state machine in later tasks
// (12.4 and 12.7); this module provides the typed transport they build on. Both are
// unsafe POSTs, so apiFetch adds the CSRF header and JSON content-type, and threads
// the AbortSignal so an in-flight search can be cancelled (Req 18.3).
import type {
  GuestSearchInput,
  GuestSearchResponse,
  RevealResponse,
} from '@ihg-guest-search/shared';

import { apiFetch } from './client.js';

/** POST /api/v1/guests/search → normalized, PII-masked results (Req 6.1, 6.4). */
export function searchGuests(
  criteria: GuestSearchInput,
  signal?: AbortSignal,
): Promise<GuestSearchResponse> {
  // The BFF search route treats the request body AS the criteria object directly
  // (routes/index.ts `asInput`, and every BFF integration test posts `{ lastName: … }`,
  // never `{ criteria: { … } }`). Sending the criteria object unwrapped keeps the client in
  // step with that contract; wrapping it tripped the schema's strictObject on an unknown
  // "criteria" key (VALIDATION_ERROR), which the E2E suite caught.
  return apiFetch<GuestSearchResponse>('/api/v1/guests/search', {
    method: 'POST',
    body: criteria,
    signal,
  });
}

/**
 * POST /api/v1/guests/reveal → the unmasked contact details for one guest, exchanged
 * for a short-lived, session-bound reveal token (Req 14.7, 16). An expired or wrong
 * token yields a REVEAL_EXPIRED ApiError the caller shows inline.
 */
export function revealGuest(revealToken: string, signal?: AbortSignal): Promise<RevealResponse> {
  return apiFetch<RevealResponse>('/api/v1/guests/reveal', {
    method: 'POST',
    body: { revealToken },
    signal,
  });
}
