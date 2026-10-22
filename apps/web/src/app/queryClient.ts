// React Query client factory (design.md: "QueryClientProvider (gcTime 5 min, retry false)").
//
// Defaults that matter for this app:
//   - gcTime 5 min: results are held in memory for at most five minutes, matching the
//     Web_UI cache-lifetime limit (Req 21.8). Nothing is persisted (Req 21.7).
//   - retry: false: failures surface immediately as a typed ApiError so the UI can map
//     the code to the right state (alert, sign-in banner, inline message). Retrying a 4xx
//     is pointless and retrying a search silently would hide upstream errors; the user
//     retries explicitly via "Try again" (design.md state machine).
//
// A factory (not a module singleton) keeps tests isolated: each test mounts a fresh
// client, so cache state never leaks between cases.
import { QueryClient } from '@tanstack/react-query';

export const GC_TIME_MS = 5 * 60_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: GC_TIME_MS,
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
