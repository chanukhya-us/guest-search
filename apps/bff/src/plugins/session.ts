/**
 * Session plugin (design.md plugin order step 4, Req 20.10).
 *
 * The browser receives one opaque, signed cookie; all session state lives in the
 * injected `SessionStore`. On every request the plugin:
 *   1. reads and unsigns the session cookie (a tampered or unknown ID is ignored);
 *   2. loads the live session (which enforces the idle and absolute timeouts and slides
 *      the idle clock);
 *   3. establishes a fresh session when none is live, binding it to the current Principal
 *      (dev mode creates a session on the first request — design.md "apps/bff — auth");
 *   4. re-sends the cookie so the browser keeps the (possibly rotated) ID.
 *
 * Cookie hardening (Req 20.10):
 *   - `HttpOnly`  — never readable from JavaScript, so XSS cannot exfiltrate the ID.
 *   - `SameSite=Strict` — the cookie is withheld on cross-site requests (CSRF defence,
 *     paired with the `X-Requested-With` check in task 8.5).
 *   - `Path=/`   — scoped to the whole app.
 *   - `Secure` + `__Host-` name prefix — set whenever the configured cookie name carries
 *     the `__Host-` prefix. The prefix is a browser-enforced contract: the cookie must be
 *     `Secure`, `Path=/`, and carry no `Domain`. Plain-HTTP localhost dev uses the bare
 *     `gs_session` name and omits `Secure` so the cookie still works without TLS; the
 *     config layer (`AppConfig.session.cookieName`) chooses which name applies.
 *   - signed — the value is HMAC-signed with the session secret via `@fastify/cookie`, so
 *     a client cannot forge or tamper with a session ID.
 *
 * The plugin decorates `request.session` with the live `SessionRecord` and exposes
 * `request.destroySession(reply)` for the logout route (task 8.6), which clears the store
 * entry and expires the cookie.
 */
import cookie from '@fastify/cookie';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Principal } from '../auth/authProvider.js';
import type { SessionRecord, SessionStore } from '../auth/sessionStore.js';

export interface SessionPluginOptions {
  /** Secret used by `@fastify/cookie` to sign and verify the session ID. */
  secret: string;
  /** Cookie name; its `__Host-` prefix (or absence) decides whether `Secure` is set. */
  cookieName: string;
  /** Server-side session store (memory locally; Redis later). */
  store: SessionStore;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The live session for this request, established by the session plugin. */
    session: SessionRecord;
    /** Remove the session from the store and clear its cookie (logout, task 8.6). */
    destroySession(reply: FastifyReply): void;
  }
}

/** `__Host-` cookies are only valid when `Secure`, `Path=/`, and `Domain` is absent. */
export function isHostPrefixed(cookieName: string): boolean {
  return cookieName.startsWith('__Host-');
}

const plugin: FastifyPluginAsync<SessionPluginOptions> = async (fastify, opts) => {
  const { secret, cookieName, store } = opts;
  const secure = isHostPrefixed(cookieName);

  // Shared attributes for both set and clear so the browser matches the cookie on removal.
  // `__Host-` forbids a Domain, so Domain is never set (the absence is deliberate).
  const setOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure,
    signed: true,
  } as const;
  const clearOptions = { path: '/', httpOnly: true, sameSite: 'strict', secure } as const;

  if (!fastify.hasRequestDecorator('cookies')) {
    await fastify.register(cookie, { secret });
  }

  // Declared without a value: the onRequest hook sets it before any route runs, so the
  // non-null `request.session` type holds in handlers. `destroySession` guards the init
  // window with a nullable cast.
  fastify.decorateRequest('session');
  fastify.decorateRequest(
    'destroySession',
    function destroySession(this: FastifyRequest, reply: FastifyReply): void {
      const current = this.session as SessionRecord | null | undefined;
      if (current !== null && current !== undefined) store.destroy(current.id);
      reply.clearCookie(cookieName, clearOptions);
    },
  );

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = resolveSession(request, store, cookieName);
    request.session = session;
    reply.setCookie(cookieName, session.id, setOptions);
  });
};

/**
 * Load the live session named by the request cookie, or create one bound to the current
 * Principal. A missing, malformed, tampered, or expired cookie all fall through to a new
 * session. The Principal is set by the auth plugin (task 8.5); until then we fall back to
 * an `anonymous` binding so the plugin is independently testable.
 */
function resolveSession(
  request: FastifyRequest,
  store: SessionStore,
  cookieName: string,
): SessionRecord {
  const raw = request.cookies[cookieName];
  if (raw !== undefined) {
    const unsigned = request.unsignCookie(raw);
    if (unsigned.valid && unsigned.value !== null) {
      const existing = store.get(unsigned.value);
      if (existing !== null) return existing;
    }
  }
  const principal: Principal | null = request.principal;
  return store.create(principal?.id ?? 'anonymous');
}

export const sessionPlugin = fp(plugin, { name: 'session' });
