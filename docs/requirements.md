# Requirements Document

## Introduction

**IHG Guest Search** is an internal, staff-facing web application for IHG Hotels & Resorts colleagues (Customer Care, hotel front office, loyalty operations). A colleague enters guest search criteria, the Backend-for-Frontend (BFF) validates and maps them to the existing SOAP 1.1 `searchGuestRequest` operation, and the normalized results appear in a paginated table styled to match ihg.com.

This specification is derived from three sources, in this order of authority:

1. `IHG-Web/copilot-instructions.md`, the mandatory engineering rules (SOAP contract, mappings, security, testing, Definition of Done).
2. `IHG-Web/IHG-Guest-Search-Blueprint.md`, the enriched research blueprint (stack, brand, UX, security, observability).
3. Decisions confirmed by the product owner on 2026-10-21:
   - Node/TypeScript BFF.
   - A pluggable identity placeholder now, OIDC later.
   - PII masked by default, with an audited, role-gated reveal.

The WSDL/XSD, sanitized SOAP samples and the approved mapping document are **not yet available**. Requirements that depend on them say so explicitly. The system is therefore built against a local SOAP stub (WireMock) and synthetic fixtures. The schema-dependent parts are designed so that the real schemas can be dropped in without restructuring.

## Glossary

- **Guest_Search_App**: The complete system described here: the Web_UI, BFF, Shared_Schema and the local development stack.
- **Web_UI**: The React single-page application running in the colleague's browser.
- **BFF**: The Node/TypeScript Backend-for-Frontend. It serves the REST/JSON API and is the only component that communicates with the SOAP_Service.
- **SOAP_Service**: The existing IHG Guest Search SOAP 1.1 API exposing the `searchGuestRequest` operation.
- **SOAP_Stub**: The local WireMock instance that mimics the SOAP_Service using synthetic fixtures.
- **Colleague**: An authenticated IHG staff member using the Guest_Search_App.
- **Search_Criteria**: The 12 user-entered fields: First Name, Last Name, Address Line 1, Address Line 2, City, State or Region, Postal Code, Country, Phone, Email, Loyalty Member ID, Member Type.
- **Shared_Schema**: The Zod validation schema for Search_Criteria. The Web_UI and the BFF both use it, and the BFF's result is authoritative.
- **Request_Mapper**: The pure BFF function that converts validated Search_Criteria and a Header_Context into a SOAP envelope string.
- **Header_Builder**: The BFF component that produces SOAP header values from runtime configuration and request context.
- **Header_Context**: The per-request values used by the Header_Builder: transaction ID, sequence, timestamp, and configured locale, channel, subchannel, environment and service user.
- **Response_Parser**: The pure BFF function that validates a SOAP response envelope and converts it into Guest_Search_Results.
- **SOAP_Transport**: The BFF component that sends the envelope over HTTP(S) with timeouts, size limits and a circuit breaker.
- **Guest_Search_Gateway**: The port (interface) through which the BFF performs a guest search. The SOAP implementation is one adapter.
- **Contract_Module**: The single BFF module holding all SOAP namespaces, fixed attribute values, control values and success-status codes.
- **Guest_Search_Result**: The normalized domain object for one returned guest. It contains arrays of addresses, phones, emails and memberships.
- **Guest_Search_Response**: The normalized JSON returned by the BFF to the Web_UI.
- **Primary_Value**: The item chosen from a repeating collection for the summary row. It is the first item with `profileDefault=true`, otherwise the first item in service order.
- **Prohibited_Data**: The `creditCard` element and its `token`, plus any other element not on the Domain_Allowlist.
- **Domain_Allowlist**: The explicit list of SOAP response fields the Response_Parser is permitted to read and map.
- **Masked_Value**: A display form of a phone (last 4 digits) or email (first character plus domain) produced by the BFF.
- **Reveal_Token**: An opaque, short-lived, session-bound server-side token that permits retrieving one guest's unmasked contact details.
- **Auth_Provider**: The pluggable BFF interface that resolves the authenticated Principal for a request.
- **Dev_Auth_Provider**: The local placeholder Auth_Provider that returns a configured synthetic Principal.
- **Principal**: The authenticated Colleague identity: id, display name and roles.
- **Request_ID**: The unique correlation identifier generated per search. It is also used as the SOAP transaction ID.
- **Paginator**: The Web_UI abstraction that slices a result set into pages. It is client-side for the MVP.
- **Status_Region**: A persistent ARIA live region (`role="status"`) used to announce non-error state changes.
- **Error_Summary**: The validation summary block shown at the top of the search form.
- **Brand_Tokens**: The CSS custom properties defining IHG colours, typography, radii and shadows.
- **Audit_Log**: The structured, separate log stream recording searches and PII reveals without recording PII values.

## Requirements

### Requirement 1: Technical Platform and Repository Structure

**User Story:** As a developer, I want a consistent, pinned TypeScript monorepo, so that the UI, BFF and shared code build, test and run the same way on every machine.

#### Acceptance Criteria

1. THE Guest_Search_App SHALL be implemented in TypeScript as an npm-workspaces monorepo containing `apps/web`, `apps/bff` and `packages/shared`.
2. THE Guest_Search_App SHALL require Node.js 22.15 or later and SHALL declare this in the `engines` field of the root `package.json`.
3. THE Guest_Search_App SHALL pin every direct dependency to an exact version and SHALL commit a lockfile.
4. THE Web_UI SHALL be a React single-page application built with Vite and SHALL NOT use a server-side rendering framework.
5. THE BFF SHALL be a Node.js HTTP service written in TypeScript.
6. THE Guest_Search_App SHALL provide root scripts to install, build, type-check, lint, format-check, test and start the local development stack.
7. THE Guest_Search_App SHALL work on Windows, macOS and Linux using only cross-platform scripts.
8. THE Guest_Search_App SHALL include a `.env.example` file containing placeholder values only, and SHALL exclude real `.env` files from version control.
9. THE Guest_Search_App SHALL reserve the directories `schemas/`, `samples/` and `docs/` for the WSDL/XSD files, sanitized SOAP samples and mapping documentation.

### Requirement 2: Local Development Stack

**User Story:** As a developer, I want to run the entire application locally against a SOAP stub, so that I can build and test without access to IHG systems.

