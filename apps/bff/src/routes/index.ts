/**
 * HTTP routes under `/api/v1` plus the health endpoints (task 8.6; design.md "Routes").
 *
 * The routes are deliberately THIN. Each one does only HTTP-shaped work — role gating, the
 * feature-flag guard, the server-side phone sanity check, cookie/header side effects — and then
 * delegates the domain work to `GuestSearchService` (search/reveal) or to the pure `buildUiConfig`
 * projection. No SOAP, masking, token or session-store logic lives here; that is owned by the
 * service, the security modules and the plugins. Keeping the handlers thin is what lets the same
 * service be exercised directly in unit tests and over HTTP in integration tests.
 *
 * ## Endpoint summary
 *   | Method | Path                      | Auth role           | Rate limit        | Req        |
 *   |--------|---------------------------|---------------------|-------------------|------------|
 *   | GET    | /api/v1/me                | authenticated       | —                 | 20.8       |
 *   | GET    | /api/v1/config            | authenticated       | —                 | 3.4, 3.5   |
 *   | POST   | /api/v1/guests/search     | GuestSearch.Read    | searchPerMinute   | 6, 9.5     |
 *   | POST   | /api/v1/guests/reveal     | GuestSearch.RevealPII | revealPerMinute | 14.7–14.11 |
 *   | POST   | /api/v1/session/logout    | authenticated       | —                 | 20.11      |
 *   | GET    | /health/live              | none                | —                 | 22.8       |
 *   | GET    | /health/ready             | none                | —                 | 22.9       |
 *
 * `/api/*` requires a principal (the auth plugin returns 401 otherwise), so `me`, `config` and
 * `logout` need no explicit role check — merely being authenticated is enough. `search` and
 * `reveal` add a `requireRole` preHandler; the error handler maps a missing role to a 403 that
 * never names the role (Req 20.7).
 *
 * ## Validation ownership (design.md "Validation ownership")
 * The search body is the RAW criteria object. The route does NOT parse it with the schema — the
 * service does, so the authoritative "is this a valid search" decision lives in one place and a
 * root-only issue becomes `NO_CRITERIA`. The route owns only what the schema cannot see:
 *   - the disabled-feature-field guard (Req 9.5), run on the RAW keys BEFORE the service, so a
 *     field the deployment has not enabled is rejected with a generic, value-free message; and
 *   - the server-side phone sanity check (`libphonenumber-js/max`), a defence-in-depth echo of the
 *     client-side check that rejects input which cannot be any phone number.
 * Both guards throw `AppError('VALIDATION_ERROR')` carrying per-field messages that describe the
 * rule and never echo the submitted value (Req 19.3, appsec review).
 *
 * The reveal body is validated minimally here (`{ revealToken: string }` present and non-empty);
 * anything else is `VALIDATION_ERROR`. A syntactically fine but unknown/expired/cross-session
 * token is the service's concern and comes back as `REVEAL_EXPIRED` (Req 14.9) — the two are kept
 * distinct so a malformed request is not reported as an expired reveal.
 */
import {
  ROLES,
  type CriteriaField,
  type GuestSearchInput,
  type MeResponse,
  type UiConfig,
} from '@ihg-guest-search/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isPossiblePhoneNumber } from 'libphonenumber-js/max';

import type { AuthProvider } from '../auth/authProvider.js';
import { requireRole } from '../auth/requireRole.js';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { ReadinessChecker } from '../health.js';
import type { RevealStore } from '../security/revealStore.js';
import type { GuestSearchService, SearchContext } from '../services/guestSearchService.js';
import { buildUiConfig, type UiConfigSource } from '../services/uiConfig.js';

/** Message for a criterion whose SOAP feature flag is off (Req 9.5). Never echoes a value. */
export const DISABLED_FIELD_MESSAGE = 'This field is not yet supported for search.';
/** Message for a phone criterion that cannot be any phone number (server-side sanity check). */
export const INVALID_PHONE_MESSAGE = 'Enter a valid phone number';
/** Message for a reveal request with a missing or malformed token. */
export const MISSING_REVEAL_TOKEN_MESSAGE = 'A reveal token is required';

