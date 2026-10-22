// useGuestSearch: the search controller / state machine (task 12.4, design.md
// "Search flow state machine").
//
// It wraps the search request lifecycle and derives the UI state the ResultsPanel and
// SearchForm render. The flow (design.md state diagram, Req 5, 18, 24):
//
//   idle ─submit(valid)→ loading ─200,n>0→ results
//                               └─200,n=0→ empty
//                               └─ApiError→ error            (UPSTREAM_*/INTERNAL/RATE_LIMITED/…)
//                               └─400 VALIDATION/NO_CRITERIA→ invalid (field errors in the form)
//   results/empty/error ─submit/Try again→ loading
//   * ─Clear→ idle
//
// Request lifecycle (Req 18):
//   - Each submit gets a fresh `searchId`. The query is keyed by `['guest-search',
//     searchId]` only; the criteria live in component state, never in the serializable
//     cache key (design.md, Req 21.7).
//   - Starting a new search cancels the previous in-flight request via
//     `queryClient.cancelQueries` (aborts its AbortSignal, Req 18.3). Because only the
//     latest searchId is enabled, a late-resolving previous request never renders.
//   - Submits are ignored while a search is loading (Req 18.2).
//   - "Try again" re-runs the last criteria under a new searchId (Req 18.7).
//
// This hook does NOT render anything. It returns the derived `state`, the data for the
// results region, the `serverErrors` to hand back to SearchForm, and the submit/retry/
// clear callbacks. Document title (Req 24.11) and status announcements (Req 18.1/18.4)
// are effects of the state, so they live here where the state transitions are known.
import type { GuestSearchQuery, GuestSearchResponse } from '@ihg-guest-search/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useStatusRegion } from '../../a11y/StatusRegion.js';
import { ApiError } from '../../api/client.js';
import { searchGuests } from '../../api/guests.js';
import { setDocumentTitle } from '../../app/useTitle.js';
import type { ServerFieldError } from './SearchForm.js';

/** Base query key; the searchId is appended so each submit is a distinct query. */
export const GUEST_SEARCH_QUERY_KEY = 'guest-search';

/** The discriminated UI state the ResultsPanel switches on (design.md state machine). */
export type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; response: GuestSearchResponse }
  | { kind: 'empty' }
  | { kind: 'error'; code: string; message: string; requestId?: string };

/** The codes that route back into the form as field/root errors, not the error panel. */
function isFormValidationError(error: ApiError): boolean {
  return error.code === 'VALIDATION_ERROR' || error.code === 'NO_CRITERIA';
}

export interface UseGuestSearchResult {
  /** The current derived UI state for the results region. */
  state: SearchState;
  /** True while a request is in flight (drives SearchForm `submitting`, Req 18.1). */
  submitting: boolean;
  /** BFF field/root errors to render in SearchForm's inline + summary UI (Req 5.7). */
  serverErrors: readonly ServerFieldError[];
  /** True when an UNAUTHENTICATED response was received (shell shows the sign-in banner). */
  unauthenticated: boolean;
  /** Start a search for the given validated criteria (ignored while loading, Req 18.2). */
  submit: (criteria: GuestSearchQuery) => void;
  /** Re-run the last submitted criteria (Try again, Req 18.7). */
  retry: () => void;
  /** Reset to idle, clearing results and errors (Clear). */
  clear: () => void;
}

