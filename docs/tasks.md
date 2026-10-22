# Implementation Plan: IHG Guest Search

## Overview

The build runs inside-out:
1. Monorepo skeleton and CI guardrails.
2. Shared schema and domain types.
3. The pure SOAP layer (contract, header, mapper, parser), proven by unit and property tests.
4. Transport and gateway.
5. BFF services, security and endpoints.
6. Observability.
7. The UI shell and brand.
8. The search form, results, pagination, drawer and reveal.
9. The local WireMock stack.
10. E2E and accessibility.
11. Documentation.

Every SOAP-dependent piece is built against provisional contract identities and synthetic fixtures. When the WSDL/XSD arrives (Blockers B1–B3), the follow-up is contained: update `contract.ts`, flip the address feature flags, and run the XSD tests.

Test tasks are **mandatory**, not optional: `copilot-instructions.md` §15 requires them for every mapping, validation, selection, error and pagination change.

Project root: `IHG-Web/ihg-guest-search/`. All commands are cross-platform npm scripts.

## Tasks

- [x] 1. Set up the monorepo skeleton and tooling
  - [x] 1.1 Create the npm-workspaces monorepo
    - Create `IHG-Web/ihg-guest-search/` with root `package.json` (`"private": true`, workspaces `apps/*`, `packages/*`, `engines.node >=22.15`)
    - Create `apps/web`, `apps/bff`, `packages/shared`, each with its own `package.json` and `tsconfig.json` extending a root `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ESM)
    - Check the latest stable versions of Fastify 5 and its plugins (`@fastify/helmet`, `@fastify/cookie`, `@fastify/rate-limit`, `@fastify/static`), pino, OpenTelemetry Node packages, TypeScript, ESLint and Prettier on npm, and pin them exactly. Pin all versions listed in design.md "Pinned versions".
    - Add `.npmrc` with `save-exact=true` and commit `package-lock.json`
    - Create empty `schemas/`, `samples/`, `docs/` with a README each explaining what belongs there
    - Add `.gitignore` (node_modules, dist, coverage, .env, logs, playwright-report, .vitest) and `.env.example` with placeholder values for every config key
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.8, 1.9_
  - [x] 1.2 Configure lint, format and type-check
    - ESLint flat config with typescript-eslint
    - BFF rule: `no-console`
    - `soap/` rule: `no-restricted-syntax` banning template literals and string concatenation containing `<`
    - Web rule: no hex colour literals in `.tsx`
    - Prettier config; root scripts `typecheck`, `lint`, `format:check`, `build`, `test`, `test:e2e`, `dev`
    - _Requirements: 1.6, 1.7, 23.1, 26.5_
  - [x] 1.3 Configure Vitest 5 projects and coverage
    - Root `vitest.config.ts` with projects `shared` (node), `bff` (node) and `web` (jsdom)
    - Coverage provider v8: global lines 85, branches 80; `apps/bff/src/soap/**` per-file lines 95, branches 90
    - Add a trivial passing test per project and confirm `npm test` runs end to end
    - _Requirements: 25.1, 25.10_
  - [x] 1.4 Add the CI workflow
    - `.github/workflows/ci.yml`: `npm ci`, then typecheck, lint, format:check, test with coverage, build, then Playwright E2E (task 13)
    - CI security steps: `npm audit --audit-level=high` and a gitleaks secret scan
    - Add `scripts/check-deps.mjs`, which fails if `@xmldom/xmldom` resolves below 0.9.12 anywhere in `npm ls`, or if `libxmljs2` is present. Run it in CI.
    - _Requirements: 26.1, 26.2, 26.3, 26.4_

- [x] 2. Implement `packages/shared`
  - [x] 2.1 Implement normalization helpers and criteria constants
    - `normalize.ts`: `normalizeText` (trim → NFC → collapse whitespace → empty becomes undefined) and `hasControlChars` (`/[\p{Cc}\p{Cf}]/u`)
    - `criteria.ts`: `CRITERIA_FIELDS` in UI order, `CriteriaField` type, `defaultLimits` table (placeholder values marked `// TODO(B1): replace with XSD limits`)
    - _Requirements: 3.2, 4.2, 4.3, 4.12_
  - [x] 2.2 Implement the criteria schema factory
    - `createCriteriaSchema(cfg)` with Zod 4: `z.strictObject` and per-field preprocess
    - Email: WHATWG pattern, max 254 characters
    - Country: ISO 3166-1 alpha-2, validated with `i18n-iso-countries`
    - Loyalty Member ID: strip spaces and hyphens, then match the configurable pattern (default `^\d{9}$`)
    - Member Type: must be in the configured code set
    - Phone: format-only (length, no control characters)
    - Root refine with `path: []` and the message "Please enter at least one search criterion."
    - Export `GuestSearchInput` / `GuestSearchQuery`
    - Verify `z.regexes.html5Email` and the `addIssue` shape against the installed Zod; inline the regex if the export differs
    - _Requirements: 4.1, 4.4, 4.6, 4.7, 4.8, 4.9, 4.11, 4.13_
  - [x] 2.3 Implement domain types, error catalog, roles and `pickPrimary`
    - `domain.ts`: interfaces exactly as in design.md
    - `errors.ts`: `ErrorCode` union and `ERROR_CATALOG` with the HTTP statuses and messages from Req 19.1
    - `roles.ts`: `ROLES.READ`, `ROLES.REVEAL`
    - `primary.ts`: `pickPrimary`
    - _Requirements: 13.1, 13.2, 13.3, 19.1, 19.2_
  - [x] 2.4 Write unit and property tests for shared
    - Schema: blank-only gives the root error; each field's valid and invalid examples; Unicode names (Devanagari, CJK, combining marks) accepted; control and format characters rejected; unknown key rejected; Member ID with spaces and hyphens normalized; no case or format changes to names, emails or phones
    - Property P9 (normalization idempotence) and P7 (`pickPrimary`)
    - Error catalog contains every `ErrorCode` with its exact message
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 13.1, 13.2, 13.3, 19.1, 25.4_

- [x] 3. Implement the SOAP contract and header builder
  - [x] 3.1 Implement `apps/bff/src/soap/contract.ts`
    - `NS`, `PREFIX`, `EL` (with `verified: false`), `ORDER`, `DEFAULTS`, `SUCCESS`, `ALLOW`, exactly per design.md
    - Header comment referencing Blockers B1–B3 and explaining how to verify each element against the XSD
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [x] 3.2 Implement the config loader and secret provider
    - `config.ts`: Zod-parse `process.env` into `AppConfig` with documented defaults (timeouts 3 s / 10 s, max response 2 MB, `maxResults` 50, flags false, sequence 1, rate limits 30/min search and 10/min reveal, reveal TTL 10 min, score bands 90/70)
    - On failure, throw `StartupError` listing missing or invalid key names only
    - `SecretProvider` interface and `EnvSecretProvider`
    - _Requirements: 2.6, 7.2, 8.3, 8.4, 8.5, 8.6_
  - [x] 3.3 Implement `headerBuilder.ts`
    - `createHeaderContext(cfg, { now, requestId })`: transaction ID = requestId, timestamp = `now().toISOString()`, configured values
    - `appendHeader(parent, h)`: namespace-aware header elements from `EL` (names provisional, B2)
    - Secrets attach only where the contract defines a location
    - _Requirements: 8.1, 8.2, 8.3, 8.6, 8.7_
  - [x] 3.4 Write tests for contract, config and header
    - Literal scan: no namespace URI or `'0000'` literal in `apps/bff/src/**` outside `contract.ts`
    - Config: defaults applied; missing required key yields an error naming the key without printing the value
    - Header: deterministic output with an injected clock and ID; ISO 8601 UTC format; values come from config
    - _Requirements: 7.6, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

- [x] 4. Implement and test the SOAP request mapper
  - [x] 4.1 Implement `requestMapper.ts`
    - `buildSearchGuestRequest(q, h, { maxResults, features })` with xmlbuilder2 `ele(nsUri, qname)`, `.att()` and `.txt()` only
    - Group builders for name, phone, email, address and membership, run in `ORDER`, each omitted when its inputs are absent
    - Address `line1` / `locality1` / `postalCode` emitted only when the matching feature flag is on; Address Line 2 never read
    - Emit `allAttributes`, `allHistory` and `maxResults`
    - Defensive XML 1.0 illegal-character assertion
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14_
  - [x] 4.2 Create the request fixtures and a test XML reader helper
    - `test/helpers/xmlRead.ts`: a namespace-aware reader (xmldom + xpath) that returns mapped field values and element presence by `(ns, local)`
    - `test/helpers/c14n.ts`: Exclusive C14N-style in-house canonicalizer (xml-crypto dropped: depends on @xmldom/xmldom 0.8.x), plus formatting for file snapshots
    - Fixtures `request-name-phone.xml` and `request-loyalty.xml` (synthetic)
    - _Requirements: 25.2, 25.11_
  - [x] 4.3 Write request-mapper unit tests
    - First name only; last name only; both; phone only; email only; state and country; Loyalty Member ID and Member Type; combined multi-attribute search
    - Blank groups omitted; Address Line 2 never emitted; flags off means no line1, locality1 or postalCode, and flags on means they appear
    - Escaping of `& < > " '`, `]]>` and non-BMP characters
    - Namespace URIs are correct regardless of prefix
    - Header values present; `allAttributes`, `allHistory` and `maxResults` values; child order
    - C14N file snapshots for the two reference requests (awaited `toMatchFileSnapshot`)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 25.2_
  - [x] 4.4 Write request-mapper property tests
    - P1 request round-trip; P2 blank omission (fast-check arbitraries for valid queries)
    - _Requirements: 9.15, 25.4_
  - [x] 4.5 Add the XSD validation test harness
    - `test/xsd/requestXsd.test.ts`, using `describe.skipIf(!schemasPresent)` and xmllint-wasm with all `schemas/*.xsd` preloaded
    - Validate every envelope generated in 4.3; skip with an explicit "B1: schemas not supplied" message
    - _Requirements: 25.7_

- [ ] 5. Implement and test the SOAP response parser
  - [x] 5.1 Implement `responseParser.ts`
    - `SoapError` with `UpstreamCode`
    - DOCTYPE/ENTITY pre-check; xmldom `onError` throws; any non-`SoapError` becomes `UPSTREAM_MALFORMED`; `doc.doctype` check
    - Namespace-aware `child` / `children` helpers driven by `EL`
    - Envelope → Body → Fault → `searchGuestResponse` → `interpretTransactionStatus` → map every `initiateGuest`
    - `mapGuest` reads only `ALLOW` attributes and children; parses `score` and `profileDefault`; empty text becomes undefined
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12_
  - [x] 5.2 Create the response fixtures
    - Every fixture listed in design.md "Fixtures", using synthetic data only (`@example.test`, `+1 404 555 01xx`, IDs `9000000xx`)
    - `scripts/gen-fixtures.ts` generates `response-60-guests.xml` from a template
    - `response-with-cc-token.xml` contains a unique synthetic token marker
    - _Requirements: 2.2, 25.3, 25.11_
  - [x] 5.3 Write response-parser unit tests
    - One guest; multiple guests; repeated phones, emails, addresses and memberships; missing optional fields; non-numeric score; zero guests
    - Unsuccessful status (code retained); client and server Faults (faultcode retained); missing Body; missing response element
    - Truncated XML; HTML proxy page; DTD/entity rejected without resolution
    - Odd prefixes; default namespace; card token absent from output
    - `interpretTransactionStatus` unit cases
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 25.3_
  - [-] 5.4 Write response-parser property tests
    - P3 parser totality (arbitrary strings plus mutated fixtures)
    - P4 prefix invariance (random prefix rewriting, including the default namespace and redeclaration)
    - _Requirements: 11.11, 11.12, 25.4_

- [ ] 6. Implement SOAP transport, circuit breaker and gateway
  - [~] 6.1 Implement `circuitBreaker.ts`
    - Closed → open → half-open state machine with an injectable clock; counts only `UPSTREAM_TIMEOUT` and `UPSTREAM_UNAVAILABLE`; exposes `state`
    - _Requirements: 10.7_
  - [~] 6.2 Implement `transport.ts`
    - Built-in fetch with an undici `Agent` (connect timeout; optional CA, cert and key for mTLS); `AbortSignal.timeout(responseTimeoutMs)`
    - Headers `content-type: text/xml; charset=utf-8` and a quoted `soapaction`
    - Streamed body read with a byte cap (exceeding it gives `UPSTREAM_MALFORMED`)
    - Error classification per design.md; a single retry only for pre-response connection errors; wrapped in the breaker
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.8_
  - [~] 6.3 Implement `SoapGuestSearchGateway` and the `GuestSearchGateway` port
    - `ports/GuestSearchGateway.ts` (no SOAP imports)
    - Gateway: header context → mapper → transport in an OTel span → parser; non-2xx without a Fault gives `UPSTREAM_HTTP_ERROR`; returns `{ results, limit }`
    - _Requirements: 6.8, 10.9_
  - [~] 6.4 Write transport, breaker and gateway tests
    - Breaker: thresholds, open fail-fast, half-open trial success and failure (fake timers)
    - Transport (MSW 3 intercepting fetch): headers sent; timeout gives `UPSTREAM_TIMEOUT`; connection refused retried once then `UPSTREAM_UNAVAILABLE`; no retry after a response; oversized body gives `UPSTREAM_MALFORMED`; open circuit makes no request
    - Gateway: 200 success; 500 with Fault gives `UPSTREAM_FAULT`; 502 HTML gives `UPSTREAM_HTTP_ERROR`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9_

- [~] 7. Checkpoint - SOAP layer complete
  - Run `npm run typecheck`, `npm run lint` and `npm test`. Confirm the SOAP coverage thresholds pass. Review the mapping against `copilot-instructions.md` §5 and §7, then update the provisional-items list in design.md if anything changed. Ask the user if questions arise.

- [ ] 8. Implement BFF services, auth and security plugins
  - [~] 8.1 Implement the auth layer
    - `AuthProvider` interface, `DevAuthProvider`, and `createAuthProvider(cfg)` (dev in production gives `StartupError`; oidc gives `StartupError('OIDC provider not implemented')`)
    - `requireRole(role)` preHandler returning `FORBIDDEN`
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7_
  - [~] 8.2 Implement sessions
    - `SessionStore` interface and `MemorySessionStore` (idle 30 min, absolute 8 h, injectable clock)
    - Session plugin with a signed cookie: `__Host-Http-gs_session` with `Secure`, `HttpOnly`, `SameSite=Strict` and no Domain; `gs_session` without `Secure` only on plain-HTTP localhost in development
    - _Requirements: 20.10_
  - [~] 8.3 Implement PII masking and the reveal store
    - `maskPhone`, `maskEmail` (including the short-value rules)
    - `RevealStore` interface and `MemoryRevealStore` (`rt_` + 24 random bytes base64url, TTL, session binding, `dropSession`)
    - HMAC enterprise-ID hash helper
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.6, 14.9_
  - [~] 8.4 Implement `GuestSearchService`
    - `search()`: gateway → primaries → reveal tokens (only with the REVEAL role) → mask → audit, log, metrics → response (`totalResults = results.length`, `limit`)
    - `reveal()`: consume the token (session-bound) → audit → `RevealResponse`; failure gives `REVEAL_EXPIRED`
    - _Requirements: 6.4, 6.5, 13.4, 14.5, 14.7, 14.10_
  - [~] 8.5 Implement Fastify plugins and the error handler
    - Register plugins in the design.md order: requestId (`X-Request-ID` header), helmet (exact CSP; HSTS in production only), `no-store` on `/api/*`, cookie and session, auth (401 on `/api/*`)
    - CSRF plugin: require `X-Requested-With: guest-search` on unsafe methods and reject `Sec-Fetch-Site: cross-site`
    - Rate limit keyed by session; JSON-only content-type parser; `bodyLimit` 8192
    - `errorHandler` maps Zod, `AppError`, `SoapError`, Fastify 413/415/429 and unknown errors to `ErrorResponse` using `ERROR_CATALOG` only
    - _Requirements: 6.2, 6.3, 19.2, 19.3, 19.4, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 22.10_
  - [~] 8.6 Implement routes and the app factory
    - `buildApp(deps)` (dependency injection for tests) and `server.ts` (loads config, starts telemetry, listens)
    - `GET /api/v1/me`, `GET /api/v1/config` (`UiConfig`: member types, feature flags, score bands, authMode)
    - `POST /api/v1/guests/search`: require `GuestSearch.Read`; validate with the shared schema (a root-only issue gives `NO_CRITERIA`); server phone check with `libphonenumber-js/max`
    - Search route: disabled-feature fields give `VALIDATION_ERROR` "This field is not yet supported for search."; field errors never echo values
    - `POST /api/v1/guests/reveal` (requires `GuestSearch.RevealPII`; reveal rate limit)
    - `POST /api/v1/session/logout` (destroy the session, `dropSession`, `Clear-Site-Data`)
    - `GET /health/live`, `GET /health/ready` (cached TCP reachability, 1 s timeout, 30 s cache)
    - `@fastify/static` serving `apps/web/dist` with SPA fallback when built
    - _Requirements: 4.5, 4.10, 4.14, 6.1, 6.6, 6.7, 6.9, 9.5, 14.7, 14.8, 14.11, 20.8, 20.11, 22.8, 22.9_
  - [~] 8.7 Write BFF unit tests
    - Auth factory startup refusals; `requireRole`; session cookie attributes (both modes)
    - Masking rules (examples plus property P8); reveal-store TTL, wrong session and logout drop
    - Service: primaries computed from unmasked data; tokens only with the REVEAL role
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 25.4_

- [ ] 9. Implement observability
  - [~] 9.1 Implement the logger and audit logger
    - pino with ISO UTC time, base fields, the request-ID child logger, the redact paths from design.md (`remove: true`) and a path-only request serializer
    - Separate audit pino instance writing `guest.search` and `guest.reveal` events
    - Search completion log line with criteria field names only
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5_
  - [~] 9.2 Implement telemetry and metrics
    - `telemetry.ts` OpenTelemetry NodeSDK (http, undici and fastify instrumentations; body capture off); exporter `none`, `console` or `otlp` from config; safe when not configured
    - `metrics.ts` instruments per design.md, including the breaker-state observable gauge
    - Non-PII span attributes only on `guestSearch.soap`
    - _Requirements: 22.6, 22.7, 22.11_

- [ ] 10. Write BFF integration tests
  - [~] 10.1 Write endpoint and error-path integration tests
    - `fastify.inject` with MSW stubbing the SOAP endpoint with fixtures
    - Search success, zero results, every error code including `INTERNAL_ERROR` from an injected failing gateway, `requestId` in every body, and `X-Request-ID`
    - No values echoed in validation errors; disabled-feature field rejection; unknown key rejection
    - _Requirements: 4.5, 4.13, 4.14, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 9.5, 19.1, 19.2, 19.3, 19.4, 25.8_
  - [~] 10.2 Write security integration tests
    - Exact CSP and helmet headers; `no-store`; missing `X-Requested-With` returns 403; `Sec-Fetch-Site: cross-site` returns 403
    - 415 for non-JSON; 413 above 8 KB; 429 after the limit; no CORS headers
    - 401 without a principal (provider stub); 403 without the role
    - Reveal lifecycle: issue, reveal, expire (fake clock), wrong session, logout; `Clear-Site-Data`
    - _Requirements: 14.7, 14.8, 14.9, 14.10, 14.11, 20.6, 20.7, 20.11, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 25.8_
  - [~] 10.3 Write the log-leak test and token-exclusion property
    - Capture app and audit logs in memory; search `response-with-cc-token.xml` and reveal
    - Assert no PII marker, token value or `creditCard` appears in any log line
    - Property P5 over the service response
    - _Requirements: 12.13, 22.3, 25.4, 25.6_

- [~] 11. Checkpoint - BFF complete
  - Run the full test suite and lint. Start the BFF locally against MSW or WireMock and call `/api/v1/me` and `/api/v1/guests/search` manually. Confirm the logs contain no PII. Ask the user if questions arise.

- [ ] 12. Build the Web UI
  - [~] 12.1 Set up the web app foundation and brand tokens
    - Vite 8 + React 19 + `@tailwindcss/vite`; dev proxy `/api` and `/health` to the BFF (same-origin in production)
    - `styles/tokens.css` (all Req 23.2 tokens), `theme.css` (`@theme inline` mapping), `scroll-padding-top`, and a `prefers-reduced-motion` reset
    - Self-hosted Inter via `@fontsource-variable/inter` (pinned)
    - `index.html` with `lang="en"`
    - Global `:focus-visible` style (2px navy outline, 2px offset); minimum target sizes in base component styles; status shown with text and icon, never colour alone
    - _Requirements: 1.4, 18.9, 21.9, 23.1, 23.2, 23.3, 23.4, 24.1, 24.3, 24.4, 24.5, 24.6, 24.7_
  - [~] 12.2 Implement the API client and app shell
    - `api/client.ts`: same-origin fetch, `X-Requested-With: guest-search`, JSON, AbortSignal, `ApiError { code, message, requestId, fields }`
    - `QueryClient` with `gcTime` 5 min and `retry: false`
    - `useMe`, `useUiConfig`
    - `AppShell` with a skip link and `<main>`
    - `Header`: 40px navy utility bar (environment / DEV AUTH badge, name, role, Sign out) and 64px brand bar
    - `BrandLogo`: `/brand/ihg-logo.svg`, falling back to the text wordmark on error or absence
    - `StatusRegion` provider, always mounted, with debounced `announce()`
    - Title manager; `/` shortcut hook
    - Sign out: logout API, `queryClient.clear()`, state reset
    - _Requirements: 14.13, 18.8, 20.9, 21.7, 21.8, 23.5, 23.6, 23.7, 24.10, 24.11_
  - [~] 12.3 Implement the search form and validation UI
    - RHF with a resolver built from `createCriteriaSchema(uiConfig)` (fall back to `standardSchemaResolver` if `zodResolver` types fail)
    - 12 fields in Req 3.2 order with visible labels and `autocomplete`
    - React Aria `CountryComboBox` (localized via `Intl.DisplayNames`) and `MemberTypeSelect` (from `uiConfig.memberTypes`)
    - Address Line 2 disabled with helper text; flag-disabled address fields also disabled with the same helper text
    - Responsive 4/3/2/1-column grid; Enter submits
    - Clear resets everything, announces "Search cleared" and focuses First Name
    - `ErrorSummary` (count heading, links that focus inputs, receives focus); inline "Error:" messages with an icon, `aria-describedby` and `aria-invalid`
    - Server `VALIDATION_ERROR` / `NO_CRITERIA` fields mapped into the same UI
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 9.5, 23.8, 23.9, 23.11, 24.2_
  - [~] 12.4 Implement the search controller and results states
    - `useGuestSearch` state machine per design.md: new `searchId` per submit; cancel the previous request; ignore submits while loading; keep criteria out of the query key; retry the last criteria
    - `ResultsPanel` loading state: button "Searching…", `aria-busy`, skeleton rows, announcement
    - `ResultsPanel` empty state: message and tips; error state: `role="alert"` with message, "Reference: {requestId}" and Try again
    - `ResultsPanel` results state: announce "{n} guests found" and focus the caption
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7_
  - [~] 12.5 Implement the results table
    - TanStack Table v9 with sorting and pagination features
    - 14 columns from the primaries; `<caption>` with the range; `th scope="col"` and an Enterprise ID row header; row keys per Req 15.4
    - Default score sort (desc, undefined last); sortable Score, First, Last, City and Country with `aria-sort`; score band chip
    - Focusable labelled scroll region; sticky navy thead
    - Copy buttons that announce "Copied"; limited-results notice
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.11, 23.10_
  - [~] 12.6 Implement pagination
    - `usePaginator` (client-side implementation behind the abstraction)
    - `Pagination` inside `nav[aria-label="Search results pagination"]`: Prev/Next disabled at the ends, numbered buttons with `aria-current="page"`, page select, range text "Showing {from}–{to} of {total} guests"
    - Numbered controls hidden at 50 or fewer results
    - On page change: focus the caption and announce "Page {n} of {pages}"
    - Reset to page 1 on a new search
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10_
  - [~] 12.7 Implement the details drawer and reveal
    - `GuestDetailsDrawer` (React Aria Modal/Dialog, `aria-modal`, focus trap, Esc/Close returns focus): all collections, with the primary labelled in text
    - `useReveal` in-memory map, cleared on a new search, Clear and sign-out
    - `RevealButton`, shown only with the REVEAL role and a token, with an accessible name including the guest name; replaces values for that row and in the drawer
    - `REVEAL_EXPIRED` message
    - _Requirements: 14.12, 14.13, 14.14, 14.15, 16.1, 16.2, 16.3, 16.4, 16.5_
  - [~] 12.8 Write web component tests
    - Use Testing Library with MSW 3 REST handlers
    - Form tests: fields and order, disabled Address Line 2, all-blank blocking without a request, ErrorSummary focus and links, server validation mapping, Clear behaviour
    - Search flow tests: duplicate-submit prevention and cancellation; loading, empty and error states with Try again
    - Table tests: columns, primaries, keys, sort and `aria-sort`, score band, copy, limited notice
    - Pagination tests: 0, 1, 49, 50 and 51 results with control states, reset on a new search, focus and announcement on page change
    - Drawer and reveal tests: focus trap and return; reveal visibility by role, success, expired, and clearing
    - Shell tests: `/` shortcut, title, DEV AUTH badge, no Web Storage writes (spy on `Storage.prototype.setItem`)
    - Property P6 (pagination partition)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 14.12, 14.13, 14.14, 14.15, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.11, 16.1, 16.2, 16.3, 16.4, 16.5, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11, 17.12, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 21.7, 24.10, 24.11, 25.4, 25.5_

- [ ] 13. Set up the local stack and E2E tests
  - [~] 13.1 Set up the WireMock SOAP stub and dev scripts
    - `docker-compose.dev.yml` with `wiremock/wiremock:3.13.2`, mounting `wiremock/mappings` and the fixtures folder as `__files`
    - Mappings per design.md (scenarios selected by `surname` XPath with `xPathNamespaces`; delayed and HTML-502 scenarios)
    - Root `dev` script running web and BFF concurrently (cross-platform) with `SOAP_ENDPOINT` pointing at WireMock; `stub:up` and `stub:down` scripts
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [~] 13.2 Write a WireMock contract test
    - testcontainers starts WireMock with the real mappings; the gateway is exercised over real HTTP for single, empty, fault, slow (timeout) and proxy-502 scenarios
    - _Requirements: 2.3, 2.4, 10.3, 10.9_
  - [~] 13.3 Write Playwright E2E and accessibility tests
    - `playwright.config.ts` `webServer`: build the web app, start the BFF serving it (`AUTH_MODE=dev`, `SOAP_MAX_RESULTS=60`) against WireMock
    - Flow specs: search with results, zero results, client validation error, upstream error with Try again (Fault, then the default scenario)
    - Feature specs: pagination over 60 results, details drawer, reveal (role on, and role off in a second dev-user config)
    - Keyboard and layout specs: keyboard-only full flow with logical tab order and visible focus on every control; 24×24 px minimum target check; 320px-width reflow check of the form; status messages announced once (status region and alert not duplicated)
    - Shared axe fixture with tags wcag2a, wcag2aa, wcag21a, wcag21aa and wcag22aa (colour-contrast rule enabled); scan every state listed in design.md; fail on any violation
    - _Requirements: 24.1, 24.3, 24.4, 24.5, 24.6, 24.8, 24.9, 24.12, 25.9_

- [~] 14. Checkpoint - full system verification
  - Run `npm ci`, typecheck, lint, format:check, test with coverage, build, `npm run test:e2e` and `scripts/check-deps.mjs`. Fix every failure.
  - Cross-check `copilot-instructions.md` §19 Definition of Done item by item against the implementation. Report a covered/missing table and fix the gaps.
  - Ask the user if questions arise.

- [ ] 15. Write the documentation
  - [~] 15.1 Write the README
    - Purpose, Mermaid architecture diagram, prerequisites (Node 22.15+, Docker), setup, `dev`, test and E2E commands, configuration reference (every env key with its default), and blocked items (B1–B8). No author attribution.
    - _Requirements: 27.1_
  - [~] 15.2 Write the mapping document, ADRs, threat model and open questions
    - `docs/mapping.md`: every UI→SOAP and SOAP→domain mapping with status confirmed, provisional or blocked
    - `docs/adr/0001-node-bff.md`, `0002-hand-built-soap-envelope.md`, `0003-auth-placeholder.md`, `0004-pii-masking.md`, `0005-client-side-pagination.md`
    - `docs/security/threat-model.md` (from the design.md table)
    - `docs/a11y-manual-checklist.md`
    - `docs/open-questions.md` (blueprint §20 plus the design.md open items)
    - _Requirements: 27.2, 27.3, 27.4_

- [~] 16. Final checkpoint
  - Re-run the full verification from task 14. Confirm that no real PII, credentials or tokens are committed (gitleaks plus a manual fixtures review). Summarize what was built, what was verified, and what remains blocked on WSDL/XSD, samples, code sets and the logo.

## Notes

- Requirement 28 (non-goals) is satisfied by not building those features. No tasks exist for profile editing, server-side SOAP paging, payment data, public access, OIDC, production infrastructure, duplicate detection, saved searches, export, natural-language search or deep links.
- Manual accessibility verification (screen readers, zoom, contrast spot-check) is listed in `docs/a11y-manual-checklist.md`. It cannot be fully automated.
- When the WSDL/XSD arrives, run a separate follow-up: update `contract.ts` (namespaces, `verified: true`, order, limits), enable the confirmed address flags, update the fixtures, and run the XSD tests (task 4.5).
