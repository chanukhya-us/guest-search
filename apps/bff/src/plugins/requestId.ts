/**
 * Request-ID / correlation plugin (design.md plugin order step 1; Req 22.1, 22.10).
 *
 * Every request gets a stable correlation id, surfaced three ways:
 *   - `request.id` — Fastify's own id, which we drive from `genReqId` so it is a UUID v4
 *     rather than the default monotonic counter. The logger child Fastify builds per request
 *     already carries this id, so log lines and the response header always agree (Req 22.1).
 *   - `X-Request-ID` response header — set on every reply, success or error, so a colleague
 *     can quote the reference and an operator can find the matching log line (Req 22.10).
 *   - inbound honouring — if a trusted edge already stamped `X-Request-ID`, we reuse it so a
 *     single correlation id spans the whole hop. Only a syntactically safe value is trusted;
 *     anything else is replaced with a fresh UUID so a client cannot inject header content.
 *
 * This plugin owns nothing else: the id it establishes is read by the logger (task 9.1), the
 * services (as the SOAP transaction id) and the error handler (which copies it into every
 * `ErrorResponse.requestId`). It is registered first so the id exists before any other plugin
 * or handler runs.
 *
 * `genReqId` is configured on the Fastify instance (in `buildApp`, task 8.6) rather than here,
 * because Fastify reads it at instance-creation time; this plugin exports the generator and the
 * header wiring so both live together and `buildApp` only has to reference them.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/** The correlation header, matched case-insensitively on the way in, set verbatim on the way out. */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * A client-supplied id we are willing to echo: a short, printable token with no header-control
 * characters. Kept deliberately strict so an upstream value can never smuggle CR/LF or payload
 * text into our logs or responses. UUIDs, ULIDs and trace ids all pass.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Fastify `genReqId`: reuse a trusted inbound `X-Request-ID`, otherwise mint a UUID v4.
 * Wire this into `Fastify({ genReqId })` so `request.id` and the per-request logger child
 * share the value this plugin also writes to the response header.
 */
export function genReqId(req: { headers: Record<string, unknown> }): string {
  const header = req.headers['x-request-id'];
  const candidate = Array.isArray(header) ? header[0] : header;
  if (typeof candidate === 'string' && SAFE_ID.test(candidate)) return candidate;
  return randomUUID();
}

const plugin: FastifyPluginAsync = async (fastify) => {
  // onRequest is the earliest hook, so the header is present even if a later plugin rejects
  // the request (401/403/429); every response therefore carries the id (Req 22.10).
  fastify.addHook('onRequest', async (request: FastifyRequest, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });
};

export const requestIdPlugin = fp(plugin, { name: 'request-id' });
