/**
 * Plugin composition (design.md "apps/bff — HTTP layer", plugins registered in order).
 *
 * `registerHttpPlugins` registers the cross-cutting plugins in the exact design order so that
 * `buildApp` (task 8.6) — and the security integration tests — compose the HTTP layer from one
 * place and cannot drift from the documented sequence. The order is load-bearing:
 *
 *   1. requestId  — must run first so every later hook/handler and every error body has an id.
 *   2. security   — helmet headers (CSP, Referrer-Policy, nosniff, HSTS in prod, frame-ancestors).
 *   3. noStore    — `Cache-Control: no-store` on `/api/*`.
 *   4. cookie+session — the signed session cookie and server-side session (binds before auth).
 *   5. auth       — resolve `request.principal`; 401 on `/api/*` when unauthenticated.
 *   6. csrf       — `X-Requested-With` + `Sec-Fetch-Site` checks on unsafe methods.
 *   7. rateLimit  — per-session key; routes opt in with their own budgets (task 8.6).
 *   8. body limit / content-type — set on the Fastify instance in `buildApp`, not here
 *      (`bodyLimit` and the JSON-only parser are instance options, applied before routes).
 *   9. errorHandler / notFoundHandler — installed here last so every preceding plugin's throw is
 *      mapped to the `ErrorResponse` shape.
 *
 * `genReqId` and the `bodyLimit`/content-type parser are configured on the Fastify instance at
 * construction time by `buildApp` (they are read when the instance is created, before any plugin
 * registers); this module owns everything that is registered as a plugin or handler.
 */
import type { ErrorCode } from '@ihg-guest-search/shared';
import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '../auth/authProvider.js';
import type { SessionStore } from '../auth/sessionStore.js';
import { authPlugin } from './auth.js';
import { csrfPlugin } from './csrf.js';
import { createErrorHandler, createNotFoundHandler } from './errorHandler.js';
import { noStorePlugin } from './noStore.js';
import { rateLimitPlugin } from './rateLimit.js';
import { requestIdPlugin } from './requestId.js';
import { securityPlugin } from './security.js';
import { sessionPlugin } from './session.js';

export interface HttpPluginDeps {
  /** Emit production-only headers (HSTS) when true. */
  readonly production: boolean;
  /** Secret used to sign the session cookie. */
  readonly sessionSecret: string;
  /** Session cookie name (its `__Host-` prefix decides `Secure`). */
  readonly sessionCookieName: string;
  /** Server-side session store. */
  readonly sessionStore: SessionStore;
  /** Authentication provider (dev now, OIDC later). */
  readonly authProvider: AuthProvider;
  /**
   * Install the catalog JSON not-found handler here (default `true`). `buildApp` sets this
   * `false` when it serves the SPA, because `@fastify/static`'s SPA fallback needs to own the
   * single root not-found handler (Fastify forbids setting it twice at the same prefix). In that
   * case `buildApp` installs a combined handler that serves `index.html` for non-API misses and
   * the same catalog JSON 404 for `/api/*` and `/health/*` (design.md plugin 10).
   */
  readonly installNotFoundHandler?: boolean;
  /**
   * Metrics hook passed to the error handler (task 9.2): called with the catalog `ErrorCode` of
   * every mapped failure to feed the `gs.errors{code}` counter. Optional; must not throw.
   */
  readonly onError?: (code: ErrorCode) => void;
}

/** Register the HTTP-layer plugins and the error/not-found handlers in design order. */
export async function registerHttpPlugins(
  fastify: FastifyInstance,
  deps: HttpPluginDeps,
): Promise<void> {
  await fastify.register(requestIdPlugin);
  await fastify.register(securityPlugin, { production: deps.production });
  await fastify.register(noStorePlugin);
  await fastify.register(sessionPlugin, {
    secret: deps.sessionSecret,
    cookieName: deps.sessionCookieName,
    store: deps.sessionStore,
  });
  await fastify.register(authPlugin, { provider: deps.authProvider });
  await fastify.register(csrfPlugin);
  await fastify.register(rateLimitPlugin);

  fastify.setErrorHandler(
    createErrorHandler(deps.onError !== undefined ? { onError: deps.onError } : {}),
  );
  if (deps.installNotFoundHandler !== false) {
    fastify.setNotFoundHandler(createNotFoundHandler());
  }
}

export { authPlugin } from './auth.js';
export { csrfPlugin, REQUIRED_REQUESTED_WITH } from './csrf.js';
export { createErrorHandler, createNotFoundHandler } from './errorHandler.js';
export { API_PREFIX, noStorePlugin } from './noStore.js';
export { rateLimitPlugin, sessionKey } from './rateLimit.js';
export { genReqId, REQUEST_ID_HEADER, requestIdPlugin } from './requestId.js';
export { CSP_DIRECTIVES, securityPlugin } from './security.js';