export function useGuestSearch(): UseGuestSearchResult {
  const queryClient = useQueryClient();
  const { announce } = useStatusRegion();

  // The active searchId (0 = nothing searched yet / idle). Bumped on every submit so the
  // query key changes and a brand-new request starts, cancelling the prior one.
  const [searchId, setSearchId] = useState(0);
  // The criteria for the active searchId. Kept out of the query key on purpose (Req 21.7).
  const [criteria, setCriteria] = useState<GuestSearchQuery | null>(null);
  // Server-side field/root errors mapped back into the form (Req 5.7).
  const [serverErrors, setServerErrors] = useState<readonly ServerFieldError[]>([]);

  const query = useQuery<GuestSearchResponse, ApiError>({
    queryKey: [GUEST_SEARCH_QUERY_KEY, searchId],
    queryFn: ({ signal }) => searchGuests(criteria as GuestSearchQuery, signal),
    // Only runs once a real search has started and criteria exist.
    enabled: searchId > 0 && criteria !== null,
    staleTime: Infinity,
    retry: false,
    gcTime: 5 * 60_000,
  });

  // Derive the error branch: form-validation codes go to the form, everything else to the
  // error panel. UNAUTHENTICATED is surfaced separately for the shell's sign-in handling.
  const apiError = query.error instanceof ApiError ? query.error : null;
  const formError = apiError !== null && isFormValidationError(apiError);
  const unauthenticated = apiError?.code === 'UNAUTHENTICATED';

  // Keep serverErrors in sync with the latest form-validation failure. We map the BFF's
  // error.fields (which never echo values, Req 19.3) into SearchForm's ServerFieldError.
  useEffect(() => {
    if (apiError !== null && formError) {
      const fields = apiError.fields ?? [];
      const mapped: ServerFieldError[] =
        fields.length > 0
          ? fields.map((f) => ({ field: f.field, message: f.message }))
          : // NO_CRITERIA with no per-field list: surface the message as the root error.
            [{ field: 'root', message: apiError.message }];
      setServerErrors(mapped);
    }
  }, [apiError, formError]);

  // Derive the discriminated state the panel renders.
  const state = deriveState(query, { apiError, formError, unauthenticated });

  // Title (Req 24.11) and polite announcement (Req 18.1, 18.4) for the current state.
  // Precomputed into plain strings so the sync effect can depend on them directly (stable
  // identity, no inline function calls in the dependency array). The error state has no
  // announcement: the error alert announces itself via role="alert", so the status region
  // stays silent to avoid double announcement (Req 24.9).
  const title = titleForState(state);
  const announcement = announcementForState(state);

  // Keep the latest announce in a ref so the effect depends only on `announcement`,
  // re-announcing exactly once per state change (and again on an identical repeat search,
  // which StatusRegion handles by re-emitting the same text).
  const announceRef = useRef(announce);
  announceRef.current = announce;
  useEffect(() => {
    setDocumentTitle(title);
    if (announcement !== null) announceRef.current(announcement);
  }, [title, announcement]);

  const submit = useCallback(
    (next: GuestSearchQuery) => {
      // Ignore new submits while a search is loading (Req 18.2).
      if (query.isFetching) return;
      // Cancel the previous in-flight request (aborts its signal, Req 18.3).
      void queryClient.cancelQueries({ queryKey: [GUEST_SEARCH_QUERY_KEY] });
      setServerErrors([]);
      setCriteria(next);
      setSearchId((id) => id + 1);
    },
    [query.isFetching, queryClient],
  );

  const retry = useCallback(() => {
    if (criteria === null) return;
    if (query.isFetching) return;
    void queryClient.cancelQueries({ queryKey: [GUEST_SEARCH_QUERY_KEY] });
    setServerErrors([]);
    setSearchId((id) => id + 1);
  }, [criteria, query.isFetching, queryClient]);

  const clear = useCallback(() => {
    void queryClient.cancelQueries({ queryKey: [GUEST_SEARCH_QUERY_KEY] });
    queryClient.removeQueries({ queryKey: [GUEST_SEARCH_QUERY_KEY] });
    setServerErrors([]);
    setCriteria(null);
    setSearchId(0);
  }, [queryClient]);

  return {
    state,
    submitting: query.isFetching,
    serverErrors,
    unauthenticated: unauthenticated ?? false,
    submit,
    retry,
    clear,
  };
}

/** Compute the discriminated state from the query status and the classified error. */
function deriveState(
  query: { isFetching: boolean; data?: GuestSearchResponse; fetchStatus: string },
  cls: { apiError: ApiError | null; formError: boolean; unauthenticated: boolean | undefined },
): SearchState {
  if (query.isFetching) return { kind: 'loading' };

  const { apiError, formError, unauthenticated } = cls;
  if (apiError !== null) {
    // Form-validation and unauthenticated errors are handled outside the panel; the
    // results region falls back to idle (no results, no generic error alert).
    if (formError || unauthenticated) return { kind: 'idle' };
    return {
      kind: 'error',
      code: apiError.code,
      message: apiError.message,
      requestId: apiError.requestId,
    };
  }

  if (query.data) {
    return query.data.totalResults === 0
      ? { kind: 'empty' }
      : { kind: 'results', response: query.data };
  }

  return { kind: 'idle' };
}

/** The document-title state label for the current state (Req 24.11, design.md states). */
function titleForState(state: SearchState): string {
  switch (state.kind) {
    case 'loading':
      return 'Searching';
    case 'results':
      return `${state.response.totalResults} results`;
    case 'empty':
      return 'No results';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Search';
  }
}

/**
 * The polite Status_Region announcement for the current state, or null when the state
 * should not announce via the live region (idle, and error — which uses role="alert").
 */
function announcementForState(state: SearchState): string | null {
  switch (state.kind) {
    case 'loading':
      return 'Searching guests…';
    case 'results':
      // Req 18.4 exact wording: "{n} guests found".
      return `${state.response.totalResults} guests found`;
    case 'empty':
      return 'No guests found matching the search criteria.';
    case 'idle':
    case 'error':
      return null;
  }
}