#### Acceptance Criteria

1. THE Guest_Search_App SHALL provide a Docker Compose file that starts the SOAP_Stub using a pinned WireMock image.
2. THE SOAP_Stub SHALL serve synthetic SOAP responses from the same fixture files used by the automated tests.
3. THE SOAP_Stub SHALL select responses by matching the `SOAPAction` header and namespace-aware XPath expressions on the request body.
4. THE SOAP_Stub SHALL provide stub scenarios for a single guest, multiple guests, an empty result, an unsuccessful transaction status, a SOAP Fault, a malformed response and a delayed response.
5. WHEN the developer runs the root development script, THE Guest_Search_App SHALL start the Web_UI and the BFF with the BFF configured to call the SOAP_Stub.
6. THE BFF SHALL read the SOAP_Service endpoint URL only from configuration.

### Requirement 3: Search Form

**User Story:** As a Colleague, I want a clear search form with all supported guest criteria, so that I can look up a guest using whatever details the guest gives me.

#### Acceptance Criteria

1. THE Web_UI SHALL display a search form containing a labelled input for each of the 12 Search_Criteria fields.
2. THE Web_UI SHALL order the fields as: First Name, Last Name, Email, Phone, Loyalty Member ID, Member Type, Country, State or Region, Address Line 1, Address Line 2, City, Postal Code.
3. THE Web_UI SHALL present Country as a searchable selection of ISO 3166-1 alpha-2 countries, with names localized through the browser's internationalization API.
4. THE Web_UI SHALL present Member Type as a selection whose options and labels come from a configurable code-set list.
5. WHILE the request schema does not define an element for Address Line 2, THE Web_UI SHALL render the Address Line 2 input as disabled, with helper text stating that the field is not yet supported.
6. THE Web_UI SHALL provide a Search button and a Clear button.
7. THE Web_UI SHALL NOT display or accept any SOAP header value as a user input.
8. WHEN the Colleague activates Clear, THE Web_UI SHALL reset all Search_Criteria, results, pagination state and validation errors, announce "Search cleared" in the Status_Region, and move focus to the First Name input.
9. WHEN the Colleague presses Enter within a search input, THE Web_UI SHALL submit the search.
10. THE Web_UI SHALL lay out the form in four columns at viewport widths of 1200px and above, three columns from 992px, two columns from 768px and one column below 768px.

### Requirement 4: Input Validation and Normalization

**User Story:** As a Colleague, I want immediate, clear feedback on invalid input, and as a system owner I want the backend to enforce the same rules, so that only well-formed searches reach the SOAP service.

#### Acceptance Criteria

1. THE Shared_Schema SHALL define validation for all 12 Search_Criteria fields. THE Web_UI and THE BFF SHALL both use it.
2. THE Shared_Schema SHALL trim leading and trailing whitespace, apply Unicode NFC normalization, collapse runs of internal whitespace to a single space, and convert empty or whitespace-only values to "not supplied".
3. THE Shared_Schema SHALL reject text containing Unicode control or format characters (categories Cc and Cf), and SHALL accept letters and combining marks from any script.
4. IF every Search_Criteria field is not supplied, THEN THE Web_UI SHALL NOT send a request and SHALL display "Please enter at least one search criterion."
5. IF every Search_Criteria field is not supplied in a request to the BFF, THEN THE BFF SHALL respond with HTTP 400 and error code `NO_CRITERIA`, and SHALL NOT call the SOAP_Service.
6. IF an Email value does not match the WHATWG HTML email pattern or exceeds 254 characters, THEN THE Shared_Schema SHALL report "Enter a valid email address".
7. IF a Country value is not a valid ISO 3166-1 alpha-2 code, THEN THE Shared_Schema SHALL report "Select a valid country".
8. THE Shared_Schema SHALL remove spaces and hyphens from Loyalty Member ID and SHALL validate the result against a configurable pattern whose default is exactly 9 digits.
9. IF a Member Type value is not in the configured code set, THEN THE Shared_Schema SHALL report a validation error.
10. THE BFF SHALL validate Phone with libphonenumber-js using full metadata, with the supplied Country as the default region, and SHALL report "Enter a valid phone number" when parsing or validation fails.
11. THE Shared_Schema SHALL NOT transform the case, formatting or content of names, addresses, emails or phone numbers beyond the normalization in criterion 2.
12. THE Shared_Schema SHALL read maximum field lengths from a single configurable limits table. THE limits table SHALL be replaced with XSD-defined limits once the schemas are supplied.
13. THE BFF SHALL reject request bodies that contain properties not defined in the Shared_Schema, with HTTP 400 and error code `VALIDATION_ERROR`.
14. IF BFF validation fails, THEN THE BFF SHALL respond with HTTP 400, error code `VALIDATION_ERROR`, and a list of field names with messages that does not echo the submitted values.

### Requirement 5: Validation Error Presentation

**User Story:** As a Colleague using a keyboard or screen reader, I want validation errors to be easy to find and fix, so that I can correct my search quickly.

#### Acceptance Criteria

1. WHEN client-side validation fails on submit, THE Web_UI SHALL display an Error_Summary above the form, containing a heading that states the number of problems and one link per problem.
2. WHEN client-side validation fails on submit, THE Web_UI SHALL move keyboard focus to the Error_Summary.
3. WHEN the Colleague activates a link in the Error_Summary, THE Web_UI SHALL move focus to the related input.
4. THE Web_UI SHALL display each field error directly below its input, prefixed with "Error:", accompanied by an icon, and associated with the input through `aria-describedby`.
5. WHILE an input has a validation error, THE Web_UI SHALL set `aria-invalid="true"` on that input.
6. WHEN the Colleague corrects an invalid input and submits again, THE Web_UI SHALL remove the resolved errors from the Error_Summary and the inline messages.
7. WHEN the BFF returns `VALIDATION_ERROR`, THE Web_UI SHALL present the returned field errors using the same Error_Summary and inline presentation.

### Requirement 6: BFF Search Endpoint

**User Story:** As the Web_UI, I want a single normalized JSON search endpoint, so that the browser never handles SOAP or integration details.

#### Acceptance Criteria

