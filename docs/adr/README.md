# Architecture Decision Records

Each ADR captures one significant decision: the context that forced it, the decision taken,
and the consequences we accept. They record **why**, not just what. Format: Status, Context,
Decision, Consequences.

| ADR                                      | Title                                                | Status   |
| ---------------------------------------- | ---------------------------------------------------- | -------- |
| [0001](0001-node-bff.md)                 | React SPA + Node BFF over the SOAP service           | Accepted |
| [0002](0002-hand-built-soap-envelope.md) | Hand-built SOAP envelope from a provisional contract | Accepted |
| [0003](0003-auth-placeholder.md)         | Placeholder dev auth and in-memory sessions          | Accepted |
| [0004](0004-pii-masking.md)              | PII masking with a session-bound reveal store        | Accepted |
| [0005](0005-client-side-pagination.md)   | Client-side pagination of a bounded result set       | Accepted |

These decisions are scoped to the local-development MVP. Several will be revisited when the
WSDL/XSD arrive and when the app is taken beyond local use — see
[../open-questions.md](../open-questions.md).
