# docs/

Project documentation for IHG Guest Search. Start at the repository
[README](../README.md) for setup and commands; this folder holds the deeper reference
material.

| Document                                             | What it covers                                                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [mapping.md](mapping.md)                             | The field mapping: UI criteria → SOAP request, SOAP response → domain, and domain → API (primaries, masking, reveal), each marked Confirmed / Provisional / Blocked (B1–B3). |
| [adr/](adr/)                                         | Architecture Decision Records — why the main structural decisions were made.                                                                                                 |
| [security/threat-model.md](security/threat-model.md) | STRIDE threat model: assets, trust boundaries, implemented mitigations, and residual risks.                                                                                  |
| [a11y-manual-checklist.md](a11y-manual-checklist.md) | The human WCAG 2.2 AA checklist for assistive-technology testing the automated axe gate cannot cover.                                                                        |
| [open-questions.md](open-questions.md)               | Consolidated blockers (B1–B8), open contract questions, and redaction recommendations.                                                                                       |
| [local-development.md](local-development.md)         | Full local setup, dev personas, and the optional WireMock stack.                                                                                                             |
| [Request.txt](Request.txt)                           | The team's single sample SOAP request — the current source of truth for the request shape (pending redaction, see open-questions.md).                                        |

The `requirements.md`, `design.md` and `tasks.md` copies in this folder mirror the spec under
`.kiro/specs/ihg-guest-search/`.

Do not put real guest data, credentials or production endpoints in these documents.
