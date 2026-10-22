/**
 * Rate limiting (design.md plugin order step 7; Req 21.6, 14.11).
 *
 * Registers `@fastify/rate-limit` globally disabled (`global: false`) so it adds no limit of its
 * own; the search and reveal routes opt in with their own per-minute budgets via the route
 * `config.rateLimit` option (wired in task 8.6). This keeps the limits beside the routes they
 * protect while the keying and error shape are defined once here.
 *
 * ## Keyed by session, not IP (Req 21.6: "per session")
 * The limiter key is the caller's session id, taken from `request.session.id` (established by the
 * session plugin, step 4). Keying by session — not client IP — means:
 *   - colleagues behind a shared corporate NAT/egress IP get independent budgets (a single office
 *     IP does not exhaust one shared bucket);
 *   - the limit tracks the authenticated unit of use, matching the reveal-token session binding.
 * Before a session exists (should not happen for `/api/*`, which runs after the session hook) the
 * key falls back to the client IP so the limiter still has a stable key. `trustProxy` is honoured
 * by Fastify when deriving `request.ip`, so the fallback respects the configured proxy chain.
 *
 * ## 429 flows through the error handler (design.md: "Fastify's default 413/415/429 ... routed
 * through the same errorHandler")
 * We deliberately do NOT supply an `errorResponseBuilder`. When a bucket is exceeded the plugin
 * raises Fastify's built-in 429 error, which reaches `setErrorHandler` (step 9); the handler maps
 * the 429 status to `RATE_LIMITED` and emits the standard `ErrorResponse` with the request id
 * (Req 19.2). That guarantees one body shape for every error, rate-limit included. Rate-limit
 * headers (`x-ratelimit-*`, `retry-after`) are left on so a well-behaved client can back off.
 */
import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Per-session (fallback: per-IP) key. Exported for the route tests so the keying is asserted
 * against the single source of truth.
 */
export function sessionKey(req: FastifyRequest): string {
  const session = req.session as { id?: string } | undefined;
  if (session?.id !== undefined) return `s:${session.id}`;
  return `ip:${req.ip}`;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(rateLimit, {
    global: false, // routes opt in with config.rateLimit (task 8.6)
    keyGenerator: sessionKey,
  });
};

export const rateLimitPlugin = fp(plugin, { name: 'rate-limit' });