1. THE BFF SHALL expose `POST /api/v1/guests/search` accepting a JSON body of the form `{ "criteria": { ...Search_Criteria } }`.
2. THE BFF SHALL accept only `Content-Type: application/json` on this endpoint, and SHALL respond with HTTP 415 for any other content type.
3. THE BFF SHALL limit the request body to 8 KB, and SHALL respond with HTTP 413 for larger bodies.
4. WHEN a search succeeds, THE BFF SHALL respond with HTTP 200 and a Guest_Search_Response containing `requestId`, `success: true`, `totalResults`, `limit` and `results`.
5. WHEN a search succeeds with zero guests, THE BFF SHALL respond with HTTP 200, `success: true`, `totalResults: 0` and an empty `results` array.
6. THE BFF SHALL include `requestId` in every response from this endpoint, both success and error.
7. THE BFF SHALL return search results only through the Guest_Search_Response and SHALL NOT expose SOAP XML, SOAP header values or schema-generated objects.
8. THE BFF SHALL perform the search through the Guest_Search_Gateway interface. THE route handler SHALL NOT depend on SOAP-specific modules.
9. THE BFF SHALL never place Search_Criteria values in URLs, query strings or response headers.

### Requirement 7: SOAP Contract Centralization

**User Story:** As an integration engineer, I want every SOAP contract literal in one place, so that adapting to the real WSDL/XSD is a contained change.

#### Acceptance Criteria

1. THE Contract_Module SHALL define the namespace URIs:
   - `http://schemas.xmlsoap.org/soap/envelope/`
   - `http://atp.ihg.com/schema/common/ATPCommonServiceTypes/v1`
   - `http://crm.ihg.com/schema/v1_0/initiate`
   - `http://common.crm.ihg.com/schema/v1_0/complex`
   - `http://atp.ihg.com/schema/crs/initiate/servicetypes/v1`
   - `http://common.crm.ihg.com/schema/v1_0/basictypes`
2. THE Contract_Module SHALL define the defaults:
   - search criteria `status` = `O`
   - phone `location` = `H` and `profileDefault` = `true`
   - email `profileDefault` = `true`
   - address `locationCode` = `H` and `profileDefault` = `true`
   - `allAttributes` = `true`, `allHistory` = `false`
   - `maxResults` = a configurable value whose default is 50
3. THE Contract_Module SHALL define the success indicators `transactionSuccessful` = `true` and `overallStatusCode` = `0000`.
4. THE Contract_Module SHALL define, for each SOAP element used, its namespace URI and local name. THE Request_Mapper and THE Response_Parser SHALL obtain element identities only from the Contract_Module.
5. THE Contract_Module SHALL mark the namespace placement of each element as provisional until it is verified against the XSD, and SHALL reference the schema file once available.
6. THE BFF SHALL contain no SOAP namespace URI, fixed attribute value or status code literal outside the Contract_Module and test fixtures.

### Requirement 8: SOAP Header Construction

**User Story:** As a system owner, I want SOAP headers generated securely by the backend, so that integration identifiers and credentials are never controlled or seen by users.

#### Acceptance Criteria

1. THE Header_Builder SHALL generate a unique transaction ID for each search, and THE BFF SHALL use the same value as the Request_ID.
2. THE Header_Builder SHALL generate the send timestamp at request time, in UTC, in ISO 8601 `xs:dateTime` format.
3. THE Header_Builder SHALL read language and country code, channel, subchannel, environment and service user from runtime configuration.
4. THE Header_Builder SHALL read any service credential through a secret-provider interface. In local development, THE secret-provider SHALL read from environment variables.
5. IF a required header configuration value is missing at BFF startup, THEN THE BFF SHALL fail to start with an error naming the missing configuration key without printing its value.
6. THE Header_Builder SHALL set the transaction sequence to a configurable value whose default is 1.
7. THE Header_Builder SHALL accept an injectable clock and ID generator, so that tests are deterministic.

### Requirement 9: SOAP Request Mapping

**User Story:** As an integration engineer, I want validated criteria mapped to schema-valid SOAP elements, with blank criteria omitted, so that the service receives exactly what the colleague searched for.

#### Acceptance Criteria

1. THE Request_Mapper SHALL build the SOAP 1.1 envelope with a namespace-aware XML builder and SHALL NOT construct XML through string concatenation or template literals.
2. THE Request_Mapper SHALL escape all user-supplied values through the XML builder.
3. THE Request_Mapper SHALL map:
   - First Name to `searchGuestRequest/searchCriteria/name/given`
   - Last Name to `searchGuestRequest/searchCriteria/name/surname`
   - Phone to `searchCriteria/phone/@number`
   - Email to `searchCriteria/email/address`
   - State or Region to `searchCriteria/address/source/region1`
   - Country to `searchCriteria/address/source/country`
   - Member Type to `searchCriteria/membership/@code`
   - Loyalty Member ID to `searchCriteria/membership/@value`
4. WHILE the request XSD has not confirmed `line1`, `locality1` and `postalCode` as valid request address elements, THE Request_Mapper SHALL keep the mappings of Address Line 1, City and Postal Code behind a feature flag defaulting to disabled.
5. IF a Colleague supplies Address Line 1, City or Postal Code while the related mapping is disabled, THEN THE BFF SHALL respond with HTTP 400, error code `VALIDATION_ERROR` and the message "This field is not yet supported for search."
6. THE Request_Mapper SHALL NOT emit any element for Address Line 2.
7. WHEN neither First Name nor Last Name is supplied, THE Request_Mapper SHALL omit the `name` element.
8. WHEN Phone is not supplied, THE Request_Mapper SHALL omit the `phone` element.
9. WHEN Email is not supplied, THE Request_Mapper SHALL omit the `email` element.
10. WHEN no address criteria are supplied, THE Request_Mapper SHALL omit the `address` element.
11. WHEN neither Member Type nor Loyalty Member ID is supplied, THE Request_Mapper SHALL omit the `membership` element.
12. THE Request_Mapper SHALL emit `allAttributes`, `allHistory` and `maxResults` using values from the Contract_Module.
13. THE Request_Mapper SHALL emit child elements in the order defined by the Contract_Module. WHEN schemas are available, the order SHALL match the XSD `xs:sequence`.
14. THE Request_Mapper SHALL be a pure function of Search_Criteria and Header_Context, with no I/O.
15. FOR ALL valid Search_Criteria, parsing the generated envelope and reading back each mapped field SHALL yield the supplied normalized value (round-trip property).