/** Everything the routes need, assembled by `buildApp` (task 8.6) and injectable in tests. */
export interface RouteDeps {
  /** The non-sensitive slice of config projected into `GET /api/v1/config`. */
  readonly uiConfigSource: UiConfigSource;
  /** Address feature flags; drives the disabled-field guard on search (Req 9.5). */
  readonly features: AppConfig['soap']['features'];
  /** The auth provider, read for `authMode` in `GET /api/v1/me`. */
  readonly authProvider: AuthProvider;
  /** The orchestrating service the search and reveal routes delegate to. */
  readonly service: GuestSearchService;
  /** Reveal store, dropped on logout so sign-out discards all reveal material (Req 20.11). */
  readonly revealStore: RevealStore;
  /** Per-minute rate-limit budgets for the search and reveal routes (Req 21.6, 14.11). */
  readonly rateLimit: AppConfig['rateLimit'];
  /** Readiness checker for `GET /health/ready` (cached TCP probe). */
  readonly readiness: ReadinessChecker;
}

/**
 * The address criteria whose availability is gated by a SOAP feature flag (Req 9.5). Each maps
 * to a key of `AppConfig['soap']['features']`. `addressLine2` is gated too, but has no flag — it
 * is permanently off until the XSD confirms the element, so it is handled as "never enabled".
 */
const FEATURE_GATED: ReadonlyArray<{
  field: CriteriaField;
  flag: keyof AppConfig['soap']['features'];
}> = [
  { field: 'addressLine1', flag: 'addressLine1' },
  { field: 'city', flag: 'city' },
  { field: 'postalCode', flag: 'postalCode' },
];

/** `addressLine2` has no feature flag and stays disabled for search until the XSD confirms it. */
const ALWAYS_DISABLED: readonly CriteriaField[] = ['addressLine2'];

/** The reveal request body shape the route accepts. */
interface RevealBody {
  revealToken?: unknown;
}

/** Register all `/api/v1` and `/health` routes on the instance (called by `buildApp`). */
export function registerRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
  registerMe(fastify, deps);
  registerConfig(fastify, deps);
  registerSearch(fastify, deps);
  registerReveal(fastify, deps);
  registerLogout(fastify, deps);
  registerHealth(fastify, deps);
}

/** GET /api/v1/me — the authenticated caller's display name, roles and the auth mode (Req 20.8). */
function registerMe(fastify: FastifyInstance, deps: RouteDeps): void {
  fastify.get('/api/v1/me', async (request: FastifyRequest): Promise<MeResponse> => {
    const principal = requirePrincipal(request);
    return {
      displayName: principal.displayName,
      roles: [...principal.roles],
      authMode: deps.authProvider.mode,
    };
  });
}

/** GET /api/v1/config — the non-sensitive UI config (score bands, member types, flags, mode). */
function registerConfig(fastify: FastifyInstance, deps: RouteDeps): void {
  fastify.get('/api/v1/config', async (): Promise<UiConfig> => buildUiConfig(deps.uiConfigSource));
}

/**
 * POST /api/v1/guests/search — the core search (Req 6). Order: role → feature guard → phone
 * check → service. The service validates the body with the shared schema and masks the result.
 */
function registerSearch(fastify: FastifyInstance, deps: RouteDeps): void {
  fastify.post(
    '/api/v1/guests/search',
    {
      preHandler: requireRole(ROLES.READ),
      config: { rateLimit: rateLimitConfig(deps.rateLimit.searchPerMinute) },
    },
    async (request: FastifyRequest): Promise<unknown> => {
      const body = asInput(request.body);
      rejectDisabledFields(body, deps.features);
      rejectImpossiblePhone(body);
      return deps.service.search(body, searchContext(request));
    },
  );
}

/** POST /api/v1/guests/reveal — exchange a token for one guest's unmasked contacts (Req 14.7). */
function registerReveal(fastify: FastifyInstance, deps: RouteDeps): void {
  fastify.post(
    '/api/v1/guests/reveal',
    {
      preHandler: requireRole(ROLES.REVEAL),
      config: { rateLimit: rateLimitConfig(deps.rateLimit.revealPerMinute) },
    },
    async (request: FastifyRequest): Promise<unknown> => {
      const token = revealToken(request.body);
      return deps.service.reveal(token, searchContext(request));
    },
  );
}

/**
 * POST /api/v1/session/logout — destroy the session, drop all reveal material, clear site data
 * and the cookie, and answer 204 (Req 20.11). Being under `/api` it already requires a principal.
 */
function registerLogout(fastify: FastifyInstance, deps: RouteDeps): void {
  fastify.post('/api/v1/session/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    deps.revealStore.dropSession(request.session.id);
    request.destroySession(reply);
    // Instruct the browser to clear cookies, storage and the back/forward cache for this origin.
    reply.header('Clear-Site-Data', '"cache", "cookies", "storage"');
    return reply.code(204).send();
  });
}

