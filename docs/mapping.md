# Field mapping: UI criteria ↔ SOAP ↔ domain

> How a search travels from the 12 UI criteria fields, into the `searchGuestRequest` SOAP
> envelope, back out of the `searchGuestResponse`, and into the normalized JSON the browser
> renders.

This document is the human-readable companion to the machine source of truth,
[`apps/bff/src/soap/contract.ts`](../apps/bff/src/soap/contract.ts). The contract module is
the **only** place namespace URIs, fixed attribute values and status codes live; the request
mapper, header builder and response parser read every element identity from its `EL` table.
When this document and the code disagree, the code wins — fix this file.

## Verification status

The contract is **partly verified** (Req 7.5). There are two independent sides:

- **Request side** — modeled from the team's single sample request,
  [`docs/Request.txt`](Request.txt) (a `curl` command). Every element that appears in that
  sample is marked `verified: true` in the contract with
  `xsd: 'sample:docs/Request.txt'`.
- **Response side** — there is **no** response sample. Every `guest*` identity mirrors the
  request sample's placement and stays `verified: false` until the WSDL/XSD or a real
  response arrives.

Each row below carries a status:

| Status           | Meaning                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| **Confirmed**    | Present in `docs/Request.txt`; `EL` entry is `verified: true`.                                        |
| **Provisional**  | Placement inferred, not confirmed by a sample or the XSD; `EL` entry `verified: false`.               |
| **Blocked (Bn)** | Cannot be finalized until the named blocker is resolved (see [open-questions.md](open-questions.md)). |

The blockers referenced here:

- **B1** — WSDL + XSD schemas (element order, cardinality, types, field length limits).
- **B2** — the SOAP response shape and the response header element names.
- **B3** — request validity of `line1`, `locality1`, `postalCode`, and confirmation of the
  whole mapping.

## Namespaces

From `contract.ts` `NS` / `PREFIX`. Prefixes are the build-time aliases from the sample; the
parser never matches on a prefix, only on the namespace URI plus local name (Req 11.4).

| Key        | Build prefix | Namespace URI                                               |
| ---------- | ------------ | ----------------------------------------------------------- |
| `soap`     | `soap`       | `http://schemas.xmlsoap.org/soap/envelope/`                 |
| `common`   | _(default)_  | `http://atp.ihg.com/schema/common/ATPCommonServiceTypes/v1` |
| `initiate` | `ns2`        | `http://crm.ihg.com/schema/v1_0/initiate`                   |
| `complex`  | `ns3`        | `http://common.crm.ihg.com/schema/v1_0/complex`             |
| `svc`      | `ns4`        | `http://atp.ihg.com/schema/crs/initiate/servicetypes/v1`    |
| `basic`    | `ns5`        | `http://common.crm.ihg.com/schema/v1_0/basictypes`          |

## 1. UI criteria → SOAP request

The 12 criteria are listed in UI order (`CRITERIA_FIELDS` in
[`packages/shared/src/criteria.ts`](../packages/shared/src/criteria.ts)). The request mapper
([`requestMapper.ts`](../apps/bff/src/soap/requestMapper.ts)) builds criteria groups in the
fixed `ORDER.searchCriteria` order — `name`, `phone`, `email`, `address`, `membership` — and
**omits any group whose inputs are all blank** (Req 9.7–9.11). This is a deliberate deviation
from the sample, which sends an empty `email/address` and `membership/@value=""`; the mapper
follows `copilot-instructions.md` §5 and omits blanks (see
[open-questions.md](open-questions.md)).

All criteria sit under `ns4:searchCriteria status="O"` (`DEFAULTS.criteriaStatus`).