### Requirement 10: SOAP Transport and Resilience

**User Story:** As a system owner, I want calls to the SOAP service bounded in time and size, so that a slow or failing upstream cannot exhaust the BFF.

#### Acceptance Criteria

1. THE SOAP_Transport SHALL send requests with HTTP POST, `Content-Type: text/xml; charset=utf-8`, and a quoted `SOAPAction` header value taken from configuration.
2. THE SOAP_Transport SHALL apply a connection timeout (default 3 seconds) and a response timeout (default 10 seconds), both configurable.
3. IF the response timeout elapses, THEN THE SOAP_Transport SHALL abort the request and report error code `UPSTREAM_TIMEOUT`.
4. IF the connection fails or the connection timeout elapses, THEN THE SOAP_Transport SHALL report error code `UPSTREAM_UNAVAILABLE`.
5. THE SOAP_Transport SHALL retry at most once, and only for connection failures that occur before any response bytes are received.
6. THE SOAP_Transport SHALL stop reading and report error code `UPSTREAM_MALFORMED` when a response body exceeds a configurable size limit (default 2 MB).
7. THE SOAP_Transport SHALL wrap calls in a circuit breaker. WHILE the circuit is open, it SHALL fail fast with error code `UPSTREAM_UNAVAILABLE` without calling the SOAP_Service.
8. WHERE the configured endpoint uses HTTPS, THE SOAP_Transport SHALL verify the server certificate, and SHALL support optional client certificates (mTLS) from configuration.
9. IF the SOAP_Service returns a non-2xx HTTP status whose body is not a SOAP Fault, THEN THE SOAP_Transport SHALL report error code `UPSTREAM_HTTP_ERROR`.

### Requirement 11: Secure SOAP Response Parsing

**User Story:** As a security engineer, I want SOAP responses parsed defensively, so that hostile or malformed XML cannot compromise the BFF.

#### Acceptance Criteria

1. IF a response body contains a `<!DOCTYPE` or `<!ENTITY` declaration, THEN THE Response_Parser SHALL reject it with error code `UPSTREAM_MALFORMED`, without resolving entities.
2. THE Response_Parser SHALL treat every XML parser warning or error as a failure and SHALL NOT use any recovery mode.
3. IF the response is not well-formed XML, THEN THE Response_Parser SHALL report error code `UPSTREAM_MALFORMED`.
4. THE Response_Parser SHALL locate elements by namespace URI and local name, and SHALL NOT depend on namespace prefixes.
5. IF the SOAP Envelope or Body is missing, THEN THE Response_Parser SHALL report error code `UPSTREAM_CONTRACT`.
6. IF the Body contains a SOAP Fault, THEN THE Response_Parser SHALL report error code `UPSTREAM_FAULT` and SHALL retain only the `faultcode` for logging.
7. IF the Body does not contain `searchGuestResponse`, THEN THE Response_Parser SHALL report error code `UPSTREAM_CONTRACT`.
8. IF `transactionStatus/@transactionSuccessful` is not `true`, THEN THE Response_Parser SHALL report error code `UPSTREAM_TXN_FAILED` and SHALL retain the `overallStatusCode` for logging.
9. THE Response_Parser SHALL interpret transaction status through one centralized, unit-tested function.
10. THE Response_Parser SHALL be a pure function of the response string, with no I/O.
11. FOR ALL inputs, THE Response_Parser SHALL either return Guest_Search_Results or report one of the defined typed errors, and SHALL NOT raise any other exception (totality property).
12. FOR ALL valid responses, renaming namespace prefixes (including to a default namespace) SHALL NOT change the parsed Guest_Search_Results (prefix-invariance property).

### Requirement 12: Response-to-Domain Mapping

**User Story:** As a Colleague, I want every returned guest with all their contact details, so that I can identify the right guest profile.

#### Acceptance Criteria

1. THE Response_Parser SHALL map every `initiateGuest` element in `searchGuestResponse`, in service order.
2. THE Response_Parser SHALL map:
   - `@score` (as a number) to `score`
   - `@status` to `status`
   - `@gender` to `gender`
   - `enterpriseId` to `enterpriseId`
   - `name/given` to `firstName`
   - `name/surname` to `lastName`
3. THE Response_Parser SHALL map each `address` into a GuestAddress:
   - `source/line1` to `line1`
   - `source/locality1` to `city`
   - `source/region1` to `stateOrRegion`
   - `source/postalCode` to `postalCode`
   - `source/country` to `country`
   - `@locationCode` to `locationCode`
   - `@profileDefault` to `profileDefault`
4. THE Response_Parser SHALL map each `phone` into a GuestPhone using `@number`, `@type`, `@location` and `@profileDefault`.
5. THE Response_Parser SHALL map each `email` into a GuestEmail using `address` and `@profileDefault`.
6. THE Response_Parser SHALL map each `membership` into a GuestMembership: `@code` to `memberType`, `@value` to `memberId` and `@status` to `status`.
7. THE Response_Parser SHALL represent addresses, phones, emails and memberships as arrays, even when the response contains zero or one item.
8. IF an `@score` value is not numeric, THEN THE Response_Parser SHALL leave `score` undefined and continue mapping the guest.
9. IF an optional guest field is absent, THEN THE Response_Parser SHALL leave the corresponding domain field undefined and SHALL NOT fabricate a default.
10. THE Response_Parser SHALL read only fields on the Domain_Allowlist.
11. THE Response_Parser SHALL NOT read, map, return or log Prohibited_Data.
12. THE Response_Parser SHALL NOT deduplicate collection items.
13. FOR ALL responses containing Prohibited_Data, the serialized Guest_Search_Response SHALL contain neither the Prohibited_Data values nor their element names (token-exclusion property).

### Requirement 13: Primary Value Selection

**User Story:** As a Colleague, I want the most relevant contact details in the summary row, so that I can scan results quickly.

#### Acceptance Criteria

1. THE BFF SHALL select the Primary_Value for addresses, phones, emails and memberships as the first item with `profileDefault=true`, otherwise the first item in service order.
2. WHEN more than one item has `profileDefault=true`, THE BFF SHALL select the first such item in service order.
3. WHEN a collection is empty, THE BFF SHALL report no Primary_Value for it.
4. THE BFF SHALL include the full collections alongside the Primary_Value for each Guest_Search_Result.

