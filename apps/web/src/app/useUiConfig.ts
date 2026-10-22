// useUiConfig: the non-sensitive UI configuration, loaded once at startup (Req 3.4, 3.5).
//
// The config shapes the form (member types, address feature flags) and the results
// table (score bands), so it is fetched before the app is usable and then cached for
// the session (staleTime Infinity: it does not change while the page is open).
import type { UiConfig } from '@ihg-guest-search/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getConfig } from '../api/session.js';

export const UI_CONFIG_QUERY_KEY = ['ui-config'] as const;

export function useUiConfig(): UseQueryResult<UiConfig> {
  return useQuery({
    queryKey: UI_CONFIG_QUERY_KEY,
    queryFn: ({ signal }) => getConfig(signal),
    staleTime: Infinity,
  });
}
