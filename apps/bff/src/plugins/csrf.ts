/**
 * CSRF defence (design.md plugin order step 6; Req 21.3, 21.4).
 *
 * The app is a same-origin SPA with a `SameSite=Strict`, `HttpOnly` session cookie, so classic
 * cross-site form/XHR CSRF is already heavily constrained. This plugin adds the two header checks
 * the requirements pin, giving defence in depth that does not rely on the browser's SameSite
 * behaviour alone:
 *
 *   1. Custom-header requirement (Req 21.3). Every state-changing API request must carry
 *      `X-Requested-With: guest-search`. A cross-site HTML form or a simple cross-origin `fetch`
 *      cannot set a custom request header without triggering a CORS preflight, and CORS is never
 *      enabled on this origin (Req 21.5), so the browser will not send the unsafe request at all.
 *      The SPA's API client always sets this header (task 8.6 / 12.2). A missing or wrong value
 *      is rejected with 403.
 *
 *   2. Fetch-metadata check (Req 21.4). Modern browsers stamp `Sec-Fetch-Site` on every request;
 *      `cross-site` means the request was initiated from a different site. We reject that outright
 *      for state-changing methods. `same-origin`, `same-site` and `none` (a user-initiated top-level
 *      navigation, which does not apply to our JSON POSTs) are allowed; absent header (older
 *      clients, server-to-server tests) falls back to check (1).
 *
 * ## Scope
 * The checks apply only to the unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) — the methods that
 * can change server state. `GET`/`HEAD`/`OPTIONS` are safe and untouched, so the SPA shell, config
 * and `me` loads are not burdened. The plugin does not look at the path: the only unsafe routes are
 * under `/api`, and applying the rule to any future unsafe route is the safe default.
 *
 * ## Why 403 via AppError
 * Both failures throw `AppError('FORBIDDEN')`, so the error handler (step 9) returns the catalog
 * 403 body with the request id. The response never explains which check failed (Req 19.3) — an
 * attacker learns only that the request was refused.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../errors.js';

/** HTTP methods that can change state and therefore require CSRF defences (Req 21.3). */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The exact `X-Requested-With` value the SPA sends and the BFF demands (Req 21.3). */
export const REQUIRED_REQUESTED_WITH = 'guest-search';

/** A single string header value (take the first if a client sent the header more than once). */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    if (!UNSAFE_METHODS.has(request.method)) return;

    // Req 21.4: reject requests a browser reports as cross-site.
    if (headerValue(request.headers['sec-fetch-site']) === 'cross-site') {
      throw new AppError('FORBIDDEN', 'Cross-site state-changing request rejected');
    }

    // Req 21.3: require the custom header with the exact token.
    if (headerValue(request.headers['x-requested-with']) !== REQUIRED_REQUESTED_WITH) {
      throw new AppError('FORBIDDEN', 'Missing or invalid X-Requested-With header');
    }
  });
};

export const csrfPlugin = fp(plugin, { name: 'csrf' });