| #   | UI field          | Request element (ns:local)      | Path from `searchCriteria`                  | Fixed attributes / defaults                            | Status           |
| --- | ----------------- | ------------------------------- | ------------------------------------------- | ------------------------------------------------------ | ---------------- |
| 1   | `firstName`       | `ns3:given` (text)              | `ns2:name > ns3:given`                      | —                                                      | Confirmed        |
| 2   | `lastName`        | `ns3:surname` (text)            | `ns2:name > ns3:surname`                    | —                                                      | Confirmed        |
| 3   | `email`           | `ns2:address` (text)            | `ns2:email > ns2:address`                   | `ns2:email/@profileDefault="true"`                     | Confirmed        |
| 4   | `phone`           | `ns2:phone` (attr `number`)     | `ns2:phone/@number`                         | `@location="H"`, `@profileDefault="true"`              | Confirmed        |
| 5   | `loyaltyMemberId` | `ns2:membership` (attr `value`) | `ns2:membership/@value`                     | shares the element with `memberType`                   | Confirmed        |
| 6   | `memberType`      | `ns2:membership` (attr `code`)  | `ns2:membership/@code`                      | shares the element with `loyaltyMemberId`              | Confirmed        |
| 7   | `country`         | `ns3:country` (text)            | `ns2:address > ns3:source > ns3:country`    | address: `@locationCode="H"`, `@profileDefault="true"` | Confirmed        |
| 8   | `stateOrRegion`   | `ns3:region1` (text)            | `ns2:address > ns3:source > ns3:region1`    | (same address attributes)                              | Confirmed        |
| 9   | `addressLine1`    | `ns3:line1` (text)              | `ns2:address > ns3:source > ns3:line1`      | emitted only if `SOAP_FEATURE_ADDRESS_LINE1` is on     | Provisional — B3 |
| 10  | `addressLine2`    | _never emitted_                 | —                                           | **Never read or mapped** (Req 9.6)                     | Blocked — B3     |
| 11  | `city`            | `ns3:locality1` (text)          | `ns2:address > ns3:source > ns3:locality1`  | emitted only if `SOAP_FEATURE_CITY` is on              | Provisional — B3 |
| 12  | `postalCode`      | `ns3:postalCode` (text)         | `ns2:address > ns3:source > ns3:postalCode` | emitted only if `SOAP_FEATURE_POSTAL_CODE` is on       | Provisional — B3 |

Notes:

- `ns2:name`, `ns2:phone`, `ns2:email`, `ns2:address` and `ns2:membership` are the group
  elements; they appear only when at least one of their inputs is present.
- The address group element is created only when at least one emitted source child is present.
  Flag-disabled fields (`line1`, `locality1`, `postalCode`) drop out when their feature flag
  is off, so a disabled field alone never creates an `ns2:address`.
- **Address Line 2** is never read, even defensively, because no XSD element has been
  confirmed for it (Req 9.6). The UI disables the field.
- `stateOrRegion` and `country` are not feature-flagged: they appear in the sample, so they
  are always eligible.

### Fixed request values (`DEFAULTS`)

From `contract.ts` `DEFAULTS`, all confirmed by the sample unless noted:

| Element / attribute               | Value                                        |
| --------------------------------- | -------------------------------------------- |
| `ns4:searchCriteria/@status`      | `O`                                          |
| `ns2:phone/@location`             | `H`                                          |
| `ns2:phone/@profileDefault`       | `true`                                       |
| `ns2:email/@profileDefault`       | `true`                                       |
| `ns2:address/@locationCode`       | `H`                                          |
| `ns2:address/@profileDefault`     | `true`                                       |
| `ns4:allAttributes` (text)        | `true`                                       |
| `ns4:allHistory` (text)           | `false`                                      |
| `headerVersion/@major` / `@minor` | `1` / `0`                                    |
| `ns4:maxResults` (text)           | from config `SOAP_MAX_RESULTS`, default `50` |

### Request header

The `header` element is the first child of `searchGuestRequest` (there is **no** `soap:Header`),
every element is in `common` (the default namespace), and every value is an attribute except
`sendTimeStamp`, which is text. Built by
[`headerBuilder.ts`](../apps/bff/src/soap/headerBuilder.ts). The colleague never supplies or
sees any header value (Req 6.7, 8.x).

| Header element (common ns)    | Value source                                                                         | Status                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `language/@isoCountryCode`    | `SOAP_HEADER_COUNTRY_CODE`                                                           | Confirmed                                       |
| `language/@isoLanguageCode`   | `SOAP_HEADER_LANGUAGE_CODE`                                                          | Confirmed                                       |
| `channel/@name`               | `SOAP_HEADER_CHANNEL`                                                                | Confirmed                                       |
| `subChannel/@name` (nested)   | `SOAP_HEADER_SUB_CHANNEL` (comma list, outermost first, each nested in the previous) | Confirmed                                       |
| `headerVersion/@major/@minor` | `DEFAULTS` (`1` / `0`)                                                               | Confirmed                                       |
| `environment/@name`           | `SOAP_HEADER_ENVIRONMENT`                                                            | Confirmed                                       |
| `user/@id`                    | `SOAP_HEADER_SERVICE_USER` (via `SecretProvider`)                                    | Confirmed — B5/B6 resolved for the service user |
| `transactionId/@id`           | the request ID (equals the upstream transaction ID)                                  | Confirmed                                       |
| `transactionSequence/@number` | `SOAP_HEADER_SEQUENCE`, default `1`                                                  | Confirmed                                       |
| `sendTimeStamp` (text)        | injected clock, ISO 8601 UTC at send time                                            | Confirmed                                       |

