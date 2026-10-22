// Session- and config-scoped BFF calls (design.md "apps/web" API client surface).
//
// These three endpoints frame the app shell: config and me are read once at startup
// and cached by React Query; logout tears the session down. All go through apiFetch,
// so they inherit same-origin, credentials, the CSRF header (on the unsafe logout)
// and typed ApiError handling.
import type { MeResponse, UiConfig } from '@ihg-guest-search/shared';

import { apiFetch } from './client.js';

/** GET /api/v1/config → non-sensitive UI configuration (Req 3.4, 3.5, 6.6). */
export function getConfig(signal?: AbortSignal): Promise<UiConfig> {
  return apiFetch<UiConfig>('/api/v1/config', { signal });
}

/** GET /api/v1/me → the signed-in colleague's display name and roles (Req 20.8). */
export function getMe(signal?: AbortSignal): Promise<MeResponse> {
  return apiFetch<MeResponse>('/api/v1/me', { signal });
}

/**
 * POST /api/v1/session/logout → destroys the server session and its reveal tokens,
 * and sends Clear-Site-Data (Req 20.11). Resolves on the BFF's 204. Unsafe, so
 * apiFetch adds the CSRF header automatically.
 */
export function logout(signal?: AbortSignal): Promise<void> {
  return apiFetch<void>('/api/v1/session/logout', { method: 'POST', signal });
}
