# Threat model: IHG Guest Search

> Version 1.0 · Scope: the local-development MVP (React SPA + Fastify BFF + SOAP adapter).

This is a short, STRIDE-oriented threat model for the MVP. It records the assets we protect,
the trust boundaries data crosses, the threats at each boundary, the mitigations that are
**already implemented in this codebase**, and the residual risks and assumptions we are
accepting for a local MVP. It is honest about what is _not_ a control.

## System overview

- **Architecture:** a React 19 SPA (`apps/web`) that talks only to a same-origin Fastify 5
  BFF (`apps/bff`) over JSON; the BFF calls a legacy SOAP service through a
  `GuestSearchGateway` port and its `SoapGuestSearchGateway` adapter. See
  [ADR 0001](../adr/0001-node-bff.md).
- **Data classification:** guest **PII** (names, phone, email, address, loyalty IDs), reveal
  tokens, and session identifiers. Card data must never be read or stored.
- **Deployment:** local development only. The dev auth provider refuses to run in production.

## Assets

| Asset                     | Why it matters                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| Guest PII                 | Phone, email, address, names, Loyalty Member ID — the data we handle.     |
| Reveal tokens             | Opaque `rt_…` tokens that release one guest's unmasked contacts.          |
| Session                   | Binds requests to a colleague; reveal tokens and rate limits hang off it. |
| Service credential / user | The identity the BFF uses to call SOAP (credential placement is B5/B6).   |
| Audit trail               | Record of who searched and who revealed PII.                              |

## Trust boundaries

| Boundary           | From → To              | Controls at the boundary                                                                                    |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Browser → BFF      | Untrusted client → BFF | Same-origin only; CSRF header + Fetch-Metadata; session cookie; auth/role; rate limits; JSON-only; body cap |
| BFF → SOAP service | BFF → upstream         | Endpoint from config only (no SSRF); timeouts; circuit breaker; response size cap; XXE/DTD-hardened parsing |
| BFF → logs / audit | BFF → log sinks        | pino redaction (remove); path-only request serializer; field-names-only logging; separate audit stream      |

## STRIDE analysis

The mitigations below are implemented in this repository (file references in parentheses).

| STRIDE                            | Threat / scenario                                             | Mitigations (implemented)                                                                                                                                                                                                         | Requirement       |
| --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Spoofing**                      | Forged or tampered session identifying as another colleague   | Signed, `HttpOnly`, `SameSite=Strict`, `__Host-`/`Secure` session cookie; server-side session store with idle (30 min) and absolute (8 h) timeouts (`plugins/session.ts`)                                                         | 20.10             |
| **Tampering**                     | XML injection into the request envelope                       | Envelope built only with `xmlbuilder2` (escaping); ESLint ban on string/template XML in `soap/`; property P1 (`soap/requestMapper.ts`)                                                                                            | 9.1, 9.2          |
| **Tampering**                     | XXE / entity expansion from an upstream or proxy response     | `<!DOCTYPE>`/`<!ENTITY>` rejected before and after parsing; xmldom never resolves external entities; no recovery mode; response size cap (`soap/responseParser.ts`, `soap/transport.ts`)                                          | 11.1, 10.6        |
| **Repudiation**                   | Colleague denies searching for / revealing a guest            | Separate audit stream records `guest.search`/`guest.reveal` with principal id, request id and an HMAC Enterprise-ID hash — never plaintext PII (`services/guestSearchService.ts`, `security/revealStore.ts`)                      | 22.5, 14.10       |
| **Information disclosure**        | Card-token / unknown field leaking through the parser         | Response parser reads only the `ALLOW` allowlist; `creditCard`/token never read; log-leak test with a synthetic token (`soap/contract.ts`, `soap/responseParser.ts`)                                                              | 12.11, 25.6       |
| **Information disclosure**        | PII or secrets leaking into logs                              | pino `redact` with `remove: true` over PII/token/secret paths; path-only request serializer (query stripped); services log criteria **field names** only (`observability/logger.ts`, `services/guestSearchService.ts`)            | 22.3, 22.4        |
| **Information disclosure**        | Error messages leaking internals                              | Error handler returns catalog messages only; detail is logged with the request id, never returned; CSRF failures do not say which check failed (`plugins/errorHandler.ts`, `plugins/csrf.ts`)                                     | 19.3              |
| **Information disclosure**        | Bulk PII in every search response                             | Phone/email masked by default; full values require the reveal role and a short-lived, session-bound token (`security/piiMasker.ts`, `security/revealStore.ts`). See [ADR 0004](../adr/0004-pii-masking.md)                        | 14.1–14.3         |
| **Information disclosure**        | Reveal-token reuse across sessions (IDOR)                     | Tokens are opaque (192-bit CSPRNG), session-bound, TTL'd; unknown/expired/cross-session all answered as `REVEAL_EXPIRED` (no oracle); dropped on logout (`security/revealStore.ts`)                                               | 14.6, 14.9, 20.11 |
| **Denial of service**             | Resource exhaustion from a client or a huge upstream response | Per-session rate limits (search / reveal); JSON body cap (8 KB); 415/413 rejects; response byte cap; connect/response timeouts; circuit breaker (`plugins/rateLimit.ts`, `app.ts`, `soap/transport.ts`, `soap/circuitBreaker.ts`) | 21.6, 10.x        |
| **Denial of service**             | CSRF forcing state-changing requests                          | `SameSite=Strict` cookie; required `X-Requested-With: guest-search`; `Sec-Fetch-Site: cross-site` rejected; JSON-only; no CORS (`plugins/csrf.ts`, `plugins/security.ts`)                                                         | 21.3, 21.4, 6.2   |
| **Denial of service / tampering** | XSS executing injected script                                 | React escaping; strict CSP (`default-src 'self'`, `script-src 'self'`, no inline/third-party script); self-hosted font; `object-src 'none'`; `frame-ancestors 'none'` (`plugins/security.ts`)                                     | 21.1, 21.9        |
| **Spoofing (upstream)**           | SSRF via an attacker-chosen SOAP endpoint                     | SOAP endpoint comes from config only; never from request input (`config.ts`, `soap/transport.ts`)                                                                                                                                 | 2.6               |
| **Elevation of privilege**        | Dev auth mistaken for real authentication in production       | `DevAuthProvider` refuses to start in production (`StartupError`); OIDC seam exists but is not implemented (`plugins/auth.ts`, auth factory)                                                                                      | 20.4              |
| **Elevation of privilege**        | Read-only colleague revealing PII                             | Reveal is role-gated in three layers: service issuance, route `requireRole`, and store session-binding (`services/guestSearchService.ts`, routes, `security/revealStore.ts`)                                                      | 14.5              |
| **Supply chain**                  | Vulnerable / unmaintained XML library pulled in               | CI gate fails the build if `@xmldom/xmldom` resolves below 0.9.12 or `libxmljs2` is present; `npm audit`; exact-pinned deps (`scripts/check-deps.mjs`)                                                                            | 26.2, 26.4        |
| **Supply chain**                  | Secrets committed to git                                      | `.env.example` only; `.env.*` git-ignored; gitleaks secret scan in CI (`.github/workflows/ci.yml`)                                                                                                                                | 1.8, 26.3         |