**Service credential.** `HEADER_CREDENTIAL_LOCATION` is `null`, so the credential is never
emitted — the contract defines no location for it yet (Blockers B5/B6). `SOAP_SERVICE_CREDENTIAL`
is read into config but attached nowhere.

### HTTP transport headers

Set by [`transport.ts`](../apps/bff/src/soap/transport.ts) / config:

| HTTP header     | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| `Content-Type`  | `text/xml; charset=utf-8`                                              |
| `SOAPAction`    | `SOAP_ACTION`, default `searchGuest` (sent unquoted, as in the sample) |
| `IHG-ChannelId` | `SOAP_CHANNEL_ID`, default `WEBWB`                                     |

## 2. SOAP response → domain

The parser ([`responseParser.ts`](../apps/bff/src/soap/responseParser.ts)) walks
`Envelope > Body > searchGuestResponse`, interprets `transactionStatus`, then maps **every**
`ns2:initiateGuest` into a `GuestSearchResult`
([`packages/shared/src/domain.ts`](../packages/shared/src/domain.ts)). The response side has
no sample: **every row below is Provisional — B2** until the WSDL/XSD or a real response
confirms it.

### Envelope / status navigation

| Step | Element (ns:local)           | On failure                                                            |
| ---- | ---------------------------- | --------------------------------------------------------------------- |
| 1    | `soap:Envelope > soap:Body`  | missing `Body` → `UPSTREAM_CONTRACT`                                  |
| 2    | `soap:Fault` (if present)    | → `UPSTREAM_FAULT` (logs `faultcode` only)                            |
| 3    | `ns4:searchGuestResponse`    | missing → `UPSTREAM_CONTRACT`                                         |
| 4    | `transactionStatus` (common) | missing → `UPSTREAM_CONTRACT`; not successful → `UPSTREAM_TXN_FAILED` |
| 5    | each `ns2:initiateGuest`     | mapped to one `GuestSearchResult`                                     |

**Transaction success** requires both `@transactionSuccessful="true"` **and**
`@overallStatusCode="0000"` (`SUCCESS` in the contract). `transactionStatus` is located as the
first descendant under `searchGuestResponse` that is **not** inside an `initiateGuest`, so guest
content (and any card data) is never walked while finding it.

### Guest allowlist (`ALLOW`)

The parser reads **only** these attributes and child elements; anything else (e.g.
`creditCard`) is never read, mapped, returned or logged (Req 12.10, 12.11):

| Group                 | Allowed attributes / children                                     |
| --------------------- | ----------------------------------------------------------------- |
| guest attributes      | `score`, `status`, `gender`                                       |
| guest children        | `enterpriseId`, `name`, `address`, `phone`, `email`, `membership` |
| phone attributes      | `number`, `type`, `location`, `profileDefault`                    |
| email attributes      | `profileDefault`                                                  |
| address attributes    | `locationCode`, `profileDefault`                                  |
| membership attributes | `code`, `value`, `status`                                         |

### `initiateGuest` → `GuestSearchResult`

