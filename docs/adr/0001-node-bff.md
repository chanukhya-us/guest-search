# ADR 0001: React SPA + Node BFF over the SOAP service

## Status

Accepted.

## Context

The feature is an internal colleague tool that searches IHG guest profiles over a legacy
SOAP service (`searchGuestRequest`). Several forces shape the architecture:

- The upstream is **SOAP/XML**, but the UI is a modern data-entry and results experience that
  is far easier to build in a component framework against JSON.
- The work handles **guest PII**. Validation, PII masking, role checks, rate limiting, audit
  logging and session handling must happen somewhere the browser cannot bypass.
- The SOAP contract is **not yet confirmed** (no WSDL/XSD). We need the SOAP-specific code
  isolated so that correcting it later is a contained change, not a cross-cutting rewrite.
- Letting the browser talk to SOAP directly would expose service credentials and the envelope
  shape to the client, and would force XML handling, namespace logic and XXE defenses into the
  browser — the wrong place for any of it.

## Decision

Build a **React 19 + Vite single-page app** that talks **only** to a **same-origin Fastify 5
backend-for-frontend (BFF)** over JSON. The BFF owns the SOAP integration behind a
ports-and-adapters boundary:

- `apps/web` — the SPA. It never sees XML, namespaces or credentials.
- `apps/bff` — Fastify BFF. It validates criteria, builds the SOAP envelope, calls the
  upstream through a `GuestSearchGateway` **port**, masks PII, and returns normalized JSON. In
  production it also serves the built SPA, so the UI and API share one origin.
- `packages/shared` — the Zod criteria schema, domain types, error catalog, roles and
  `pickPrimary`, imported by both apps so validation and types never drift.
- The only adapter that knows SOAP is `SoapGuestSearchGateway`; the service depends on the
  port, not the adapter.

Node + TypeScript was chosen (over, say, a Java BFF) so the schema, domain types and
validation rules are written **once** in `packages/shared` and shared by both tiers.

## Consequences

Easier:

- The SPA is simple: same-origin JSON, no CORS, no XML, no credentials in the browser.
- All security and privacy controls live server-side where they cannot be bypassed.
- The SOAP boundary is swappable. When the contract is confirmed, the fix is a single-layer
  change behind the port; a future REST or cloud upstream is a new adapter, not a rewrite.
- One language and one shared package keep validation and domain types consistent across tiers.

Harder / accepted:

- We run and operate a Node process, not just a static site — a BFF to deploy, configure and
  observe.
- The same-origin requirement means production must serve the SPA from the BFF (or a
  co-located reverse proxy); it is not a pure static CDN deployment.
- The BFF pins **undici 7.x** for its SOAP transport, which sets a recent Node floor
  (`engines.node >= 22.15`). This is recorded as an open item in
  [../open-questions.md](../open-questions.md).

## Related

- [0002](0002-hand-built-soap-envelope.md) — how the SOAP envelope behind the port is built.
- [0003](0003-auth-placeholder.md) — the auth/session model the BFF carries for the MVP.