### Requirement 14: PII Masking and Reveal

**User Story:** As a privacy officer, I want guest contact details masked by default and revealed only by authorized colleagues with an audit trail, so that personal data exposure is minimized.

#### Acceptance Criteria

1. THE BFF SHALL replace each phone number in a Guest_Search_Response with a Masked_Value showing a mask prefix and the last 4 digits.
2. THE BFF SHALL replace each email address in a Guest_Search_Response with a Masked_Value showing the first character of the local part, a mask, and the full domain.
3. IF a phone number has 4 or fewer digits, or an email local part has 1 character, THEN THE BFF SHALL mask the entire value except the domain.
4. THE BFF SHALL NOT mask names, addresses, Enterprise ID, Loyalty Member ID, Member Type or Membership Status.
5. WHERE the Principal holds the role `GuestSearch.RevealPII`, THE BFF SHALL include a Reveal_Token for each Guest_Search_Result.
6. THE BFF SHALL store each Reveal_Token server-side, bound to the issuing session, with a configurable time-to-live whose default is 10 minutes.
7. THE BFF SHALL expose `POST /api/v1/guests/reveal` accepting `{ "revealToken": string }`, and SHALL return the unmasked phones and emails for that guest only.
8. IF the Principal lacks `GuestSearch.RevealPII`, THEN THE BFF SHALL respond to a reveal request with HTTP 403 and error code `FORBIDDEN`.
9. IF a Reveal_Token is unknown, expired or bound to a different session, THEN THE BFF SHALL respond with HTTP 404 and error code `REVEAL_EXPIRED`.
10. WHEN a reveal succeeds, THE BFF SHALL write an Audit_Log event containing the Principal id, timestamp, Request_ID and a hash of the Enterprise ID, without contact values.
11. THE BFF SHALL rate-limit reveal requests per session.
12. WHEN the Colleague activates Reveal for a row, THE Web_UI SHALL display the unmasked values for that row only.
13. WHEN a new search starts, Clear is activated, or the Colleague signs out, THE Web_UI SHALL discard all revealed values.
14. IF a reveal request returns `REVEAL_EXPIRED`, THEN THE Web_UI SHALL display "Details expired. Please search again."
15. THE Web_UI SHALL display the Reveal control only to Principals holding `GuestSearch.RevealPII`.

### Requirement 15: Results Table

**User Story:** As a Colleague, I want search results in a clear table, so that I can compare matching guests and pick the right one.

#### Acceptance Criteria

1. WHEN a search succeeds with one or more guests, THE Web_UI SHALL display a semantic HTML table with the columns: Match Score, Enterprise ID, First Name, Last Name, Address, City, State or Region, Postal Code, Country, Phone, Email, Loyalty Member ID, Member Type, Membership Status.
2. THE Web_UI SHALL populate the address, phone, email and membership columns from each guest's Primary_Value.
3. THE Web_UI SHALL include a `<caption>` describing the table and the current result range, `<th scope="col">` column headers, and Enterprise ID as the row header (`<th scope="row">`).
4. THE Web_UI SHALL use Enterprise ID as the row key. WHERE an Enterprise ID is missing or duplicated, THE Web_UI SHALL use a key that combines Enterprise ID with the row's index in the result set.
5. THE Web_UI SHALL display results sorted by Match Score descending by default, with guests without a score placed last in service order.
6. THE Web_UI SHALL display a Match Score band label of "High", "Medium" or "Low" next to each numeric score, using configurable thresholds, conveyed in text and not by colour alone.
7. THE Web_UI SHALL allow sorting the current result set by Match Score, First Name, Last Name, City and Country. Sortable column headers SHALL expose `aria-sort` on the sorted column.
8. THE Web_UI SHALL place the table in a horizontally scrollable region that has an accessible name and is keyboard-focusable.
9. THE Web_UI SHALL provide copy-to-clipboard buttons for Enterprise ID and Loyalty Member ID, with accessible names that include the guest's name, and SHALL announce "Copied" in the Status_Region.
10. THE Web_UI SHALL NOT display raw XML, SOAP fault details, stack traces or internal identifiers other than Enterprise ID and Loyalty Member ID.
11. WHEN `totalResults` equals `limit`, THE Web_UI SHALL display the notice "Results are limited to the first {limit} matches. Refine your search to narrow the results." and SHALL NOT state or imply that additional records can be retrieved.

### Requirement 16: Guest Details Drawer

**User Story:** As a Colleague, I want to see all of a guest's addresses, phones, emails and memberships, so that I can confirm their identity when details differ.

#### Acceptance Criteria

1. THE Web_UI SHALL provide a "View details" control in each result row, with an accessible name that includes the guest's name.
2. WHEN the Colleague activates "View details", THE Web_UI SHALL open a modal side drawer showing every address, phone, email and membership for that guest, marking the Primary_Value of each collection with a text label.
3. WHILE the drawer is open, THE Web_UI SHALL trap focus within the drawer and set `aria-modal="true"`.
4. WHEN the Colleague presses Escape or activates the Close button, THE Web_UI SHALL close the drawer and return focus to the control that opened it.
5. THE drawer SHALL apply the same masking and Reveal behaviour as the results table.

### Requirement 17: Pagination

**User Story:** As a Colleague, I want to page through results, so that large result sets stay readable.

#### Acceptance Criteria

1. THE Web_UI SHALL paginate the result set with a default page size of 50 rows.
2. THE Paginator SHALL be an abstraction with a client-side implementation, and SHALL allow a server-side implementation without changing the table component.
3. THE Web_UI SHALL provide Previous, Next, numbered page buttons and a page selection control within `<nav aria-label="Search results pagination">`.
4. THE Web_UI SHALL indicate the current page visually and with `aria-current="page"`.
5. THE Web_UI SHALL display the result range as "Showing {from}–{to} of {total} guests".
6. WHILE the current page is the first page, THE Web_UI SHALL disable Previous.
7. WHILE the current page is the last page, THE Web_UI SHALL disable Next.
8. WHEN a new search succeeds, THE Web_UI SHALL reset to page 1.
9. WHEN the page changes, THE Web_UI SHALL move focus to the table caption and announce "Page {n} of {pages}" in the Status_Region.
10. WHEN the result set contains 50 or fewer guests, THE Web_UI SHALL display the result range and SHALL hide the numbered page controls.
11. THE Guest_Search_App SHALL NOT add offset, start index, page number, page size or continuation token fields to the SOAP request.
12. FOR ALL totals from 0 to 1000 and page size 50, the pages produced by the Paginator SHALL contain every result exactly once, in order, and the page count SHALL equal the ceiling of total ÷ 50 (partition property).

