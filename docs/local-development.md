# Local development

Run the whole app end to end on your machine with **no Docker**. A zero-dependency Node mock
stands in for the SOAP service and serves ~60 synthetic guests, so search, pagination, the
details drawer and PII reveal all work against realistic data.

## One command

```bash
npm install          # first time only
npm run dev:all
```

`dev:all` ([scripts/dev-all.mjs](../scripts/dev-all.mjs)) builds `packages/shared` and `apps/bff`
once, then starts three processes with prefixed output:

| Prefix | Process                                                                 | URL                                   |
| ------ | ----------------------------------------------------------------------- | ------------------------------------- |
| `mock` | Node mock SOAP server ([tools/mock-soap](../tools/mock-soap/README.md)) | http://127.0.0.1:8080/InitiateService |
| `bff`  | Fastify BFF (`apps/bff/dist/index.js`)                                  | http://localhost:3000                 |
| `web`  | Vite dev server (proxies `/api` + `/health` → BFF)                      | http://localhost:5173                 |

Open **http://localhost:5173** and search. Ctrl-C stops all three.

The BFF is started with `SOAP_ENDPOINT` pointing at the mock, `AUTH_MODE=dev`,
`DEV_AUTH_PERSONA=jane.doe` (which has the Reveal role), a local-only `SESSION_SECRET` ≥ 32
chars, and `SOAP_MAX_RESULTS=60`.

## Configuration (.env.local)

`dev:all` has baked-in dev fallbacks so it runs with no setup, but a git-ignored
[`.env.local`](../.env.local) overrides them (and your real `process.env` overrides that). Keys
match `apps/bff/src/config.ts` / [`.env.example`](../.env.example). Never put a real secret or a
personal user ID in it — `.env.local` is ignored by git (`.env.*` in `.gitignore`), but treat it
as local-only anyway.

## Running pieces individually

```bash
npm run mock:soap                               # just the mock SOAP server
npm run build:backend && node apps/bff/dist/index.js   # just the BFF (needs env)
npm run dev --workspace=@ihg-guest-search/web   # just the Vite dev server
```

## Trying the magic demo inputs

The mock recognizes a few **surnames** so you can exercise every UI state without special data
(case-insensitive):

| Search last name | What you see                                             |
| ---------------- | -------------------------------------------------------- |
| `nomatch`        | the empty-results state (successful, zero guests)        |
| `fault`          | the upstream-error state with "Try again" (a SOAP Fault) |
| `boom` or `many` | all 60 guests — drives pagination (page 2)               |
| anything else    | an ordinary filtered search over the seed                |

Ordinary searches filter the seed by last/first name and email (substring), phone (digits),
loyalty member ID (exact), member type, state/region and country.

## WireMock (optional, Docker)

The default local backend is the Node mock above. If you specifically want a container that
serves the committed fixture bytes over real HTTP, there is an optional WireMock stub:

```bash
npm run stub:up      # requires Docker
# point the BFF at it: SOAP_ENDPOINT=http://localhost:8080/InitiateService
npm run stub:down
```

See [tools/wiremock/README.md](../tools/wiremock/README.md). Because WireMock serves fixed
fixtures mapped by surname, prefer the Node mock for dynamic, criteria-driven searches.
