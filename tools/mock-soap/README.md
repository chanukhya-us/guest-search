# Local mock SOAP server (zero Docker)

Dev tooling that stands in for the real IHG SOAP `searchGuestRequest` service so the whole app
runs end to end on `npm run dev:all` with **no Docker**. This is the DEFAULT local backend; the
container-based [WireMock stub](../wiremock/README.md) is a documented alternative.

It is a plain `node:http` server with **zero runtime dependencies**, written in erasable
TypeScript so it runs under `node --experimental-strip-types` (Node 22.15+).

## Run it

```bash
# just the mock (listens on http://127.0.0.1:8080/InitiateService)
npm run mock:soap

# the whole stack (mock + BFF + web), one command
npm run dev:all
```

Environment (all optional):

| Variable              | Default            | Meaning                            |
| --------------------- | ------------------ | ---------------------------------- |
| `MOCK_SOAP_PORT`      | `8080`             | Listen port                        |
| `MOCK_SOAP_HOST`      | `127.0.0.1`        | Listen host                        |
| `MOCK_SOAP_PATH`      | `/InitiateService` | POST path for `searchGuestRequest` |
| `MOCK_SOAP_MAX_BYTES` | `1048576`          | Request body cap (413 above it)    |

`GET /health` returns `200 ok`.

## How it works (handler factoring)

Everything except the socket lives in [`handler.ts`](./handler.ts) as pure, unit-testable
functions:

```
parseCriteria(requestXml)  -> Criteria        read searchGuestRequest criteria (tolerant)
filterSeed(criteria)       -> SeedGuest[]      narrow, score-sort desc, cap at maxResults
buildResponseXml(guests)   -> string          a searchGuestResponse the BFF parser accepts
buildFaultXml()            -> string          a SOAP 1.1 Fault
handleRequest(requestXml)  -> MockResult       orchestrates the above + the magic inputs
```

[`server.ts`](./server.ts) only adds the HTTP shell (`createMockListener`, `startMockServer`)
and the CLI entry. Because the core is a pure function of the request string, the test
([`handler.test.ts`](./handler.test.ts)) exercises it with no server, and also boots the real
HTTP server on an ephemeral port for one round trip.

### Response contract

`buildResponseXml` emits the **exact** namespace structure the committed fixtures use
(`apps/bff/test/fixtures/soap/response-single.xml`): `soap:Envelope > Body >
ns4:searchGuestResponse` with an in-body `header`, a `common` `transactionStatus`
(`overallStatusCode="0000"`, `transactionSuccessful="true"`), and one `ns2:initiateGuest` per
guest. Values are XML-escaped, never hand-concatenated raw, so synthetic data containing
`& < > " '` stays well-formed. So the BFF's `parseSearchGuestResponse` accepts the output
unchanged.

## Seed data

[`seed.ts`](./seed.ts) holds **60** synthetic guests, generated deterministically (no clock, no
randomness). Every value follows the project's fixture conventions — enterprise IDs `9000000xx`,
phones `+1 404 555 01xx`, emails `@example.test` — spread across a few cities/regions/countries
and membership programmes so filters return realistic groups. Scores descend 99.5 → 70.0 so
sort order is unambiguous.

Filtering (`filterSeed`) supports the request criteria:

- `firstName` / `lastName` — case-insensitive substring
- `email` — case-insensitive substring
- `phone` — substring after stripping spaces/hyphens
- `loyaltyMemberId` — exact match after stripping spaces/hyphens
- `memberType`, `stateOrRegion`, `country` — exact (case-insensitive)

Results are capped at the request's `maxResults` (and never exceed the seed size).

## Magic demo inputs

Selected by the **surname** (case-insensitive, whole value), so the happy path stays simple:

| `lastName`       | Result                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| `nomatch`        | 0 guests, but a successful response (empty result)                      |
| `fault`          | a SOAP Fault (HTTP 500) → `UPSTREAM_FAULT` in the BFF                   |
| `boom` or `many` | all 60 seed guests (ignores other criteria; drives the pagination demo) |

Any other surname runs an ordinary filtered search.

## Not for production

This tool is excluded from the production build and from coverage. It never contains real guest
data, credentials or tokens.