| Domain field                                                | Response source (ns:local)             | Notes                                                 | Status           |
| ----------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- | ---------------- |
| `enterpriseId`                                              | `ns2:enterpriseId` (text)              | empty text becomes `''`                               | Provisional — B2 |
| `score`                                                     | `initiateGuest/@score`                 | parsed as a finite decimal, else undefined (Req 12.8) | Provisional — B2 |
| `status`                                                    | `initiateGuest/@status`                | —                                                     | Provisional — B2 |
| `gender`                                                    | `initiateGuest/@gender`                | —                                                     | Provisional — B2 |
| `firstName`                                                 | `ns2:name > ns3:given` (text)          | first `name` element only (see note)                  | Provisional — B2 |
| `lastName`                                                  | `ns2:name > ns3:surname` (text)        | first `name` element only                             | Provisional — B2 |
| `addresses[]`                                               | each `ns2:address`                     | repeating → array, no dedupe                          | Provisional — B2 |
| &nbsp;&nbsp;`.line1`                                        | `ns2:address > ns3:source > ns3:line1` | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.city`                                         | `ns3:locality1`                        | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.stateOrRegion`                                | `ns3:region1`                          | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.postalCode`                                   | `ns3:postalCode`                       | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.country`                                      | `ns3:country`                          | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.locationCode`                                 | `ns2:address/@locationCode`            | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.profileDefault`                               | `ns2:address/@profileDefault`          | parsed `"true"`/`"false"` → boolean                   | Provisional — B2 |
| `phones[]`                                                  | each `ns2:phone`                       | a phone without `@number` is **skipped** (Req 12.9)   | Provisional — B2 |
| &nbsp;&nbsp;`.number`/`.type`/`.location`/`.profileDefault` | phone attributes                       | —                                                     | Provisional — B2 |
| `emails[]`                                                  | each `ns2:email > ns2:address`         | an email without `address` text is **skipped**        | Provisional — B2 |
| &nbsp;&nbsp;`.profileDefault`                               | `ns2:email/@profileDefault`            | —                                                     | Provisional — B2 |
| `memberships[]`                                             | each `ns2:membership`                  | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.memberType`                                   | `ns2:membership/@code`                 | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.memberId`                                     | `ns2:membership/@value`                | —                                                     | Provisional — B2 |
| &nbsp;&nbsp;`.status`                                       | `ns2:membership/@status`               | —                                                     | Provisional — B2 |

Notes:

- Every attribute and text value is trimmed; an empty value becomes `undefined` (Req 12.9).
  Absent optional fields are dropped from the object, not set to `null`.
- **Multiple `name` elements:** a guest may in theory carry more than one `name`. The parser
  uses the first and ignores the rest, pending XSD confirmation (open question — see
  [open-questions.md](open-questions.md)).
- **No `creditCard`/token** appears anywhere in the allowlist, so it is never parsed. A
  log-leak test (task 10.3) proves a synthetic card token in the response never reaches a log.

## 3. Domain → API response (primaries & masking)

[`guestSearchService.ts`](../apps/bff/src/services/guestSearchService.ts) turns each
`GuestSearchResult` into a `GuestSummary` for the browser.

### Primary selection

`pickPrimary` ([`packages/shared/src/primary.ts`](../packages/shared/src/primary.ts)) chooses,
for each collection, the **first item with `profileDefault === true`**, otherwise the first
item, otherwise `undefined` (Req 13). Primaries are computed on the **unmasked** data, before
masking, so the choice is never influenced by masking. The same function is shared with the UI
drawer so labels agree.

### Masking (`piiMasker.ts`)

Only **phone** and **email** values are masked. Names, addresses, Enterprise ID, Loyalty
Member ID, Member Type and Membership Status are never masked (Req 14.4).

| Value | Rule                                                                                                       | Example                                       |
| ----- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| phone | `digits = value.replace(/\D/g, '')`; `digits.length > 4` → `•••• 1234`; otherwise → `••••`                 | `+1 404 555 0142` → `•••• 0142`               |
| email | split on the last `@`; local length > 1 → `a•••@domain`; local length ≤ 1 or no `@` → `•••@domain` / `•••` | `jane.doe@example.test` → `j•••@example.test` |

The masker is pure and deterministic, never returns the raw value, counts phone digits with
the ASCII `\D` class (non-ASCII digit scripts collapse to `••••`), and takes the email's first
local code point by Unicode code point (never mid-surrogate). The full domain is emitted
verbatim.

### Reveal

For a principal holding `GuestSearch.RevealPII`, the service stores the unmasked phones and
emails for each guest in the session-bound `RevealStore`
([`revealStore.ts`](../apps/bff/src/security/revealStore.ts)) and attaches an opaque
`rt_…` token (`rt_` + base64url of 24 CSPRNG bytes) to the summary. A Read-only colleague
receives no token. `POST /api/v1/guests/reveal` exchanges a token (session-bound, TTL'd) for
that one guest's unmasked contacts. Unknown, expired and cross-session tokens are all reported
identically as `REVEAL_EXPIRED` (no oracle). See
[security/threat-model.md](security/threat-model.md).

## Keeping this document truthful

When the WSDL/XSD arrive (B1–B3):

1. Verify each element against the XSD per the procedure in the `contract.ts` header comment.
2. Flip `verified: true` and set `xsd: '<file>.xsd#<type>'` on the confirmed `EL` entries.
3. Turn on the address feature flags once `line1` / `locality1` / `postalCode` are confirmed.
4. Update the **Status** column in the tables above from Provisional/Blocked to Confirmed.
5. Run the XSD validation tests (`apps/bff/test/xsd/`), which stop skipping once schemas exist.
