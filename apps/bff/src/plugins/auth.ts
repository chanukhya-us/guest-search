/**
 * Authentication plugin (design.md plugin order step 5; Req 20.1, 20.6).
 *
 * Resolves the caller for every request through the injected `AuthProvider` and publishes the
 * result on `request.principal` (declared by `authProvider.ts`). The provider is the single
 * seam between "who is calling" and the rest of the app: dev mode always authenticates to the
 * configured persona; a future OIDC provider slots in here with no change to routes or services
 * (Req 20.1, 20.2).
 *
 * ## Where 401 is (and is not) enforced
 * Only the API surface requires a principal. When the provider returns `null` on an `/api/*`
 * request the plugin throws `AppError('UNAUTHENTICATED')`, which the error handler (step 9) maps
 * to HTTP 401 with the catalog body — the handler never reveals why (Req 20.6, 19.3). Non-API
 * paths (static assets, `/health/*`) are left to proceed unauthenticated: the SPA shell and the
 * liveness/readiness probes must load without a session.
 *
 * In dev mode `DevAuthProvider` never returns `null`, so the 401 path is exercised only by a
 * provider stub in tests and by a real OIDC provider later. Enforcing it now keeps the contract
 * honest regardless of provider.
 *
 * ## Ordering relative to the session plugin (step 4, registered before this one)
 * Per design.md the session plugin runs first and establishes an opaque, signed session cookie;
 * this auth plugin runs after and attaches the Principal. The two are deliberately independent:
 * the session is a server-side container keyed by a cookie, while the Principal is re-derived
 * from the `AuthProvider` on every request. Because the Principal is authoritative per request,
 * the session does not need it at creation time — the session plugin binds a new session to
 * `anonymous` on the very first request (before any auth has run) and the Principal is layered on
 * top here. Reveal tokens are bound to the session id, and the role checks use `request.principal`
 * set here, so no security decision depends on the session's stored `principalId`. This matches
 * the design order exactly; if a future provider needs the Principal reflected into the session
 * record, the session plugin's `updatePrincipal` seam already exists for that without reordering.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { AuthProvider } from '../auth/authProvider.js';
import { AppError } from '../errors.js';

export interface AuthPluginOptions {
  /** The configured provider (`DevAuthProvider` now; OIDC later). */
  readonly provider: AuthProvider;
}

/** The prefix whose requests require an authenticated Principal (Req 20.6). */
export const API_PREFIX = '/api/';

/** True when the path is part of the authenticated API surface (`/api` and everything under it). */
export function isApiPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return path === '/api' || path.startsWith(API_PREFIX);
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const { provider } = opts;

  // Decorate so the type is non-optional on every request even before the hook runs; the hook
  // overwrites it on each request. `null` means "no principal resolved yet / unauthenticated".
  fastify.decorateRequest('principal', null);

  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const principal = await provider.authenticate(request);
    request.principal = principal;
    if (principal === null && isApiPath(request.url)) {
      throw new AppError('UNAUTHENTICATED', 'No principal resolved for an API request');
    }
  });
};

export const authPlugin = fp(plugin, { name: 'auth' });
