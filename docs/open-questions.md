# Open questions and blockers

> The consolidated list of what is unresolved, what placeholder stands in for it today, and
> what is needed to close it. Drawn from the project blueprint (§20) and the design's open
> items.

The MVP is a **provisional-contract** build. The SOAP request side is modeled from a single
sample ([`Request.txt`](Request.txt)); the response side and several other items are blocked
pending the real contract. Until then the contract stays `verified: false` where unconfirmed,
the address feature flags stay off, the field limits are placeholders, and the XSD tests are
skipped. See [mapping.md](mapping.md) for the field-level status.

## Blockers

### B1 — WSDL / XSD schemas

- **Blocked:** element order, cardinality, types, and per-field length limits; XSD-level
  validation of the request envelope.
- **Placeholder today:** identities inferred from the sample; `defaultLimits` in
  `packages/shared/src/criteria.ts` carry a `TODO(B1)`; the XSD tests in `apps/bff/test/xsd/`
  are skipped with an explicit "schemas not supplied" message.
- **Needed to resolve:** the WSDL and all imported XSDs placed in `schemas/`. Then verify each
  `EL` entry per the procedure in the `contract.ts` header comment, flip `verified: true`,
  update `ORDER`, replace the placeholder limits, and let the XSD tests run.

### B2 — SOAP response shape and header element names

- **Blocked:** the response structure (`searchGuestResponse`, `transactionStatus` placement,
  `initiateGuest` children) and the exact response header element names.
- **Placeholder today:** every `guest*` identity mirrors the request sample and stays
  `verified: false`; the parser locates `transactionStatus` anywhere under
  `searchGuestResponse` that is not inside an `initiateGuest`; all response fixtures are
  synthetic, generated to that placement.
- **Needed to resolve:** a sanitized real response sample and/or the response XSD. Then confirm
  the `guest*` entries and the status placement, and update [mapping.md](mapping.md).
- **Request-side note:** B2 for the _request_ is resolved from the sample — the in-body
  `header` (no `soap:Header`), the criteria groups and the namespace layout all match
  `Request.txt`.

### B3 — mapping confirmation (`line1`, `locality1`, `postalCode`; Address Line 2)

- **Blocked:** whether `line1`, `locality1` and `postalCode` are valid request elements and
  where they sit; whether Address Line 2 maps to anything.
- **Placeholder today:** these three fields are emitted only when their feature flag
  (`SOAP_FEATURE_ADDRESS_LINE1` / `_CITY` / `_POSTAL_CODE`) is on — all **off** by default;
  their `EL` entries are `verified: false`. **Address Line 2 is never read or mapped** (it is
  never invented from a guess) and the UI disables the field.
- **Needed to resolve:** XSD confirmation of the address source elements. Then turn on the
  flags and mark the mapping Confirmed; decide explicitly whether Address Line 2 has a home.

### B4 — Member Type code set

- **Blocked:** the real set of loyalty Member Type codes and labels.
- **Placeholder today:** `UI_MEMBER_TYPES` is a synthetic placeholder list (labelled
  "(placeholder)"); the schema validates `memberType` against whatever set is configured.
- **Needed to resolve:** the authoritative code/label set, loaded via `UI_MEMBER_TYPES`.

### B5 / B6 — service user/credential placement and auth mechanism

- **Blocked:** where the service credential goes in the request, and the mechanism
  (WS-Security vs Basic vs mTLS); the colleague-facing auth mechanism (OIDC vs SAML).
- **Placeholder today:** the **service user** is resolved — it goes in `header/user/@id` from
  config via `SecretProvider` (the sample's location). The **credential** is never emitted:
  `HEADER_CREDENTIAL_LOCATION = null`, so `SOAP_SERVICE_CREDENTIAL` is read but attached
  nowhere. For colleague auth, `AUTH_MODE=dev` uses `DevAuthProvider`; `oidc` throws
  `StartupError('OIDC provider not implemented')`.
- **Needed to resolve:** the credential location and transport decision (sets
  `HEADER_CREDENTIAL_LOCATION` and/or TLS/mTLS config), and the IdP choice to implement the
  OIDC provider. See [adr/0003-auth-placeholder.md](adr/0003-auth-placeholder.md).

### B8 — official IHG logo

- **Blocked:** the official brand logo asset.
- **Placeholder today:** `BrandLogo` loads `/brand/ihg-logo.svg` and falls back to a text
  wordmark when it is absent or fails to load.
- **Needed to resolve:** the approved logo file dropped at the expected path.

> B7 is intentionally absent from this list — the blueprint's blocker numbering skips it.

## Other open questions

### Multiple `name` elements per guest

A guest may carry more than one `name` element. The parser currently uses the **first** and
ignores the rest. **Needed:** XSD/sample confirmation of whether multiple names can appear and,
if so, how to choose or present them.

### Blank-group omission vs the sample

The mapper **omits** blank criteria groups and attributes, whereas the sample sends an empty
`email/address` and `membership/@value=""`. `sampleRequest.test.ts` allows exactly these two
differences. **Needed:** confirm with the service team that omission is accepted.

### Transaction success rule

Success is currently `transactionSuccessful="true"` **and** `overallStatusCode="0000"`.
**Needed:** confirm against the XSD/samples whether other status codes represent
success-with-warning.

### Sample ambiguities in `Request.txt`

1. `user id="DOMAIN\\user"` (redacted) sits in a single-quoted shell string, so the wire value may be one
   or two backslashes; it is treated as one (`DOMAIN\user`).
2. The sample's transaction ID is `<ip>-<UUID upper-case>`; ours is the lower-case `requestId`
   UUID.
3. The sample's `Content-Type` is `text/xml` with no charset; ours adds `charset=utf-8`.
4. Address `source` child order is confirmed only for `region1` before `country`.

### undici / Node engines

The SOAP transport uses undici 7.x's own `fetch` + `Agent` (Node's bundled fetch rejects an
Agent from a different undici major). undici 8 would require Node ≥ 22.19, but `engines.node`
is ≥ 22.15. **Revisit** the undici pin if the Node floor is raised.

## Recommendations before wider distribution

- **`docs/Request.txt` is git-ignored.** It contains values from a real environment (a personal
  domain account, channel/subchannel names, an environment name, an internal host/IP in the
  transaction ID), so it stays local only. Keep real values in a secret store, never in git.
- **Review the sample-derived fixture values.** Test fixtures are synthetic by convention
  (`@example.test`, `+1 404 555 01xx`, IDs `9000000xx`). Confirm that any value seeded from the
  real sample — a name, a phone, a region — has been replaced with a synthetic equivalent, so
  no real PII is committed in `samples/` or `tests/fixtures`.

## Related

- [mapping.md](mapping.md) — field-level verification status.
- [security/threat-model.md](security/threat-model.md) — residual risks tied to these items.
- [adr/](adr/) — the decisions taken under these constraints.
