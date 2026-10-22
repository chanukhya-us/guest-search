/**
 * `Cache-Control: no-store` for the API surface (design.md plugin order step 3; Req 21.2).
 *
 * Every `/api/*` response carries guest data or identity state, so none of it may be cached by
 * the browser, a proxy, or the back/forward cache. Setting `no-store` on the whole API prefix
 * (not just search results) keeps the rule simple and total: there is no endpoint under `/api`
 * whose response is safe to persist.
 *
 * The header is set in `onRequest` so it is present on error responses too (401/403/413/429 and
 * the mapped `ErrorResponse`), not only on handler successes. Static assets under `/` and the
 * health endpoints are intentionally untouched — they are cacheable and not covered by Req 21.2.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/** The prefix whose every response must be uncacheable. */
export const API_PREFIX = '/api/';

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    // Match `/api` exactly and everything under `/api/`; ignore the query string.
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (path === '/api' || path.startsWith(API_PREFIX)) {
      reply.header('Cache-Control', 'no-store');
    }
  });
};

export const noStorePlugin = fp(plugin, { name: 'no-store' });
