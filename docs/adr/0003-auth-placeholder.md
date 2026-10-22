# ADR 0003: Placeholder dev auth and in-memory sessions

## Status

Accepted for the local MVP. Superseded before any non-local use (Blockers B5/B6).

## Context

The tool is role-gated — searching requires `GuestSearch.Read` and revealing PII requires
`GuestSearch.RevealPII` — and it needs a session to bind reveal tokens to and to rate-limit
per colleague. But:

- The **enterprise identity provider and auth mechanism are undecided** (Blockers B5/B6:
  OIDC vs SAML; where the service credential sits; WS-Security vs mTLS vs Basic for the SOAP
  call). Committing to one now would be a guess we would likely rip out.
- The MVP is **local-only**. We need something that lets a developer exercise every role
  combination immediately, without standing up an IdP.
- A multi-instance session/token store (Redis, etc.) is operational weight the local MVP does
  not need and cannot assume is available.

## Decision

Ship a **pluggable auth provider with a development-only implementation**, and keep session
and reveal state **in memory**, behind interfaces that a real implementation can replace
without touching callers:

- `AuthProvider` interface with `DevAuthProvider`. `createAuthProvider(cfg)`:
  - `dev` mode selects one of three synthetic personas via `DEV_AUTH_PERSONA`
    (`jane.doe` = read + reveal, `read.only` = read only, `no.access` = no roles). IDs and
    names are synthetic placeholders.
  - `dev` mode **refuses to start in production** (`StartupError`).
  - `oidc` mode throws `StartupError('OIDC provider not implemented')` — the seam exists, the
    implementation is deferred to B5/B6.
- `requireRole(role)` preHandler returns `FORBIDDEN` when the principal lacks the role.
- Sessions: `SessionStore` interface with `MemorySessionStore` (idle 30 min, absolute 8 h),
  carried in one signed, hardened cookie (`__Host-` + `Secure` + `HttpOnly` +
  `SameSite=Strict` outside plain-HTTP localhost; bare `gs_session` without `Secure` for
  localhost dev).
- Reveal tokens: `RevealStore` interface with `MemoryRevealStore` (session-bound, TTL'd).

The service credential for the SOAP call has **no emission location** yet
(`HEADER_CREDENTIAL_LOCATION = null`), so it is never put on the wire (B5/B6).

## Consequences

Easier:

- A developer can try read-and-reveal, read-only and no-access instantly by changing one env
  var, with no IdP.
- The cookie, session and reveal-token hardening are real and tested now, independent of the
  future IdP.
- Swapping in a real `AuthProvider`, `SessionStore` or `RevealStore` is a contained change
  behind the existing interfaces; an ADR-named Redis-backed store is the planned follow-up for
  the memory stores.

Harder / accepted — stated honestly:

- **`DevAuthProvider` is not a security control.** It trusts configuration, not a real
  credential. The build refuses to run it in production, but it must never be mistaken for
  authentication.
- **In-memory stores are single-instance.** Sessions and reveal tokens are lost on restart and
  are not shared across instances, so the MVP cannot be horizontally scaled as-is. This is a
  documented production limitation; a distributed store replaces them.
- The real auth mechanism and credential placement remain **blocked on B5/B6** and will be
  decided in a follow-up ADR.

## Related

- [0004](0004-pii-masking.md) — the reveal store this session binding protects.
- [../security/threat-model.md](../security/threat-model.md) — session, CSRF and token threats.
- [../open-questions.md](../open-questions.md) — B5/B6 and the single-instance limitation.
