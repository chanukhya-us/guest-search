# WireMock SOAP stub (optional, Docker)

This is the **optional** container-based alternative to the default
[Node mock SOAP server](../mock-soap/README.md). The local MVP defaults to the zero-Docker Node
mock (`npm run dev:all`); reach for WireMock only when you want a container stub that serves the
**exact committed fixture bytes** over real HTTP (useful for contract-style checks, or to mirror
the testcontainers setup from task 13.2).

## Run it

Requires Docker.

```bash
npm run stub:up      # docker compose -f tools/wiremock/docker-compose.dev.yml up -d
npm run stub:down
```

Then point the BFF at it (same endpoint the Node mock uses):

```bash
SOAP_ENDPOINT=http://localhost:8080/InitiateService
```

## What it serves

`docker-compose.dev.yml` runs `wiremock/wiremock:3.13.2` and mounts:

- `./mappings` → `/home/wiremock/mappings` (scenario selection)
- `../../apps/bff/test/fixtures/soap` → `/home/wiremock/__files` (the response bodies)

Scenarios are chosen by an XPath match on the request `surname` (namespace
`http://common.crm.ihg.com/schema/v1_0/complex`), matching design.md:

| Surname       | Scenario                   | Fixture                       |
| ------------- | -------------------------- | ----------------------------- |
| `Single`      | one guest                  | `response-single.xml`         |
| `Many`        | 60 guests                  | `response-60-guests.xml`      |
| `Nobody`      | empty result               | `response-empty.xml`          |
| `Fault`       | SOAP Fault (500)           | `fault-server.xml`            |
| `Broken`      | failed transaction status  | `response-failure-status.xml` |
| `Garbage`     | malformed XML              | `malformed-truncated.xml`     |
| `Slow`        | 15 s delay (→ BFF timeout) | `response-single.xml`         |
| `Proxy`       | HTTP 502 HTML page         | `malformed-proxy-502.html`    |
| _(any other)_ | multiple guests (default)  | `response-multiple.xml`       |

Because WireMock serves the committed fixtures byte-for-byte, it cannot synthesize arbitrary
filtered searches the way the Node mock does — it returns the fixture mapped to the surname. For
dynamic, criteria-driven responses on the happy path, prefer the Node mock.