### Requirement 18: Loading, Empty and Error States

**User Story:** As a Colleague, I want clear feedback while a search runs, when nothing matches, and when something fails, so that I always know what to do next.

#### Acceptance Criteria

1. WHILE a search request is in progress, THE Web_UI SHALL disable the Search button, show "Searching…" on it, set `aria-busy="true"` on the results region, and announce "Searching guests…" in the Status_Region.
2. WHILE a search request is in progress, THE Web_UI SHALL ignore further search submissions.
3. WHEN a new search starts while a previous search is in progress, THE Web_UI SHALL cancel the previous request.
4. WHEN a search succeeds with one or more guests, THE Web_UI SHALL announce "{n} guests found" in the Status_Region and move focus to the table caption.
5. WHEN a search succeeds with zero guests, THE Web_UI SHALL display "No guests found matching the search criteria." with suggestions for broadening the search, and SHALL NOT present it as an error.
6. IF a search fails, THEN THE Web_UI SHALL display an alert (`role="alert"`) containing the user-facing message for the error code, the text "Reference: {requestId}", and a "Try again" button.
7. WHEN the Colleague activates "Try again", THE Web_UI SHALL resubmit the last criteria.
8. THE Web_UI SHALL keep the Status_Region in the DOM from initial page load.
9. WHERE the Colleague's system requests reduced motion, THE Web_UI SHALL disable spinner and transition animations.

### Requirement 19: Error Normalization

**User Story:** As a system owner, I want every failure mapped to a safe, consistent error, so that users get helpful messages and nothing sensitive leaks.

#### Acceptance Criteria

1. THE BFF SHALL map failures to the following error codes, HTTP statuses and user messages:

   | Error code | HTTP | User message |
   |---|---|---|
   | `NO_CRITERIA` | 400 | "Please enter at least one search criterion." |
   | `VALIDATION_ERROR` | 400 | Field messages |
   | `UNAUTHENTICATED` | 401 | "Your session has expired. Please sign in again." |
   | `FORBIDDEN` | 403 | "You do not have access to this action." |
   | `REVEAL_EXPIRED` | 404 | "Details expired. Please search again." |
   | `RATE_LIMITED` | 429 | "Too many requests. Please wait a moment and try again." |
   | `UPSTREAM_TIMEOUT` | 504 | "The guest search service did not respond in time. Please try again." |
   | `UPSTREAM_UNAVAILABLE` | 502 | "Unable to complete the guest search. Please try again." |
   | `UPSTREAM_HTTP_ERROR` | 502 | "Unable to complete the guest search. Please try again." |
   | `UPSTREAM_FAULT` | 502 | "Unable to complete the guest search. Please try again." |
   | `UPSTREAM_TXN_FAILED` | 502 | "Unable to complete the guest search. Please try again." |
   | `UPSTREAM_CONTRACT` | 502 | "Unable to complete the guest search. Please try again." |
   | `UPSTREAM_MALFORMED` | 502 | "Unable to complete the guest search. Please try again." |
   | `INTERNAL_ERROR` | 500 | "Unable to complete the guest search. Please try again." |

2. THE BFF SHALL return errors in the form `{ requestId, success: false, error: { code, message, fields? } }`.
3. THE BFF SHALL NOT include internal URLs, credentials, tokens, SOAP headers, stack traces, raw SOAP faults, infrastructure names or downstream error text in any response.
4. IF an unexpected exception occurs, THEN THE BFF SHALL respond with `INTERNAL_ERROR` and SHALL log the exception with the Request_ID.

### Requirement 20: Authentication Placeholder and Authorization

**User Story:** As a developer, I want a pluggable authentication layer with a local placeholder, so that the app runs locally now and switches to IHG SSO later without code changes outside the provider.

#### Acceptance Criteria

1. THE BFF SHALL obtain the Principal for every API request through the Auth_Provider interface.
2. THE BFF SHALL select the Auth_Provider from configuration (`AUTH_MODE`), supporting `dev` now and reserving `oidc` for a later implementation.
3. WHERE `AUTH_MODE` is `dev`, THE Dev_Auth_Provider SHALL return a Principal whose id, display name and roles come from configuration.
4. IF `AUTH_MODE` is `dev` and `NODE_ENV` is `production`, THEN THE BFF SHALL refuse to start.
5. IF `AUTH_MODE` is `oidc` before an OIDC provider is implemented, THEN THE BFF SHALL refuse to start with a clear message.
6. IF the Auth_Provider returns no Principal, THEN THE BFF SHALL respond with HTTP 401 and error code `UNAUTHENTICATED`.
7. IF the Principal lacks the role `GuestSearch.Read`, THEN THE BFF SHALL respond to search requests with HTTP 403 and error code `FORBIDDEN`.
8. THE BFF SHALL expose `GET /api/v1/me`, returning the Principal's display name and roles.
9. THE Web_UI SHALL show the signed-in Colleague's display name and role in the header, and SHALL show a "DEV AUTH" badge WHILE `AUTH_MODE` is `dev`.
10. THE BFF SHALL issue a session cookie named `__Host-Http-gs_session` with the `Secure`, `HttpOnly` and `SameSite=Strict` attributes and no `Domain` attribute. WHERE the BFF runs on plain-HTTP localhost, a development cookie name without the `__Host-` prefix MAY be used.
11. THE BFF SHALL expose `POST /api/v1/session/logout`, which destroys the server-side session, discards its Reveal_Tokens and sends `Clear-Site-Data: "cache", "storage"`.

### Requirement 21: HTTP Security Controls

**User Story:** As a security engineer, I want standard web protections on the BFF, so that the app resists common browser-based attacks and scraping.

