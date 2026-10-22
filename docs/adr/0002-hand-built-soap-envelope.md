# ADR 0002: Hand-built SOAP envelope from a provisional contract

## Status

Accepted. Parts are revisited when the WSDL/XSD arrive (Blockers B1–B3).

## Context

We must call a SOAP service, but:

- **There is no WSDL/XSD yet** (Blocker B1). The only evidence of the request shape is one
  sample `curl` command the team provided, [`docs/Request.txt`](../Request.txt). There is no
  response sample at all (Blocker B2).
- SOAP tooling that generates a client from a WSDL cannot run without that WSDL. Even if it
  could, a generated client against a guessed contract would bake the guess into generated
  code that is awkward to correct.
- String-concatenated or templated XML is a well-known injection and correctness hazard
  (namespace prefixes, escaping, `]]>`, non-BMP characters). Prefix-based XML parsers hide
  real identity behind aliases like `ns2`/`ns4` that can change between environments.
- The contract will change once the schemas arrive, so the cost of that change must be
  contained to as few files as possible.

## Decision

Build and parse the SOAP envelope **by hand**, against a single, explicitly provisional
contract module, with a strict, security-first toolset:

- **One contract module** ([`contract.ts`](../../apps/bff/src/soap/contract.ts)) holds every
  namespace URI, element identity (`EL`), child order (`ORDER`), fixed value (`DEFAULTS`),
  success code (`SUCCESS`) and the response allowlist (`ALLOW`). Nothing else in the BFF may
  contain a namespace URI or status literal (enforced by a test).
- **Provisional-by-default.** Each `EL` entry carries `verified: false` until checked against
  the XSD. Entries present in the sample are `verified: true` with
  `xsd: 'sample:docs/Request.txt'`; everything on the response side stays `verified: false`.
  Address fields not in the sample (`line1`, `locality1`, `postalCode`) stay unverified and
  behind feature flags.
- **Build only with `xmlbuilder2`** (`ele(nsUri, qname)`, `.att()`, `.txt()`), which escapes
  every value. An ESLint rule bans template literals and string concatenation containing `<`
  in `soap/`.
- **Parse only with `@xmldom/xmldom` + namespace-aware navigation**, matching on namespace URI
  plus local name, never on a prefix. `<!DOCTYPE>`/`<!ENTITY>` are rejected before parsing and
  again after; there is no recovery mode; the parser is total (any input yields domain results
  or a typed `SoapError`).
- **Read only the allowlist.** The parser never reads an element outside `ALLOW`, so unknown
  children such as `creditCard` are never touched.

## Consequences

Easier:

- We can build, test and demo the whole system now, against synthetic fixtures and a local
  mock, without waiting for the schemas.
- Correcting the contract later is a contained, single-layer change: update `contract.ts`,
  flip the address flags, and run the (currently skipped) XSD tests.
- Injection and XXE classes are closed by construction, not by review.
- The `verified` flags make the provisional surface explicit and auditable.

Harder / accepted:

- The contract is a **best guess** for everything not in the sample; the mapping is not
  confirmed (see [../mapping.md](../mapping.md) and [../open-questions.md](../open-questions.md)).
- Hand-built mapping code must be maintained and tested carefully (it is, with unit, property
  and snapshot tests), rather than delegated to a generator.
- The XSD validation tests are **skipped** until `schemas/` is populated, so XSD-level
  correctness is unverified for now.
- The mapper deliberately **omits blank criteria groups**, unlike the sample (which sends an
  empty email/address and `membership/@value=""`). This deviation is documented and must be
  confirmed with the service team.

## Related

- [../mapping.md](../mapping.md) — the full field mapping and its verification status.
- [../open-questions.md](../open-questions.md) — B1–B3 and the specific sample ambiguities.
