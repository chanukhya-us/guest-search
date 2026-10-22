// useReveal: the in-memory, per-guest reveal store for the current result set
// (task 12.7, design.md "useReveal.ts — per-row revealed map (in memory), cleared on new
// search/clear/logout"; Req 14.12, 14.13, 21.7, 21.8).
//
// The unmasked phones and emails returned by POST /api/v1/guests/reveal live ONLY here,
// in React component state, keyed by Enterprise ID, for as long as the results are on
// screen. They are deliberately NOT written to the React Query cache: the search query
// caches the MASKED response, and nothing unmasked is ever persisted to Web Storage,
// IndexedDB or a cache that could outlive the session (Req 21.7). The map is cleared when
// a new search starts, when Clear is activated, and on sign-out (Req 14.13) — all of which
// re-key or drop this hook's owning tree, and the explicit `clear()` below gives callers a
// deterministic reset. Closing the drawer does not clear the map: once revealed for a row,
// the value stays revealed for that row (design.md "swapped in from the reveal map") until
// one of the discard events fires.
import type { RevealResponse } from '@ihg-guest-search/shared';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { useStatusRegion } from '../../a11y/StatusRegion.js';
import { ApiError } from '../../api/client.js';
import { revealGuest } from '../../api/guests.js';

/** The unmasked contact details revealed for a single guest. */
export interface RevealedContact {
  phones: RevealResponse['phones'];
  emails: RevealResponse['emails'];
}

export interface RevealMap {
  /** The unmasked details for `enterpriseId`, or undefined if not yet revealed. */
  get: (enterpriseId: string) => RevealedContact | undefined;
  /** Record the unmasked details returned by a successful reveal for `enterpriseId`. */
  set: (enterpriseId: string, contact: RevealedContact) => void;
  /** Drop every revealed value (new search, Clear, sign-out — Req 14.13). */
  clear: () => void;
}

/**
 * Create an in-memory reveal store. The state is a plain object keyed by Enterprise ID;
 * a ref mirror lets `get` read the latest values synchronously without the caller
 * subscribing to the whole map. Mutations go through `set`/`clear`, which replace the
 * object so React re-renders the rows and the drawer with the revealed values.
 */
export function useReveal(): RevealMap {
  const [, force] = useState(0);
  const storeRef = useRef<Record<string, RevealedContact>>({});

  const get = useCallback(
    (enterpriseId: string): RevealedContact | undefined => storeRef.current[enterpriseId],
    [],
  );

  const set = useCallback((enterpriseId: string, contact: RevealedContact): void => {
    storeRef.current = { ...storeRef.current, [enterpriseId]: contact };
    force((n) => n + 1);
  }, []);

  const clear = useCallback((): void => {
    if (Object.keys(storeRef.current).length === 0) return;
    storeRef.current = {};
    force((n) => n + 1);
  }, []);

  return { get, set, clear };
}

/** The copy shown inline when a reveal token has expired (Req 14.14). */
export const REVEAL_EXPIRED_MESSAGE = 'Details expired. Please search again.';

export interface RevealAction {
  /** Trigger a reveal for the guest's token. No-op while a request is in flight. */
  run: (token: string) => void;
  /** True while the reveal request is in flight (show a busy state, Req 14). */
  pending: boolean;
  /** True when the last reveal failed with REVEAL_EXPIRED (Req 14.14). */
  expired: boolean;
  /** The catalog message for a non-expired reveal error, else undefined. */
  errorMessage: string | undefined;
}

/**
 * Shared reveal mutation for one guest, used by both the table's masked cell and the
 * drawer so they expose identical busy / expired / error states and write to the same
 * in-memory map (Req 14.12). On success the unmasked phones/emails returned by the BFF are
 * stored for `enterpriseId` and a polite "revealed" status is announced; nothing unmasked
 * is cached by React Query (no query key; retry is off globally — Req 21.7).
 */
export function useRevealAction(
  enterpriseId: string,
  name: string,
  reveal: RevealMap,
): RevealAction {
  const { announce } = useStatusRegion();
  const mutation = useMutation({
    mutationFn: (token: string) => revealGuest(token),
    onSuccess: (data) => {
      reveal.set(enterpriseId, { phones: data.phones, emails: data.emails });
      announce(`Contact details revealed for ${name}.`);
    },
  });

  const expired = mutation.error instanceof ApiError && mutation.error.code === 'REVEAL_EXPIRED';
  const errorMessage =
    mutation.error instanceof ApiError && !expired ? mutation.error.message : undefined;

  return {
    run: (token: string) => {
      if (!mutation.isPending) mutation.mutate(token);
    },
    pending: mutation.isPending,
    expired,
    errorMessage,
  };
}