#### Acceptance Criteria

1. THE BFF SHALL set security headers through helmet:
   - a Content Security Policy with `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'` and `connect-src 'self'`
   - `Strict-Transport-Security` (production)
   - `Referrer-Policy: no-referrer`
   - `X-Content-Type-Options: nosniff`
2. THE BFF SHALL set `Cache-Control: no-store` on every `/api/` response.
3. THE BFF SHALL require the header `X-Requested-With: guest-search` on every state-changing API request, and SHALL respond with HTTP 403 when it is absent.
4. IF a state-changing request carries `Sec-Fetch-Site: cross-site`, THEN THE BFF SHALL reject it with HTTP 403.
5. THE BFF SHALL serve the Web_UI and the API from the same origin and SHALL NOT enable CORS.
6. THE BFF SHALL rate-limit search requests per session, defaulting to 30 per minute (configurable), and SHALL respond with HTTP 429 and `RATE_LIMITED` when the limit is exceeded.
7. THE Web_UI SHALL NOT store Search_Criteria, results, tokens or revealed values in `localStorage`, `sessionStorage`, IndexedDB, cookies or URLs.
8. THE Web_UI SHALL hold search results in memory with a cache lifetime of at most 5 minutes, and SHALL clear them on sign-out.
9. THE Web_UI SHALL NOT load third-party scripts, fonts from third-party origins, or analytics.

### Requirement 22: Logging, Audit and Observability

**User Story:** As an operator, I want structured, privacy-safe telemetry, so that I can troubleshoot and monitor the service without exposing guest data.

#### Acceptance Criteria

1. THE BFF SHALL write structured JSON logs. Each log entry SHALL contain the timestamp (UTC), level, Request_ID and, where available, trace ID and span ID.
2. WHEN a search completes, THE BFF SHALL log the operation name, the names of the criteria fields supplied (not their values), result count, downstream duration, downstream HTTP status, outcome category and error code.
3. THE BFF SHALL NOT log SOAP request or response payloads, SOAP header values, credentials, cookies, authorization headers, Reveal_Tokens or Prohibited_Data.
4. THE BFF SHALL configure log redaction for cookie and authorization headers and for name, email, phone, address, member ID, enterprise ID and token fields, as a secondary safeguard.
5. THE BFF SHALL write Audit_Log events for every search (Principal id, timestamp, Request_ID, criteria field names, result count) and every reveal (Requirement 14.10).
6. THE BFF SHALL emit OpenTelemetry traces with an inbound HTTP span and a child span for the SOAP call. Span attributes SHALL be limited to non-PII values.
7. THE BFF SHALL record metrics:
   - inbound request duration
   - SOAP call duration
   - result count distribution
   - error count by error code
   - circuit breaker state
8. THE BFF SHALL expose `GET /health/live`, which reports process health without checking dependencies.
9. THE BFF SHALL expose `GET /health/ready`, which reports configuration readiness and the cached SOAP reachability result, with a bounded check timeout.
10. THE BFF SHALL return the Request_ID in an `X-Request-ID` response header.
11. WHILE OpenTelemetry export is not configured, THE BFF SHALL run with telemetry exported to the console or disabled, without failing.

### Requirement 23: IHG Brand Visual Design

**User Story:** As a Colleague, I want the tool to look and feel like IHG's website, so that it is familiar and clearly an IHG product.

#### Acceptance Criteria

1. THE Web_UI SHALL define all colours, fonts, radii and shadows as Brand_Tokens in a single tokens stylesheet, exposed to Tailwind CSS through theme variables. Components SHALL NOT contain hard-coded colour values.
2. THE Brand_Tokens SHALL include:
   - primary orange #C7370F, with hover #940400
   - decorative orange #E8542C
   - navy #1F4456, navy tint #BFDBE8, navy wash #EEF3F6
   - text colours #000000, #333333, #555555 and #707372
   - borders #C2C7CA (decorative) and #666666 (controls)
   - surfaces #FFFFFF, #F6F6F6 and #F2F2F2 (row hover)
   - error #CE4635 and #FDF1EF
   - success #007A52
3. THE Web_UI SHALL use the Inter font family, self-hosted from the application origin, with the fallback stack "Helvetica Neue", Arial, sans-serif.
4. THE Web_UI SHALL use the decorative orange #E8542C only for non-text decoration and large display elements.
5. THE Web_UI SHALL render a two-tier header:
   - a 40px navy utility bar showing the environment badge, the Colleague's name and role, and Sign out
   - a 64px white brand bar showing the brand logo and the title "Guest Search"
6. THE Web_UI SHALL render the brand logo through a single component. The component SHALL load the official logo file from the application's brand assets path when present, and SHALL otherwise render a text wordmark placeholder.
7. THE Guest_Search_App SHALL NOT include logo files, fonts or images copied from ihg.com or third-party logo aggregators.
8. THE Web_UI SHALL style buttons as follows:
   - primary buttons: orange background, white sentence-case text, 48px height, 4px radius
   - secondary buttons: transparent background with a navy 1px border and navy text
9. THE Web_UI SHALL style inputs at 44–48px height with a #666666 1px border and 4px radius. Focus SHALL show a 2px navy outline with a 2px offset. Errors SHALL show a 2px #CE4635 border.
10. THE Web_UI SHALL style the results table with a sticky navy header row containing white text, row borders, and a row-hover background of #F2F2F2.
11. THE Web_UI SHALL style the search panel as a white card with a 10px radius and the panel shadow.

### Requirement 24: Accessibility

**User Story:** As a Colleague who relies on a keyboard, screen reader or magnification, I want the tool to be fully usable, so that I can do my job without barriers.

#### Acceptance Criteria

