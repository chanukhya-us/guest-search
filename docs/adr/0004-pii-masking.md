# ADR 0004: PII masking with a session-bound reveal store

## Status

Accepted.

## Context

Search results carry guest PII. Two forces pull against each other:

- Colleagues need enough information to identify the right guest, and some need full contact
  details to do their job.
- PII should not be exposed more widely than necessary. If every search response carried full
  phone numbers and emails for every match, a single over-broad search (or a compromised
  browser session) would leak contact details in bulk, and those values would ride along in
  logs, proxies and browser history.

We also must guarantee that masked values can never be reversed client-side and that card data
never appears anywhere.

## Decision

**Mask phone and email by default in every search response**, and release the real values only
through a separate, role-gated, session-bound, short-lived **reveal** exchange:

- Only **phone** and **email** are masked. Names, addresses, Enterprise ID, Loyalty Member ID,
  Member Type and Membership Status are shown in full (Req 14.4).
- Masking is pure and deterministic and never returns the raw value:
  `•••• 1234` for a phone with more than four digits (else `••••`), and `a•••@domain` for an
  email (or `•••@domain` when the local part is one code point or less). The full domain is
  kept; see [../mapping.md](../mapping.md) for the exact rules and the i18n handling.
- Masking runs **after** primary selection, so `pickPrimary` always chooses from real data.
- The unmasked values never travel in the search response. For a principal holding
  `GuestSearch.RevealPII`, the BFF stores them server-side in a `RevealStore` and returns an
  opaque `rt_…` token (`rt_` + base64url of 24 CSPRNG bytes). A Read-only colleague gets no
  token.
- `POST /api/v1/guests/reveal` exchanges a token for exactly one guest's unmasked contacts.
  The store **binds every token to the issuing session** and expires it after a TTL (default
  10 min). Unknown, expired and cross-session tokens are all answered identically as
  `REVEAL_EXPIRED` — no oracle. Logout drops every token for the session.
- The **response parser reads only an allowlist**, so `creditCard`/token elements are never
  parsed, mapped, returned or logged; a log-leak test proves this with a synthetic token.

## Consequences

Easier:

- Search responses are low-sensitivity by default: a leaked response body exposes masked
  contacts only.
- Reveal is role-gated in three independent layers (service issuance, route check, store
  session-binding), so no single failure leaks another session's or another guest's data.
- Full values are bounded in time and scope and never enter logs or browser history.

Harder / accepted:

- Revealing a guest's contacts is a second round-trip, not inline in the results — a
  deliberate usability cost for the privacy gain. Re-reveal within the TTL is allowed so a row
  can be reopened without a new search.
- Server-side reveal state must be stored and swept. In the MVP it is a single-instance
  in-memory map (see [0003](0003-auth-placeholder.md)); a distributed store is the follow-up.
- Masking is intentionally lossy and ASCII-digit-based for phones; non-ASCII digit scripts
  collapse to the fully-masked form. This is the safe-by-default choice and is documented, not
  accidental.

## Related

- [0003](0003-auth-placeholder.md) — the session the reveal token is bound to.
- [../security/threat-model.md](../security/threat-model.md) — PII scraping and token-reuse threats.
- [../mapping.md](../mapping.md) — the exact masking rules and the response allowlist.
