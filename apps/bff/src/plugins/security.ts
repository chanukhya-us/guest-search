/**
 * Security-headers plugin (design.md plugin order step 2; Req 21.1).
 *
 * Wraps `@fastify/helmet` with the exact header policy the requirements pin. The whole app is
 * one same-origin SPA that talks only to its own `/api` and `/health`, so the policy is a
 * strict allow-list: everything defaults to `'self'`, nothing third-party, no framing, no
 * plugins, no base-tag hijacking.
 *
 * ## Content-Security-Policy (Req 21.1)
 * Helmet's defaults are deliberately overridden with `useDefaults: false` so the emitted
 * policy is exactly the set below and nothing is silently added or dropped by a helmet upgrade:
 *   - `default-src 'self'`     — the backstop every unlisted fetch falls back to.
 *   - `script-src 'self'`      — only our own bundle runs; no inline or third-party script, so a
 *     single reflected/stored XSS has no way to execute injected code (appsec: CSP is the net
 *     under the XSS bugs we have not found). The Vite build emits external `<script src>` only,
 *     so no nonce or `'unsafe-inline'` is needed.
 *   - `style-src 'self'`       — stylesheets come from our bundle. Tailwind compiles to a static
 *     sheet, so no inline-style allowance is required.
 *   - `img-src 'self' data:`   — the brand logo and app images are same-origin; `data:` admits
 *     the small inline SVG/data-URI icons the UI uses. No remote image origins.
 *   - `font-src 'self'`        — Inter is self-hosted via `@fontsource-variable/inter` (Req 21.9);
 *     no third-party font origin is allowed.
 *   - `connect-src 'self'`     — XHR/fetch/WebSocket may reach only the same origin (the BFF API).
 *   - `object-src 'none'`      — no `<object>/<embed>/<applet>`; kills legacy plugin vectors.
 *   - `base-uri 'self'`        — a `<base>` tag cannot be injected to re-root relative URLs.
 *   - `frame-ancestors 'none'` — the app may not be framed; clickjacking defence and the modern
 *     replacement for `X-Frame-Options` (helmet still sends `X-Frame-Options: DENY` too).
 *   - `form-action 'self'`     — forms may only post back to our origin.
 *
 * ## Other headers
 *   - `Referrer-Policy: no-referrer` (Req 21.1) — never leak the current URL to any navigation
 *     target; search URLs must not travel in a Referer header.
 *   - `X-Content-Type-Options: nosniff` (Req 21.1) — browsers honour our declared content types.
 *   - `Strict-Transport-Security` — production only (Req 21.1). On plain-HTTP localhost dev an
 *     HSTS header would wrongly pin the developer's browser to HTTPS, so it is omitted unless
 *     `NODE_ENV === 'production'`.
 *   - Cross-Origin-Resource-Policy `same-origin` — resources are not readable cross-origin.
 *
 * ## Deliberately NOT set here
 *   - CORS — the API and UI share one origin and CORS is never enabled (Req 21.5); `@fastify/cors`
 *     is not registered anywhere, so no `Access-Control-*` headers are emitted.
 *   - `Cache-Control` — owned by the `noStore` plugin (step 3) for `/api/*`.
 */
import helmet from '@fastify/helmet';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export interface SecurityPluginOptions {
  /** Emit `Strict-Transport-Security` only in production (Req 21.1). */
  readonly production: boolean;
}

/**
 * The exact CSP directive set (Req 21.1). Exported so tests assert the serialized policy
 * against the single source of truth rather than a copied string.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
};

const plugin: FastifyPluginAsync<SecurityPluginOptions> = async (fastify, opts) => {
  await fastify.register(helmet, {
    // Emit exactly CSP_DIRECTIVES, with no helmet-managed defaults layered underneath.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { ...CSP_DIRECTIVES } as Record<string, string[]>,
    },
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true,
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // HSTS only over TLS in production; harmful if pinned on plain-HTTP localhost dev.
    hsts: opts.production ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });
};

export const securityPlugin = fp(plugin, { name: 'security' });