## Residual risks and assumptions

Stated honestly — these are **not** fully mitigated in the MVP:

- **Dev auth is not a security control.** `DevAuthProvider` trusts configuration, not a real
  credential. It is blocked from production but must never be treated as authentication. Real
  auth (OIDC/SAML) and the SOAP credential mechanism are **Blockers B5/B6**; the service
  credential currently has no emission location and is never sent.
- **The SOAP contract is provisional.** The request side is modeled from a single sample; the
  response side has no sample. An incorrect contract could cause malformed requests or
  mis-parsed responses. Mitigated structurally (allowlist parsing, XXE hardening, total
  parser) but not verified against a schema — the XSD tests are **skipped** until B1. See
  [../mapping.md](../mapping.md).
- **In-memory stores are single-instance.** Sessions and reveal tokens live in process memory,
  so the MVP cannot be horizontally scaled and loses state on restart. A distributed store
  (e.g. Redis) is the planned follow-up (see [ADR 0003](../adr/0003-auth-placeholder.md)).
- **Transport security to the upstream is deployment-dependent.** mTLS material can be
  configured (`SOAP_TLS_*`), but whether TLS/mTLS is enforced depends on the environment and
  the still-open auth mechanism (B5/B6).
- **No formal WCAG conformance.** The automated axe gate catches regressions only; conformance
  needs a manual audit (see [../a11y-manual-checklist.md](../a11y-manual-checklist.md)).
- **`docs/Request.txt` contains sample values** (a service-user id and placeholder channel
  names) from a real environment. It should be redacted/sanitized before wider distribution —
  see [../open-questions.md](../open-questions.md).
- **Synthetic fixtures use realistic-looking PII shapes.** Test fixtures use clearly synthetic
  markers (`@example.test`, `+1 404 555 01xx`, IDs `9000000xx`); any values derived from the
  real sample (a region, a phone, a name) should be reviewed to confirm they are synthetic.

## Related

- [../adr/0002-hand-built-soap-envelope.md](../adr/0002-hand-built-soap-envelope.md) — XML build/parse safety.
- [../adr/0003-auth-placeholder.md](../adr/0003-auth-placeholder.md) — auth and session model.
- [../adr/0004-pii-masking.md](../adr/0004-pii-masking.md) — masking and reveal.
- [../open-questions.md](../open-questions.md) — the open blockers and recommendations.
