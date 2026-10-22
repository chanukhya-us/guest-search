/**
 * UiConfig builder (task 8.4; Req 3.4, 3.5, 9.4, 15.6; design.md "GET /api/v1/config").
 *
 * `GET /api/v1/config` (route in task 8.6) returns a NON-sensitive `UiConfig` so the SPA can:
 *   - colour score chips by the configured bands (Req 15.6),
 *   - populate the Member Type select from the configured code set (Req 3.4),
 *   - disable the address fields whose SOAP feature flags are off (Req 3.5, 9.4), and
 *   - show the "DEV AUTH" badge and behave consistently with the auth mode (Req 20.9).
 *
 * This is a pure projection of `AppConfig` onto the shared `UiConfig` shape. It deliberately
 * copies ONLY the four non-sensitive groups. It never exposes the SOAP endpoint, header
 * values, secrets, timeouts, rate limits, breaker settings or telemetry config — a config
 * endpoint is an attack-surface, so it is an explicit allowlist, not a filtered dump of
 * `AppConfig` (security-architect review: default-deny on outbound config).
 *
 * Kept as a standalone function (not a `GuestSearchService` method) because it needs the full
 * `AppConfig` rather than the service's gateway/schema/store deps, and the route can build it
 * without constructing the search service.
 */
import type { UiConfig } from '@ihg-guest-search/shared';

import type { AppConfig } from '../config.js';

/** The minimal slice of `AppConfig` the UI config is projected from. */
export type UiConfigSource = Pick<AppConfig, 'ui' | 'soap' | 'auth'>;

/** Project `AppConfig` onto the non-sensitive `UiConfig` served to the browser. */
export function buildUiConfig(cfg: UiConfigSource): UiConfig {
  return {
    scoreBands: { high: cfg.ui.scoreBands.high, medium: cfg.ui.scoreBands.medium },
    // Fresh copies so a caller cannot mutate the loaded config through the response.
    memberTypes: cfg.ui.memberTypes.map((t) => ({ code: t.code, label: t.label })),
    features: {
      addressLine1: cfg.soap.features.addressLine1,
      city: cfg.soap.features.city,
      postalCode: cfg.soap.features.postalCode,
    },
    authMode: cfg.auth.mode,
  };
}