1. THE Web_UI SHALL target WCAG 2.2 Level AA conformance.
2. THE Web_UI SHALL associate a visible label with every form control, and SHALL set appropriate `autocomplete` attributes on name, email, telephone, postal code and country inputs.
3. THE Web_UI SHALL make every interactive element operable by keyboard, in a logical tab order, with a visible focus indicator.
4. THE Web_UI SHALL meet a contrast ratio of at least 4.5:1 for normal text and at least 3:1 for large text, user-interface component boundaries and focus indicators.
5. THE Web_UI SHALL NOT convey information by colour alone.
6. THE Web_UI SHALL size interactive targets at no less than 24×24 CSS pixels.
7. THE Web_UI SHALL prevent sticky headers from fully obscuring the focused element, using scroll padding equal to the sticky header heights.
8. WHEN rendered at a viewport width of 320 CSS pixels, THE Web_UI SHALL present all content except the results table without horizontal scrolling.
9. THE Web_UI SHALL announce status changes through the Status_Region, and errors through `role="alert"`, without both mechanisms announcing the same message.
10. THE Web_UI SHALL provide the keyboard shortcut "/" to move focus to the First Name input. The shortcut SHALL be active only WHILE focus is not in a text input.
11. THE Web_UI SHALL use the page title format "{state} – Guest Search – IHG", where {state} reflects the search state.
12. THE Guest_Search_App SHALL run automated axe-core accessibility scans with WCAG 2.2 AA rules against every UI state, and SHALL fail the build on any violation.

### Requirement 25: Automated Testing

**User Story:** As a developer, I want comprehensive automated tests, so that mapping, security and UI behaviour stay correct as the code evolves.

#### Acceptance Criteria

1. THE Guest_Search_App SHALL use Vitest for unit and integration tests, MSW for HTTP mocking, fast-check for property tests, and Playwright with @axe-core/playwright for end-to-end and accessibility tests.
2. THE Guest_Search_App SHALL include Request_Mapper tests covering:
   - each criterion alone (first name, last name, phone, email, state with country, Loyalty Member ID with Member Type)
   - combined multi-attribute search
   - omitted blank fields
   - XML escaping of `& < > " '` and non-BMP characters
   - namespace URIs
   - header values
   - `allAttributes`, `allHistory` and `maxResults`
3. THE Guest_Search_App SHALL include Response_Parser tests covering:
   - one guest and multiple guests
   - multiple phones, emails, addresses and memberships
   - `profileDefault` selection with no default, one default and multiple defaults
   - missing optional fields
   - zero guests
   - unsuccessful transaction status
   - SOAP Fault
   - malformed XML
   - a non-XML proxy error page
   - DOCTYPE and entity rejection
   - unexpected namespace prefixes and a default namespace
   - Prohibited_Data absent from the normalized output
4. THE Guest_Search_App SHALL include property tests for:
   - request round-trip (Requirement 9.15)
   - parser totality (11.11)
   - prefix invariance (11.12)
   - token exclusion (12.13)
   - pagination partition (17.12)
5. THE Guest_Search_App SHALL include pagination tests for 0, 1, 49, 50 and 51 results, first-page and last-page control states, and reset after a new search.
6. THE Guest_Search_App SHALL include a log-leak test. It SHALL process a fixture containing synthetic PII and a synthetic card token through a full search, and assert that no captured log line contains those values.
7. WHERE XSD files exist in `schemas/`, THE Guest_Search_App SHALL validate every generated request envelope against them with xmllint-wasm in the test suite.
8. THE Guest_Search_App SHALL include BFF integration tests covering the success, zero-result and every error-code path, and the security headers, CSRF header, content type, body size and rate limit.
9. THE Guest_Search_App SHALL include Playwright end-to-end tests against the BFF and the SOAP_Stub, covering:
   - search with results
   - zero results
   - validation error
   - upstream error with Try again
   - pagination across 51 or more results
   - details drawer
   - reveal
   - keyboard-only operation
10. THE Guest_Search_App SHALL enforce test coverage thresholds:
    - lines 85% and branches 80% overall
    - lines 95% and branches 90% for each file under the BFF SOAP module
11. THE Guest_Search_App SHALL store SOAP fixtures as files containing synthetic data only, and SHALL NOT commit real guest data, credentials, tokens or production identifiers.

### Requirement 26: Continuous Integration and Supply Chain

**User Story:** As a team lead, I want every change automatically verified, so that broken, insecure or inaccessible code does not merge.

#### Acceptance Criteria

1. THE Guest_Search_App SHALL provide a CI workflow that runs install from lockfile, type-check, lint, format-check, unit, property and integration tests with coverage, the build, and end-to-end tests with accessibility scans.
2. THE CI workflow SHALL run a dependency vulnerability audit and fail on high or critical findings.
3. THE CI workflow SHALL run a secret scan and fail when a secret is detected.
4. THE CI workflow SHALL verify that `@xmldom/xmldom` resolves to version 0.9.12 or later, and that `libxmljs2` is absent from the dependency tree.
5. THE Guest_Search_App SHALL configure linting rules that forbid `console` logging in the BFF and string-built XML in SOAP modules.

### Requirement 27: Documentation

**User Story:** As a new team member, I want clear documentation, so that I can run, understand and extend the system.

#### Acceptance Criteria

1. THE Guest_Search_App SHALL include a root README containing:
   - purpose
   - an architecture diagram
   - prerequisites, setup and run commands
   - the test commands
   - configuration reference
   - the list of blocked items awaiting WSDL/XSD
2. THE Guest_Search_App SHALL include a mapping document in `docs/` listing every UI-to-SOAP and SOAP-to-domain mapping, with its verification status (confirmed, provisional or blocked).
3. THE Guest_Search_App SHALL include architecture decision records in `docs/adr/` for the Node BFF, the hand-built SOAP envelope, the authentication placeholder, PII masking, and client-side pagination.
4. THE Guest_Search_App SHALL include an open-questions document listing unresolved schema, business-rule and brand questions.

### Requirement 28: Non-Goals

**User Story:** As a product owner, I want the MVP's boundaries explicit, so that effort stays on the core search experience.

#### Acceptance Criteria

1. THE Guest_Search_App SHALL NOT create, update, merge or delete guest profiles.
2. THE Guest_Search_App SHALL NOT implement SOAP server-side pagination.
3. THE Guest_Search_App SHALL NOT process, display or store payment card data or tokens.
4. THE Guest_Search_App SHALL NOT be accessible to guests or the public.
5. THE Guest_Search_App SHALL NOT implement OIDC authentication in this release, beyond the reserved interface.
6. THE Guest_Search_App SHALL NOT include production deployment infrastructure in this release.
7. THE Guest_Search_App SHALL NOT include duplicate detection, saved searches, data export, natural-language search or deep links to other systems in this release.
