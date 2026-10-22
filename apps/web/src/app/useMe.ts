// useMe: the signed-in colleague's identity, loaded once at startup (Req 20.8).
//
// Drives the header (display name, role, DEV AUTH badge) and the reveal affordance
// (shown only when roles include GuestSearch.RevealPII). An UNAUTHENTICATED (401)
// response surfaces as an ApiError with code UNAUTHENTICATED; the shell renders the
// sign-in banner for it rather than retrying (retry is off by default).
import type { MeResponse } from '@ihg-guest-search/shared';
import { ROLES } from '@ihg-guest-search/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getMe } from '../api/session.js';

export const ME_QUERY_KEY = ['me'] as const;

export function useMe(): UseQueryResult<MeResponse> {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: Infinity,
  });
}

/** True when the principal may reveal unmasked PII (gates the reveal button, Req 14.12). */
export function hasRevealRole(me: MeResponse | undefined): boolean {
  return me?.roles.includes(ROLES.REVEAL) ?? false;
}