/** GET /health/live and /health/ready — outside `/api`, no auth, no credentials (Req 22.8/22.9). */
function registerHealth(fastify: FastifyInstance, deps: RouteDeps): void {
  fastify.get('/health/live', async () => ({ status: 'ok' as const }));
  fastify.get('/health/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    const checks = await deps.readiness.check();
    const status = checks.config && checks.soap ? 'ok' : 'degraded';
    // 200 when ready, 503 when a dependency is down so a load balancer can route away.
    return reply.code(status === 'ok' ? 200 : 503).send({ status, checks });
  });
}

// --- helpers ---------------------------------------------------------------------------------

/** Build the service context from the request's correlation id, principal and session. */
function searchContext(request: FastifyRequest): SearchContext {
  return {
    requestId: request.id,
    principal: requirePrincipal(request),
    sessionId: request.session.id,
  };
}

/** The principal, which the auth plugin guarantees on `/api/*`; defensive for non-API mounts. */
function requirePrincipal(request: FastifyRequest) {
  if (request.principal === null || request.principal === undefined) {
    throw new AppError('UNAUTHENTICATED', 'No principal on request');
  }
  return request.principal;
}

/** Treat the parsed JSON body as the raw criteria input (an object, or `{}` when absent). */
function asInput(body: unknown): GuestSearchInput {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('VALIDATION_ERROR', 'Request body must be a JSON object', {
      cause: [{ field: 'root', message: 'Enter at least one search criterion' }],
    });
  }
  return body as GuestSearchInput;
}

/**
 * Reject any supplied criterion whose feature flag is off, or that is permanently disabled
 * (Req 9.5). A field counts as "supplied" when its raw value is a non-empty, non-whitespace
 * string — so an empty string the form might send is ignored, matching the schema's own
 * "normalizes to undefined = not supplied" rule. The message is generic and value-free.
 */
function rejectDisabledFields(
  body: GuestSearchInput,
  features: AppConfig['soap']['features'],
): void {
  const fields: { field: CriteriaField; message: string }[] = [];
  for (const { field, flag } of FEATURE_GATED) {
    if (isSupplied(body[field]) && !features[flag]) {
      fields.push({ field, message: DISABLED_FIELD_MESSAGE });
    }
  }
  for (const field of ALWAYS_DISABLED) {
    if (isSupplied(body[field])) fields.push({ field, message: DISABLED_FIELD_MESSAGE });
  }
  if (fields.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'Disabled search field supplied', { cause: fields });
  }
}

/**
 * Server-side phone sanity check (design.md: "server phone check with libphonenumber-js/max").
 * Defence in depth behind the client check: reject only input that cannot be ANY phone number.
 * `isPossiblePhoneNumber` is a length/shape test (lenient, locale-free), so a partial but
 * plausible number is allowed through to the upstream; a value with no digits or an impossible
 * length is rejected with a value-free message. A supplied phone that trims to nothing is left to
 * the schema (NO_CRITERIA), so this guard only runs on a non-empty value.
 */
function rejectImpossiblePhone(body: GuestSearchInput): void {
  const raw = body.phone;
  if (!isSupplied(raw)) return;
  // `isPossiblePhoneNumber` throws on some malformed input; treat any throw as "not possible".
  let possible: boolean;
  try {
    possible = isPossiblePhoneNumber(raw.trim());
  } catch {
    possible = false;
  }
  if (!possible) {
    throw new AppError('VALIDATION_ERROR', 'Phone criterion is not a possible number', {
      cause: [{ field: 'phone', message: INVALID_PHONE_MESSAGE }],
    });
  }
}

/** Validate the reveal body shape and return the token (Req 14.7). */
function revealToken(body: unknown): string {
  const token = (body as RevealBody | null | undefined)?.revealToken;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new AppError('VALIDATION_ERROR', 'Missing reveal token', {
      cause: [{ field: 'root', message: MISSING_REVEAL_TOKEN_MESSAGE }],
    });
  }
  return token;
}

/** A raw criterion value counts as supplied only when it is a non-whitespace string. */
function isSupplied(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The `@fastify/rate-limit` per-route config object for a given per-minute budget. */
function rateLimitConfig(max: number): { max: number; timeWindow: string } {
  return { max, timeWindow: '1 minute' };
}
